import type { PaperPerpetualEngineSnapshot } from "@rakazo/contracts";
import {
  paperPerpetualAmount as amount,
  formatPaperPerpetualAmount as format,
} from "./trading-paper-perpetual-ledger.js";

const signed = (s: string) => (s.startsWith("-") ? -amount(s.slice(1)) : amount(s));
type Sample = { at: string; equityQuote: string; drawdownPercent: string; gapBefore: boolean };
/** Only verified complete native transitions may be passed here. Sampling is
 * bounded after calculating full-history extrema, never from a paginated UI.
 */
export function summarizePaperEquity(
  transitions: readonly { output: PaperPerpetualEngineSnapshot; recordedAt: Date }[],
  openedAt: string,
) {
  let peak = 1000_00000000n,
    maximum = 0n;
  const samples: Sample[] = [
    { at: openedAt, equityQuote: "1000", drawdownPercent: "0.00", gapBefore: false },
  ];
  for (const { output, recordedAt } of transitions) {
    const equity =
      signed(output.balanceQuote) +
      output.positions.reduce((n, p) => n + signed(p.unrealizedPnlQuote), 0n);
    if (equity > peak) peak = equity;
    const dd = peak > 0n ? ((peak - equity) * 10000n) / peak : 0n;
    if (dd > maximum) maximum = dd;
    const previous = samples.at(-1)!;
    const at = recordedAt.toISOString();
    samples.push({
      at,
      equityQuote: format(equity),
      drawdownPercent: (Number(dd) / 100).toFixed(2),
      gapBefore: Date.parse(at) - Date.parse(previous.at) > 15 * 60_000,
    });
  }
  // Five samples per bucket retain price and drawdown extrema plus endpoints.
  // Gaps are also retained; if exceptionally numerous, decline the curve
  // rather than connecting across missing observations.
  const chosen = new Set<number>([0, samples.length - 1]);
  const bucket = Math.max(1, Math.ceil(samples.length / 80));
  for (let start = 0; start < samples.length; start += bucket) {
    const end = Math.min(samples.length, start + bucket);
    let lo = start,
      hi = start,
      worst = start;
    chosen.add(start);
    chosen.add(end - 1);
    for (let i = start; i < end; i++) {
      if (signed(samples[i]!.equityQuote) < signed(samples[lo]!.equityQuote)) lo = i;
      if (signed(samples[i]!.equityQuote) > signed(samples[hi]!.equityQuote)) hi = i;
      if (Number(samples[i]!.drawdownPercent) > Number(samples[worst]!.drawdownPercent)) worst = i;
      if (samples[i]!.gapBefore) {
        chosen.add(i);
        chosen.add(i - 1);
      }
    }
    chosen.add(lo);
    chosen.add(hi);
    chosen.add(worst);
  }
  return {
    scope: "full_verified_history" as const,
    observations: transitions.length,
    maximumDrawdownPercent: (Number(maximum) / 100).toFixed(2),
    points: chosen.size <= 500 ? [...chosen].sort((a, b) => a - b).map((i) => samples[i]!) : [],
  };
}
