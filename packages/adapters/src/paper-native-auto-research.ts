import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaperPerpetualDecision, PaperPerpetualSnapshot } from "@rakazo/contracts";
import { PaperPerpetualDecisionSchema } from "@rakazo/contracts";

const execFileAsync = promisify(execFile);
type Profile = "conservative" | "moderate" | "aggressive";
type Frame = {
  at: string;
  close: number;
  ema20: number;
  ema50: number;
  atr14: number;
  rsi14: number;
  volRatio: number;
  breakoutUp: boolean;
  breakoutDown: boolean;
  reclaimLong: boolean;
  reclaimShort: boolean;
  compressed: boolean;
  retestLong?: boolean;
  retestShort?: boolean;
  priorHigh: number;
  priorLow: number;
};
type Row = {
  symbol: string;
  error?: string;
  book?: { observedAt: string; bid: number; ask: number; spreadBps: number };
  m15?: Frame | null;
  h1?: Frame | null;
  h4?: Frame | null;
};
type Report = {
  checkedAt: string;
  universeCount: number;
  passing: number;
  profile: Profile;
  candidates: Row[];
};
type Pick = { row: Row; side: "long" | "short"; thesis: string };
const NATIVE_MAX_POSITIONS: Record<Profile, number> = {
  conservative: 2,
  moderate: 3,
  aggressive: 4,
};
/** Native Risk Core additionally validates portfolio stop risk, margin and stress. */
export function nativePaperPositionGate(
  profile: Profile,
  count: number,
  held: readonly string[],
  candidate?: string,
): string | null {
  if (!Number.isSafeInteger(count) || count < 0 || held.length !== count)
    return "Native PAPER: incomplete held exposure";
  if (count >= NATIVE_MAX_POSITIONS[profile])
    return "Native PAPER: concurrent position limit reached";
  if (candidate && held.includes(candidate)) return "Native PAPER: candidate already held";
  return null;
}
const dataDir = () =>
  join(process.env.USERPROFILE ?? "", "RakazoRuntime", "trading-live-data-20261011");
