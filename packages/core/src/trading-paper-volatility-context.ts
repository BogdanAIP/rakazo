/** Read-only PAPER volatility context. Never approves orders or cancels protective stops. */
export type PaperVolatilityCandle = Readonly<{
  openedAt: string;
  durationMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  confirmed: boolean;
}>;
export type PaperVolatilityContext =
  | { status: "insufficient_history"; sampleCount: number; required: 14 }
  | {
      status: "ready";
      sampleCount: number;
      durationMs: number;
      atrPercent: number;
      downsideWickP90Percent: number;
      upsideWickP90Percent: number;
      completeThrough: string;
      mode: "advisory_only";
    }
  | { status: "invalid_history"; mode: "advisory_only" };

/** Prior close true ranges + intrabar tail distributions; no predicted stop fills. */
export function summarizePaperVolatilityContext(
  raw: readonly PaperVolatilityCandle[],
): PaperVolatilityContext {
  const history = raw.slice(-30);
  if (history.length < 14) {
    return { status: "insufficient_history", sampleCount: history.length, required: 14 };
  }
  let previousClose: number | undefined;
  let previousOpenMs = -Infinity;
  const ranges: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  for (const row of history) {
    const o = Number(row.open);
    const h = Number(row.high);
    const l = Number(row.low);
    const c = Number(row.close);
    const t = Date.parse(row.openedAt);
    if (
      !row.confirmed ||
      !Number.isFinite(t) ||
      t <= previousOpenMs ||
      !Number.isSafeInteger(row.durationMs) ||
      row.durationMs <= 0 ||
      ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0) ||
      l > Math.min(o, c) ||
      h < Math.max(o, c) ||
      l > h
    ) {
      return { status: "invalid_history", mode: "advisory_only" };
    }
    const base = previousClose ?? c;
    const tr = Math.max(h - l, Math.abs(h - base), Math.abs(l - base));
    ranges.push((100 * tr) / base);
    lower.push((100 * (Math.min(o, c) - l)) / base);
    upper.push((100 * (h - Math.max(o, c))) / base);
    previousClose = c;
    previousOpenMs = t;
  }
  const percentile90 = (x: number[]) => {
    const sorted = [...x].sort((a, b) => a - b);
    return sorted[Math.ceil(0.9 * sorted.length) - 1]!;
  };
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    status: "ready",
    sampleCount: history.length,
    durationMs: history.at(-1)!.durationMs,
    atrPercent: round(ranges.reduce((a, b) => a + b, 0) / ranges.length),
    downsideWickP90Percent: round(percentile90(lower)),
    upsideWickP90Percent: round(percentile90(upper)),
    completeThrough: new Date(
      Date.parse(history.at(-1)!.openedAt) + history.at(-1)!.durationMs,
    ).toISOString(),
    mode: "advisory_only",
  };
}


/**
 * Conservative *evidence gate*, not a prediction that a double bottom/top will hold.
 * Never grants an order. Requires a tested second pivot AND a confirmed neckline
 * breakout; a falling/accelerating price alone NEVER licenses averaging down.
 */
export function assessPaperRecoveryStructure(
  candles: readonly PaperVolatilityCandle[],
  losingSide: "long" | "short",
): { status: "confirmed_structure" | "unconfirmed_structure"; reason: string } {
  const history = candles.slice(-30);
  if (history.length < 20) return { status: "unconfirmed_structure", reason: "insufficient_closed_bars" };
  const rows: Array<{ low: number; high: number; close: number }> = [];
  let previousAt = -Infinity;
  let step = 0;
  for (const bar of history) {
    const at = Date.parse(bar.openedAt);
    const open = Number(bar.open), high = Number(bar.high);
    const low = Number(bar.low), close = Number(bar.close);
    if (
      !bar.confirmed || !Number.isFinite(at) || !Number.isSafeInteger(bar.durationMs) ||
      bar.durationMs <= 0 || (step !== 0 && bar.durationMs !== step) ||
      (previousAt !== -Infinity && at !== previousAt + step) ||
      ![open, high, low, close].every((x) => Number.isFinite(x) && x > 0) ||
      low > Math.min(open, close) || high < Math.max(open, close)
    ) return { status: "unconfirmed_structure", reason: "untrusted_candles" };
    rows.push({ low, high, close });
    step = bar.durationMs;
    previousAt = at;
  }
  const last = rows.at(-1)!;
  const prev = rows.at(-2)!;
  if (losingSide === "long" ? last.close <= prev.close : last.close >= prev.close)
    return { status: "unconfirmed_structure", reason: "no_confirmed_reversal" };
  const pivots: number[] = [];
  for (let i = 2; i <= rows.length - 4; i++) {
    const p = rows[i]!, prior = rows[i - 1]!, next = rows[i + 1]!;
    if (
      losingSide === "long"
        ? p.low < prior.low && p.low < next.low
        : p.high > prior.high && p.high > next.high
    ) pivots.push(i);
  }
  for (const i of pivots) for (const j of pivots) {
    if (j - i < 4 || j - i > 14 || j > rows.length - 4) continue;
    const first = losingSide === "long" ? rows[i]!.low : rows[i]!.high;
    const second = losingSide === "long" ? rows[j]!.low : rows[j]!.high;
    const ratio = second / first;
    // Second test near the original pivot, not an unchecked lower low / higher high.
    if (ratio < 0.985 || ratio > 1.05) continue;
    const between = rows.slice(i + 1, j);
    const neckline =
      losingSide === "long"
        ? Math.max(...between.map((x) => x.close))
        : Math.min(...between.map((x) => x.close));
    const confirmation =
      losingSide === "long"
        ? last.close > neckline * 1.005 &&
          rows.slice(j + 1).every((x) => x.low >= second * 0.985)
        : last.close < neckline * 0.995 &&
          rows.slice(j + 1).every((x) => x.high <= second * 1.015);
    if (confirmation) return { status: "confirmed_structure", reason: "two_pivots_and_neckline_break" };
  }
  return { status: "unconfirmed_structure", reason: "no_verified_second_pivot_breakout" };
}
