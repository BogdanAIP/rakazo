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