let inFlight: Promise<void> | null = null;
let scanFinished = 0;
const FRESH_MS = 60_000;
function fresh(at: string | undefined, now: number, maxMs: number): boolean {
  const ms = Date.parse(at ?? "");
  return Number.isFinite(ms) && ms <= now + 2_000 && now - ms <= maxMs;
}
function frameFresh(frame: Frame | null | undefined, minutes: number, now: number): boolean {
  if (
    !frame ||
    !Number.isFinite(frame.close) ||
    frame.close <= 0 ||
    !Number.isFinite(frame.atr14) ||
    frame.atr14 <= 0
  )
    return false;
  const end = Date.parse(frame.at) + minutes * 60_000;
  return Number.isFinite(end) && end <= now + 2_000 && now - end <= minutes * 60_000 + 90_000;
}
function meaningfulRow(row: Row, now: number): boolean {
  return Boolean(
    row.book &&
      row.m15 &&
      row.h1 &&
      row.h4 &&
      fresh(row.book.observedAt, now, FRESH_MS) &&
      frameFresh(row.m15, 15, now) &&
      frameFresh(row.h1, 60, now) &&
      frameFresh(row.h4, 240, now) &&
      row.book.bid > 0 &&
      row.book.ask >= row.book.bid &&
      row.book.spreadBps >= 0 &&
      row.book.spreadBps <= 20,
  );
}
export function nativePaperSignal(profile: Profile, row: Row, now: number): Pick | null {
  if (!meaningfulRow(row, now)) return null;
  const { m15, h1, h4, book } = row;
  if (!m15 || !h1 || !h4 || !book) return null;
  const trendUp =
    h4.close > h4.ema20 && h4.ema20 > h4.ema50 && h1.close > h1.ema20 && h1.ema20 > h1.ema50;
  const trendDown =
    h4.close < h4.ema20 && h4.ema20 < h4.ema50 && h1.close < h1.ema20 && h1.ema20 < h1.ema50;
  if (profile === "conservative") {
    if (book.spreadBps > 8 || m15.volRatio < 0.8 || h1.rsi14 < 32 || h1.rsi14 > 70) return null;
    if (trendUp && m15.reclaimLong && m15.rsi14 >= 43 && m15.rsi14 <= 67)
      return { row, side: "long", thesis: "H4/H1 uptrend, confirmed M15 EMA pullback/reclaim" };
    if (trendDown && m15.reclaimShort && m15.rsi14 >= 33 && m15.rsi14 <= 58)
      return { row, side: "short", thesis: "H4/H1 downtrend, confirmed M15 EMA rejection" };
  } else if (profile === "moderate") {
    if (book.spreadBps > 15) return null;
    if (trendUp && m15.retestLong && m15.volRatio >= 0.8)
      return {
        row,
        side: "long",
        thesis: "Prior M15 range breakout with next closed-candle retest and H4/H1 uptrend",
      };
    if (trendDown && m15.retestShort && m15.volRatio >= 0.8)
      return {
        row,
        side: "short",
        thesis: "Prior M15 range breakdown with next closed-candle retest and H4/H1 downtrend",
      };
    if (h1.rsi14 < 31 && h4.rsi14 >= 30 && m15.reclaimLong && m15.volRatio >= 0.8)
      return { row, side: "long", thesis: "H1 oversold rebound with M15 reclaim" };
    if (h1.rsi14 > 69 && h4.rsi14 <= 70 && m15.reclaimShort && m15.volRatio >= 0.8)
      return { row, side: "short", thesis: "H1 overbought reversal with M15 rejection" };
  } else {
    if (book.spreadBps > 20 || m15.volRatio < 1.6) return null;
    if (
      (h1.compressed || h1.breakoutUp) &&
      m15.breakoutUp &&
      h4.close >= h4.ema20 &&
      m15.close - m15.ema20 < 3 * m15.atr14
    )
      return {
        row,
        side: "long",
        thesis: "H1 compression-expansion plus M15 volume-backed upside break",
      };
    if (
      (h1.compressed || h1.breakoutDown) &&
      m15.breakoutDown &&
      h4.close <= h4.ema20 &&
      m15.ema20 - m15.close < 3 * m15.atr14
    )
      return {
        row,
        side: "short",
        thesis: "H1 compression-expansion plus M15 volume-backed downside break",
      };
  }
  return null;
}
async function ensureFreshScan(): Promise<void> {
  if (scanFinished && Date.now() - scanFinished < 50_000) return;
  if (!inFlight) {
    const task = (async () => {
      const script = join(dataDir(), "paper-hourly-market-scan.cjs");
      await execFileAsync(process.execPath, [script], {
        windowsHide: true,
        timeout: 115_000,
        maxBuffer: 512_000,
      });
      scanFinished = Date.now();
    })();
    inFlight = task;
    void task
      .finally(() => {
        if (inFlight === task) inFlight = null;
      })
      .catch(() => {});
  }
  await inFlight;
}
async function reportFor(profile: Profile): Promise<Report> {
  await ensureFreshScan();
  const file = join(dataDir(), "paper-profile-" + profile + "-latest.json");
  const report = JSON.parse(await readFile(file, "utf8")) as Report;
  if (
    report.profile !== profile ||
    report.universeCount !== 55 ||
    !Array.isArray(report.candidates) ||
    report.candidates.length > 8 ||
    !fresh(report.checkedAt, Date.now(), 60_000) ||
    !Number.isFinite(report.passing) ||
    report.passing < 1
  )
    throw new Error("Native public market scan incomplete or stale");
  return report;
}
function buildComparison(profile: Profile, rows: Row[], selected: Pick | null, now: number) {
  const chosen = selected?.row.symbol ?? null;
  const ranked = [
    ...(selected ? [selected.row] : []),
    ...rows.filter((row) => row.symbol !== chosen),
  ].slice(0, 8);
  return {
    asOf: new Date(now).toISOString(),
    validUntil: new Date(now + 10 * 60_000).toISOString(),
    method:
      "Native rule-based 55-USDT OKX public scan M15/H1/H4; fresh closed candles and book, 5x CROSS, PAPER risk-v3",
    profileRationale:
      profile +
      ": independent confirmed signals; native risk, margin, fee/funding and stress gates",
    candidates: ranked.map((row) => ({
      instrument: row.symbol,
      verdict: (row.symbol === chosen ? "selected" : "rejected") as "selected" | "rejected",
      reason:
        row.symbol === chosen
          ? selected!.thesis
          : row.error
            ? "Missing validated public data: " + row.error.slice(0, 140)
            : "No independent confirmed strategy-specific signal or stale depth/candle",
      facts:
        row.book && row.m15 && row.h1 && row.h4
          ? [
              { name: "spreadBps", value: String(row.book.spreadBps) },
              { name: "M15_RSI14", value: String(row.m15.rsi14) },
              { name: "M15_volRatio", value: String(row.m15.volRatio) },
              { name: "H1_RSI14", value: String(row.h1.rsi14) },
            ]
          : [],
    })),
  };
}
const noTrade = (
  reason: string,
  comparison?: ReturnType<typeof buildComparison>,
): PaperPerpetualDecision =>
  PaperPerpetualDecisionSchema.parse({
    kind: "no_trade",
    reason,
    ...(comparison ? { comparison } : {}),
  });
