/** P11B-1. Pure bounded, exact 8-decimal paper SPOT capacity estimate only.
 * NOT an approval, reservation, exchange order or executable instruction. */
const SCALE = 100_000_000n;
const BPS = 100_000_000n; // 10,000 basis points x 10,000 fractional-bps units.
const exact = (value: string): bigint => {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value))
    throw new Error("Unsupported exact paper decimal");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
};
const fmt = (value: bigint): string => {
  const frac = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value / SCALE}${frac ? `.${frac}` : ""}`;
};
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const smallest = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
function bps(value: number): bigint {
  const s = String(value);
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/.test(s)) {
    throw new Error("Fractional basis point precision exceeds four places");
  }
  const [whole, fraction = ""] = s.split(".");
  const n = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  if (n > 10_000_000n) throw new Error("Fee/slippage basis points out of range");
  return n;
}
export type PaperSpotCapacityInput = {
  availableQuote: string;
  askQuote: string;
  stopQuote: string;
  quantityIncrement: string;
  minNotionalQuote: string | null;
  maxPerIdeaRiskQuote: string;
  maxDailyLossQuote: string;
  maxOpenRiskQuote: string;
  maxTotalExposureQuote: string;
  assumedFeeBpsPerSide: number;
  assumedSlippageBpsPerSide: number;
};
export type PaperSpotCapacity =
  | { status: "deny"; reason: "unrepresentable" | "no_capacity" | "invalid_stop" | "below_minimum" }
  | {
      status: "inert_estimate";
      quantityBase: string;
      heldQuote: string;
      worstCaseStopRiskQuote: string;
      conservativeEntryQuote: string;
      conservativeStopQuote: string;
    };

/** Bounded BigInt arithmetic; rounding always adverse, size always downward.
 * The estimate cannot be used as a permission by a Worker or model. */
export function estimateExactPaperSpotCapacity(raw: PaperSpotCapacityInput): PaperSpotCapacity {
  const deny = (reason: Extract<PaperSpotCapacity, { status: "deny" }>["reason"]) => ({
    status: "deny" as const,
    reason,
  });
  try {
    const available = exact(raw.availableQuote);
    const ask = exact(raw.askQuote);
    const stop = exact(raw.stopQuote);
    const increment = exact(raw.quantityIncrement);
    const perIdea = exact(raw.maxPerIdeaRiskQuote);
    const perDay = exact(raw.maxDailyLossQuote);
    const openRisk = exact(raw.maxOpenRiskQuote);
    const totalExposure = exact(raw.maxTotalExposureQuote);
    const minimum = raw.minNotionalQuote === null ? 0n : exact(raw.minNotionalQuote);
    const fee = bps(raw.assumedFeeBpsPerSide);
    const slip = bps(raw.assumedSlippageBpsPerSide);
    if (increment === 0n || ask === 0n || stop === 0n || stop >= ask) return deny("invalid_stop");
    if (smallest(available, perIdea, perDay, openRisk, totalExposure) === 0n) {
      return deny("no_capacity");
    }
    const entry = ceil(ask * (BPS + slip), BPS);
    const exit = (stop * (BPS - slip)) / BPS;
    if (exit === 0n || exit >= entry) return deny("invalid_stop");
    const buyUnit = ceil(entry * (BPS + fee), BPS);
    const sellUnit = (exit * (BPS - fee)) / BPS;
    const lossUnit = buyUnit - sellUnit;
    if (lossUnit <= 0n) return deny("invalid_stop");
    const riskCap = smallest(perIdea, perDay, openRisk);
    const cashCap = smallest(available, totalExposure);
    // Leave two smallest quote units of headroom for aggregate fee/price rounding.
    const byCash = (cashCap > 2n ? (cashCap - 2n) * SCALE : 0n) / buyUnit;
    const byRisk = (riskCap > 2n ? (riskCap - 2n) * SCALE : 0n) / lossUnit;
    const quantity = (smallest(byCash, byRisk) / increment) * increment;
    if (quantity <= 0n || quantity > exact("999999999999999.99999999")) {
      return deny("no_capacity");
    }
    const cost = ceil(quantity * entry, SCALE);
    const buyFee = ceil(cost * fee, BPS);
    const held = cost + buyFee;
    const proceeds = (quantity * exit) / SCALE;
    const sellFee = ceil(proceeds * fee, BPS);
    const risk = held - proceeds + sellFee;
    if (held > cashCap || risk > riskCap || held <= 0n || risk <= 0n) {
      return deny("no_capacity");
    }
    if (cost < minimum) return deny("below_minimum");
    return {
      status: "inert_estimate",
      quantityBase: fmt(quantity),
      heldQuote: fmt(held),
      worstCaseStopRiskQuote: fmt(risk),
      conservativeEntryQuote: fmt(entry),
      conservativeStopQuote: fmt(exit),
    };
  } catch {
    return deny("unrepresentable");
  }
}
