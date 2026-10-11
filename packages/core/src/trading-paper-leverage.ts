import type { PaperLeverageTier, PaperVenueLeverageLimits } from "@rakazo/contracts";
import type { PaperExperimentVenue } from "./trading-paper-experiments.js";

export type { PaperLeverageTier, PaperVenueLeverageLimits } from "@rakazo/contracts";

export type PaperLeverageInput = Readonly<{
  venue: PaperExperimentVenue;
  instrument: string;
  marginMode: "cross" | "isolated";
  requestedLeverage: number;
  /** Persisted owner setting, never a value supplied by an AI proposal. */
  ownerMaxLeverage: number;
  /** Gross same-contract exposure, including BOTH hedge legs and pending entries. */
  existingQuantityBase: string;
  proposedQuantityBase: string;
  /** Fresh trusted adapter evidence, never model-supplied metadata. */
  limits: PaperVenueLeverageLimits | null;
  /** Trusted execution clock; re-run with fresh evidence immediately before entry. */
  now: string;
}>;

export type PaperLeverageResult =
  | Readonly<{
      status: "deny";
      reason:
        | "invalid_input"
        | "venue_limits_unavailable"
        | "venue_limits_mismatch"
        | "venue_limits_stale"
        | "invalid_venue_tiers"
        | "position_tier_exceeded"
        | "leverage_exceeded";
    }>
  | Readonly<{
      status: "allowed";
      leverage: number;
      ownerMaxLeverage: number;
      venueMaxLeverage: number;
      effectiveMaxLeverage: number;
      grossQuantityBase: string;
      tierIds: readonly string[];
      sourceId: string;
      observedAt: string;
    }>;

const SCALE = 100_000_000n;
const MAX_LIMIT_AGE_MS = 30_000;

function quantity(raw: string): bigint {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(raw)) {
    throw new Error("Invalid base quantity");
  }
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}

function formatQuantity(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return (value / SCALE).toString() + (fraction ? `.${fraction}` : "");
}

function clock(raw: string): number {
  const value = Date.parse(raw);
  if (!Number.isFinite(value) || new Date(value).toISOString() !== raw) {
    throw new Error("Invalid evidence clock");
  }
  return value;
}

/**
 * Permission/risk input check only. Nautilus owns accounting and execution.
 * No fallback exchange maximum, hedge netting, leverage clamping or order route.
 * Public tiers describe PAPER limits, not private account eligibility.
 */
export function evaluatePaperLeverage(input: PaperLeverageInput): PaperLeverageResult {
  const deny = (reason: Extract<PaperLeverageResult, { status: "deny" }>["reason"]) => ({
    status: "deny" as const,
    reason,
  });
  try {
    if (
      !Number.isSafeInteger(input.requestedLeverage) ||
      input.requestedLeverage < 1 ||
      !Number.isSafeInteger(input.ownerMaxLeverage) ||
      input.ownerMaxLeverage < 1 ||
      (input.venue !== "okx" && input.venue !== "bingx") ||
      !/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(input.instrument) ||
      (input.marginMode !== "cross" && input.marginMode !== "isolated")
    ) {
      return deny("invalid_input");
    }
    const gross = quantity(input.existingQuantityBase) + quantity(input.proposedQuantityBase);
    const now = clock(input.now);
    const limits = input.limits;
    if (!limits) return deny("venue_limits_unavailable");
    if (
      limits.venue !== input.venue ||
      limits.instrument !== input.instrument ||
      limits.marginMode !== input.marginMode
    ) {
      return deny("venue_limits_mismatch");
    }
    if (!limits.sourceId.trim() || limits.sourceId.length > 256) {
      return deny("venue_limits_unavailable");
    }
    const age = now - clock(limits.observedAt);
    if (age < 0 || age > MAX_LIMIT_AGE_MS) return deny("venue_limits_stale");
    if (limits.tiers.length === 0 || limits.tiers.length > 1000) {
      return deny("invalid_venue_tiers");
    }

    const ids = new Set<string>();
    let previousMax = 0n;
    let previousLeverage = Number.POSITIVE_INFINITY;
    const matching: PaperLeverageTier[] = [];
    for (const tier of limits.tiers) {
      const min = quantity(tier.minQuantityBase);
      const max = quantity(tier.maxQuantityBase);
      if (
        !tier.id.trim() ||
        tier.id.length > 128 ||
        ids.has(tier.id) ||
        min !== previousMax ||
        max <= min ||
        !Number.isFinite(tier.maxLeverage) ||
        tier.maxLeverage < 1 ||
        tier.maxLeverage > Number.MAX_SAFE_INTEGER ||
        tier.maxLeverage > previousLeverage
      ) {
        return deny("invalid_venue_tiers");
      }
      ids.add(tier.id);
      previousMax = max;
      previousLeverage = tier.maxLeverage;
      // At a shared tier boundary use the more restrictive adjacent limit.
      if (gross >= min && gross <= max) matching.push(tier);
    }
    if (matching.length === 0) return deny("position_tier_exceeded");
    const venueMaxLeverage = Math.min(...matching.map((tier) => tier.maxLeverage));
    const effectiveMaxLeverage = Math.min(input.ownerMaxLeverage, Math.floor(venueMaxLeverage));
    if (input.requestedLeverage > effectiveMaxLeverage) return deny("leverage_exceeded");
    return {
      status: "allowed",
      leverage: input.requestedLeverage,
      ownerMaxLeverage: input.ownerMaxLeverage,
      venueMaxLeverage,
      effectiveMaxLeverage,
      grossQuantityBase: formatQuantity(gross),
      tierIds: matching.map((tier) => tier.id),
      sourceId: limits.sourceId,
      observedAt: limits.observedAt,
    };
  } catch {
    return deny("invalid_input");
  }
}