function decimal(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n >= 1e12)
    throw new Error("Invalid native PAPER price or quantity");
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
function nativeProposal(
  profile: Profile,
  selected: Pick,
  snapshot: PaperPerpetualSnapshot,
  freeQuote: number,
  equity: number,
  comparison: ReturnType<typeof buildComparison>,
): PaperPerpetualDecision | null {
  const { row, side, thesis } = selected;
  const price = Number(side === "long" ? snapshot.book.askQuote : snapshot.book.bidQuote);
  const step = Number(snapshot.rules.lotIncrementBase);
  const minBase = Number(snapshot.rules.minimumBase);
  const tick = Number(snapshot.market.priceIncrement);
  const atr = row.h1?.atr14 ?? 0,
    m15 = row.m15;
  if (
    !m15 ||
    !row.book ||
    snapshot.market.status !== "active" ||
    snapshot.market.symbol !== row.symbol ||
    !Number.isFinite(price) ||
    !Number.isFinite(step) ||
    step <= 0 ||
    !Number.isFinite(tick) ||
    tick <= 0 ||
    snapshot.rules.maxLeverage < 5 ||
    snapshot.leverageLimits?.marginMode !== "cross" ||
    !fresh(snapshot.book.observedAt, Date.now(), FRESH_MS) ||
    !fresh(snapshot.markObservedAt, Date.now(), FRESH_MS)
  )
    return null;
  const latestFunding = Number(snapshot.funding.at(-1)?.rateSigned ?? "0");
  if (!Number.isFinite(latestFunding) || Math.abs(latestFunding) > 0.003) return null;
  const desired = (0.0305 * freeQuote * 5) / price;
  const qty = Math.max(minBase, Math.ceil(desired / step - 1e-9) * step);
  const distance = Math.max(atr * 0.9, m15.atr14 * 1.1);
  const structural =
    side === "long"
      ? Math.min(price - distance, m15.priorLow - 0.2 * m15.atr14)
      : Math.max(price + distance, m15.priorHigh + 0.2 * m15.atr14);
  const stop =
    (side === "long" ? Math.floor(structural / tick) : Math.ceil(structural / tick)) * tick;
  const stopDistance = Math.abs(price - stop);
  const take =
    (side === "long"
      ? Math.ceil((price + 2.2 * stopDistance) / tick)
      : Math.floor((price - 2.2 * stopDistance) / tick)) * tick;
  const notional = qty * price;
  // Conservative estimate for entry/exit taker costs plus two-sided slippage.
  const expectedRisk = qty * stopDistance + 0.003 * notional;
  const maxIdea = equity * { conservative: 0.005, moderate: 0.01, aggressive: 0.02 }[profile];
  if (
    stop <= 0 ||
    take <= 0 ||
    !Number.isFinite(notional) ||
    !Number.isFinite(expectedRisk) ||
    notional / 5 < 0.03 * freeQuote ||
    notional / 5 > 0.7 * freeQuote ||
    expectedRisk > 0.9 * maxIdea ||
    equity - 0.5 * notional < 0.25 * equity
  )
    return null;
  if (
    profile === "conservative" &&
    (side === "long"
      ? m15.priorHigh - price < 1.5 * stopDistance
      : price - m15.priorLow < 1.5 * stopDistance)
  )
    return null;
  return PaperPerpetualDecisionSchema.parse({
    kind: "proposal",
    instrument: row.symbol,
    side,
    leverage: 5,
    quantityBase: decimal(qty),
    orderType: "market",
    limitPriceQuote: null,
    stopPriceQuote: decimal(stop),
    takeProfitPriceQuote: decimal(take),
    plannedRecoveryNotionalQuote: "0",
    comparison,
    rationale:
      thesis + "; verified public book, 55-approved universe, fees/funding and 50% stress checked.",
  });
}
/** Continue through independent candidates when an earlier market is rejected. */
export async function firstAcceptedNativeCandidate<T, R>(
  candidates: readonly T[],
  evaluate: (candidate: T) => Promise<R | null>,
): Promise<R | null> {
  for (const candidate of candidates) {
    try {
      const result = await evaluate(candidate);
      if (result !== null) return result;
    } catch {
      // A per-market failure must not cancel later candidates.
    }
  }
  return null;
}
export async function generateNativePaperDecision(input: {
  profile: Profile;
  approved: string[];
  availableQuote: string;
  equityQuote: string;
  openPositionCount: number;
  heldInstruments: string[];
  proposalsLast24h: number;
  fetchSnapshot: (symbol: string) => Promise<PaperPerpetualSnapshot>;
}): Promise<{ decision: PaperPerpetualDecision; snapshots: PaperPerpetualSnapshot[] }> {
  const empty = (reason: string) => ({ decision: noTrade(reason), snapshots: [] });
  if (input.approved.length !== 55 || new Set(input.approved).size !== 55)
    return empty("Native PAPER: incomplete owner-approved 55 market scope");
  const exposureGate = nativePaperPositionGate(
    input.profile,
    input.openPositionCount,
    input.heldInstruments,
  );
  if (exposureGate) return empty(exposureGate);
  let report: Report;
  try {
    report = await reportFor(input.profile);
  } catch (error) {
    return empty("Native PAPER market unavailable: " + String(error).slice(0, 250));
  }
  const now = Date.now();
  const allowed = new Set(input.approved);
  const rows = report.candidates
    .filter((row) => allowed.has(row.symbol) && !input.heldInstruments.includes(row.symbol))
    .slice(0, 8);
  const eligible = rows.filter((row) => meaningfulRow(row, now));
  const signals = eligible
    .map((row) => nativePaperSignal(input.profile, row, now))
    .filter((p): p is Pick => p !== null);
  const selected = signals[0] ?? null;
  const none = buildComparison(input.profile, rows, null, now);
  if (input.proposalsLast24h >= 2)
    return {
      decision: noTrade("Native PAPER: 2/24h opening proposal limit reached", none),
      snapshots: [],
    };
  if (eligible.length < 2 || !selected)
    return {
      decision: noTrade(
        "Native PAPER: no two valid markets or no confirmed strategy-specific trigger",
        none,
      ),
      snapshots: [],
    };
  const failures: string[] = [];
  const accepted = await firstAcceptedNativeCandidate(signals, async (candidate) => {
    if (!meaningfulRow(candidate.row, Date.now())) {
      failures.push(candidate.row.symbol + ": stale candidate data");
      return null;
    }
    let snapshot: PaperPerpetualSnapshot;
    try {
      snapshot = await input.fetchSnapshot(candidate.row.symbol);
    } catch {
      failures.push(candidate.row.symbol + ": market data unavailable");
      return null;
    }
    if (!meaningfulRow(candidate.row, Date.now())) {
      failures.push(candidate.row.symbol + ": data expired before entry");
      return null;
    }
    try {
      const comparison = buildComparison(input.profile, rows, candidate, Date.now());
      const proposal = nativeProposal(
        input.profile,
        candidate,
        snapshot,
        Number(input.availableQuote),
        Number(input.equityQuote),
        comparison,
      );
      if (proposal) return { decision: proposal, snapshots: [snapshot] };
    } catch {
      failures.push(candidate.row.symbol + ": proposal validation failed");
      return null;
    }
    failures.push(candidate.row.symbol + ": venue, funding, stop or risk check denied");
    return null;
  });
  if (accepted) return accepted;
  return {
    decision: noTrade(
      "Native PAPER: all " +
        signals.length +
        " signals rejected; " +
        failures.slice(0, 6).join("; "),
      none,
    ),
    snapshots: [],
  };
}
