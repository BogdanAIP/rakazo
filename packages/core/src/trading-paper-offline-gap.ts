import type { TradingCandle } from "@rakazo/contracts";
import { paperPerpetualAmount as exact } from "./trading-paper-perpetual-ledger.js";

/** Read-only historical evidence. It can NEVER authorize a fill or unlock a session. */
export type PaperOfflineGapReview = Readonly<{
  status:
    | "history_incomplete"
    | "no_threshold_observed"
    | "stop_possible"
    | "target_possible"
    | "both_possible"
    | "window_ambiguous";
  barsReviewed: number;
  fundingReviewRequired: true;
  executionVerified: false;
  newEntriesAuthorized: false;
}>;

export function reviewPaperOfflineH1(input: {
  offlineAt: string;
  onlineAt: string;
  instrument: string;
  side: "long" | "short";
  stopPriceQuote: string;
  takeProfitPriceQuote: string;
  candles: readonly TradingCandle[];
}): PaperOfflineGapReview {
  const report = (status: PaperOfflineGapReview["status"], barsReviewed: number) => ({
    status,
    barsReviewed,
    fundingReviewRequired: true as const,
    executionVerified: false as const,
    newEntriesAuthorized: false as const,
  });
  const start = Date.parse(input.offlineAt);
  const end = Date.parse(input.onlineAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new Error("Invalid PAPER offline interval");
  const stop = exact(input.stopPriceQuote);
  const target = exact(input.takeProfitPriceQuote);
  if (input.side === "long" ? stop >= target : stop <= target)
    throw new Error("Invalid stop/target geometry");

  // Closed H1 bars must cover the ENTIRE offline window with no holes.
  // Partial window overlaps are intentionally classed as ambiguous.
  const hour = 3_600_000;
  const bars = input.candles
    .filter((c) => Date.parse(c.openedAt) < end && Date.parse(c.openedAt) + c.durationMs > start)
    .slice()
    .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  if (bars.length === 0) return report("history_incomplete", 0);
  let cursor = start;
  let previousEnd = -Infinity;
  let first: "stop" | "target" | "ambiguous" | null = null;
  let partialHit = false;
  for (const bar of bars) {
    const at = Date.parse(bar.openedAt);
    if (
      !Number.isFinite(at) ||
      bar.durationMs !== hour ||
      at % hour !== 0 ||
      !bar.confirmed ||
      bar.symbol !== input.instrument ||
      bar.venue !== "okx" ||
      bar.kind !== "perpetual" ||
      at > cursor ||
      at < previousEnd
    )
      return report("history_incomplete", bars.length);
    const hi = exact(bar.high);
    const lo = exact(bar.low);
    if (hi < lo) throw new Error("Invalid PAPER historical bar range");
    const stopHit = input.side === "short" ? hi >= stop : lo <= stop;
    const targetHit = input.side === "short" ? lo <= target : hi >= target;
    if ((stopHit || targetHit) && (at < start || at + hour > end)) partialHit = true;
    if (!first && (stopHit || targetHit)) {
      first = stopHit && targetHit ? "ambiguous" : stopHit ? "stop" : "target";
    }
    cursor = Math.max(cursor, at + hour);
    previousEnd = at + hour;
  }
  if (cursor < end) return report("history_incomplete", bars.length);
  if (!first) return report("no_threshold_observed", bars.length);
  if (partialHit) return report("window_ambiguous", bars.length);
  return report(
    first === "ambiguous"
      ? "both_possible"
      : first === "stop"
        ? "stop_possible"
        : "target_possible",
    bars.length,
  );
}
