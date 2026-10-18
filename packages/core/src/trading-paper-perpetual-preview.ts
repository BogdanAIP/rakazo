import type {
  PaperExperimentStrategy,
  PaperExperimentVenue,
  PaperHedgeSide,
} from "./trading-paper-experiments.js";
import {
  getPaperExperimentPreset,
  paperExperimentHedgeBucket,
} from "./trading-paper-experiments.js";

/**
 * Read-only, deterministic USDT perpetual PAPER *proposal* gate.
 * No exchange client, keys, database, order writing or execution permission.
 * The existing persistent spot ledger remains unchanged. Futures execution
 * MUST use a separate verified, append-only margin ledger before activation.
 */
const SCALE = 100_000_000n;
const BPS = 10_000n;
const MAX = 1_000_000_000_000_000n * SCALE;
const decimalPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
function exact(raw: string): bigint {
  if (!decimalPattern.test(raw)) throw new Error("Invalid exact PAPER decimal");
  const [whole, fraction = ""] = raw.split(".");
  const result = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
  if (result > MAX) throw new Error("PAPER decimal out of range");
  return result;
}
function fmt(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const frac = (abs % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return sign + (abs / SCALE).toString() + (frac ? `.${frac}` : "");
}
function ceil(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new Error("Invalid unsigned PAPER division");
  return (a + b - 1n) / b;
}
function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a < b ? a : b));
}
function checkedBps(n: number, max: number): bigint {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error("Invalid basis points");
  return BigInt(n);
}

export const PAPER_PERPETUAL_RISK_POLICY_VERSION = "paper-risk-v3" as const;

/** Equity-relative PAPER budgets. Drawdown only restricts new exposure. */
export function getPaperPerpetualRiskLimits(
  strategy: PaperExperimentStrategy,
  markedEquityQuote: string,
  peakEquityQuote: string = markedEquityQuote,
) {
  const preset = getPaperExperimentPreset(strategy);
  const equity = exact(markedEquityQuote);
  const peak = exact(peakEquityQuote);
  if (equity === 0n || peak < equity) throw new Error("Invalid PAPER equity");
  const drawdownBps = ((peak - equity) * BPS) / peak;
  const soft = strategy === "conservative" ? 250n : strategy === "moderate" ? 500n : 800n;
  const hard = strategy === "conservative" ? 500n : strategy === "moderate" ? 1000n : 1500n;
  const throttled = drawdownBps >= soft;
  const scale = (base: string) => (exact(base) * equity) / exact(preset.initialBalanceQuote);
  return {
    policyVersion: PAPER_PERPETUAL_RISK_POLICY_VERSION,
    maxPerIdeaRiskQuote: fmt(scale(preset.maxPerIdeaRiskQuote) / (throttled ? 2n : 1n)),
    maxDailyLossQuote: fmt(scale(preset.maxDailyLossQuote)),
    maxOpenRiskQuote: fmt(scale(preset.maxOpenRiskQuote) / (throttled ? 2n : 1n)),
    peakDrawdownPercent: (Number(drawdownBps) / 100).toFixed(2),
    throttled,
    circuitBreaker: drawdownBps >= hard,
  };
}

export type PaperPerpetualProposalInput = Readonly<{
  strategy: PaperExperimentStrategy;
  ledgerId: string;
  venue: PaperExperimentVenue;
  instrument: string;
  side: PaperHedgeSide;
  leverage: number;
  /** Trusted persisted owner setting; not part of the model proposal. */
  ownerMaxLeverage?: number;
  quantityBase: string;
  entryPriceQuote: string;
  stopPriceQuote: string;
  takeProfitPriceQuote: string;
  availableQuote: string;
  /** Future additional gross quote budget for this NEW idea; no automatic order. */
  additionalRecoveryNotionalQuote?: string;
  /** Snapshot MUST come from the same owner-scoped ledger, never from the model. */
  portfolio: Readonly<{
    openPositions: number;
    openNotionalQuote: string;
    /** Gross marked/opening value of long legs. Never net shorts against longs. */
    openLongNotionalQuote: string;
    /** Gross marked/opening value of short legs. */
    openShortNotionalQuote: string;
    /** Unspent reserves on OTHER and EXISTING position ideas, split by side. */
    recoveryLongNotionalQuote?: string;
    recoveryShortNotionalQuote?: string;
    recoveryReservedRiskQuote?: string;
    /** Trusted current exposure and unspent reserves, by held leg. Required for
     * nonzero existing gross exposure; missing terms fail closed.
     */
    maintenanceLegs?: ReadonlyArray<
      Readonly<{
        grossNotionalQuote: string;
        maintenanceMarginBps: number;
      }>
    >;
    sameIdeaReservedRiskQuote?: string;
    /** Current marked equity from the native simulator, not model-supplied. */
    markedEquityQuote: string;
    /** High watermark derived from verified historical native equity, not the model. */
    peakEquityQuote: string;
    openStopRiskQuote: string;
    /** Stop risk already committed to the same instrument and side. */
    sameIdeaStopRiskQuote: string;
    realizedLossTodayQuote: string;
  }>;
  assumedFeeBpsPerSide: number;
  assumedSlippageBpsPerSide: number;
  /** A conservative paper assumption, NOT an exchange's actual liquidation model. */
  maintenanceMarginBps: number;
}>;

export type PaperPerpetualProposal =
  | {
      status: "deny";
      mode: "paper_only";
      reason:
        | "invalid_input"
        | "unsupported_market"
        | "leverage_exceeded"
        | "invalid_exit_prices"
        | "risk_budget_exceeded"
        | "position_count_exceeded"
        | "notional_exceeded"
        | "portfolio_stress_exceeded"
        | "catastrophic_survival_exceeded"
        | "drawdown_circuit_breaker"
        | "insufficient_margin"
        | "liquidation_before_stop";
    }
  | {
      status: "inert_preview";
      mode: "paper_only";
      /** Used for separation only. Not an order ID or execution authorization. */
      positionBucket: string;
      side: PaperHedgeSide;
      leverage: number;
      effectiveEntryQuote: string;
      effectiveStopQuote: string;
      quantityBase: string;
      notionalQuote: string;
      initialMarginQuote: string;
      entryFeeQuote: string;
      stopExitFeeQuote: string;
      worstCaseStopLossQuote: string;
      plannedRecoveryNotionalQuote: string;
      plannedRecoveryRiskQuote: string;
      maintenanceMarginQuote: string;
      collateralRemainingAtStopQuote: string;
      riskPolicyVersion: typeof PAPER_PERPETUAL_RISK_POLICY_VERSION;
      maxPerIdeaRiskQuote: string;
      /** Mandatory 50% adverse gross stress; excludes the separate 25% buffer. */
      equityRemainingAfterStressQuote: string;
      /** Diagnostic 100% adverse move on every gross leg. May be negative. */
      equityRemainingAfterExtremeQuote: string;
      equityRemainingAfterCatastropheQuote: string;
      peakDrawdownPercent: string;
      riskRewardRatio: string;
    };

/** Uses exact fixed-point arithmetic; never supplies an executable order. */
export function previewPaperPerpetualProposal(
  input: PaperPerpetualProposalInput,
): PaperPerpetualProposal {
  const deny = (reason: Extract<PaperPerpetualProposal, { status: "deny" }>["reason"]) => ({
    status: "deny" as const,
    mode: "paper_only" as const,
    reason,
  });
  const positionBucket = paperExperimentHedgeBucket(input);
  if (!positionBucket) return deny("unsupported_market");
  const preset = getPaperExperimentPreset(input.strategy);
  if (
    !Number.isSafeInteger(input.ownerMaxLeverage ?? preset.maxLeverage) ||
    (input.ownerMaxLeverage ?? preset.maxLeverage) < 1 ||
    !Number.isSafeInteger(input.leverage) ||
    input.leverage < 1 ||
    input.leverage > (input.ownerMaxLeverage ?? preset.maxLeverage)
  )
    return deny("leverage_exceeded");
  try {
    const fee = checkedBps(input.assumedFeeBpsPerSide, 1000);
    const slippage = checkedBps(input.assumedSlippageBpsPerSide, 1000);
    const mmr = checkedBps(input.maintenanceMarginBps, 1000);
    if (mmr === 0n) return deny("invalid_input");
    const qty = exact(input.quantityBase);
    const entry = exact(input.entryPriceQuote);
    const stop = exact(input.stopPriceQuote);
    const target = exact(input.takeProfitPriceQuote);
    const available = exact(input.availableQuote);
    const openNotional = exact(input.portfolio.openNotionalQuote);
    const longNotional = exact(input.portfolio.openLongNotionalQuote);
    const shortNotional = exact(input.portfolio.openShortNotionalQuote);
    const reservedLong = exact(input.portfolio.recoveryLongNotionalQuote ?? "0");
    const reservedShort = exact(input.portfolio.recoveryShortNotionalQuote ?? "0");
    const reservedRisk = exact(input.portfolio.recoveryReservedRiskQuote ?? "0");
    const reservedSameIdea = exact(input.portfolio.sameIdeaReservedRiskQuote ?? "0");
    const newRecovery = exact(input.additionalRecoveryNotionalQuote ?? "0");
    const existingGross = openNotional + reservedLong + reservedShort;
    const maintenanceLegs = input.portfolio.maintenanceLegs ?? [];
    if (maintenanceLegs.length > 100) return deny("invalid_input");
    let evidencedGross = 0n;
    let existingStressMaintenance = 0n;
    for (const leg of maintenanceLegs) {
      const gross = exact(leg.grossNotionalQuote);
      const rate = checkedBps(leg.maintenanceMarginBps, 1000);
      if (gross === 0n || rate === 0n) return deny("invalid_input");
      evidencedGross += gross;
      existingStressMaintenance += ceil(gross * (rate > 200n ? rate : 200n), BPS);
    }
    if (evidencedGross !== existingGross) return deny("invalid_input");
    if (reservedSameIdea > reservedRisk) return deny("invalid_input");
    if (longNotional + shortNotional !== openNotional) return deny("invalid_input");
    const markedEquity = exact(input.portfolio.markedEquityQuote);
    const peakEquity = exact(input.portfolio.peakEquityQuote);
    const openRisk = exact(input.portfolio.openStopRiskQuote);
    const sameIdeaRisk = exact(input.portfolio.sameIdeaStopRiskQuote);
    const dailyLoss = exact(input.portfolio.realizedLossTodayQuote);
    const limits = getPaperPerpetualRiskLimits(input.strategy, fmt(markedEquity), fmt(peakEquity));
    if (limits.circuitBreaker) return deny("drawdown_circuit_breaker");
    const effectiveIdeaCap = exact(limits.maxPerIdeaRiskQuote);
    const dailyCap = exact(limits.maxDailyLossQuote);
    const effectiveOpenCap = exact(limits.maxOpenRiskQuote);
    if (
      [qty, entry, stop, target, available].some((v) => v === 0n) ||
      !Number.isSafeInteger(input.portfolio.openPositions) ||
      input.portfolio.openPositions < 0
    )
      return deny("invalid_input");
    if (input.portfolio.openPositions >= preset.maxConcurrentPositions) {
      return deny("position_count_exceeded");
    }
    if (input.side === "long" ? stop >= entry || target <= entry : stop <= entry || target >= entry)
      return deny("invalid_exit_prices");

    // Adverse simulated prices including bounded entry/stop slippage.
    const effectiveEntry =
      input.side === "long"
        ? ceil(entry * (BPS + slippage), BPS)
        : (entry * (BPS - slippage)) / BPS;
    const effectiveStop =
      input.side === "long" ? (stop * (BPS - slippage)) / BPS : ceil(stop * (BPS + slippage), BPS);
    if (
      effectiveEntry === 0n ||
      effectiveStop === 0n ||
      (input.side === "long" ? effectiveStop >= effectiveEntry : effectiveStop <= effectiveEntry)
    ) {
      return deny("invalid_exit_prices");
    }
    const notional = ceil(qty * effectiveEntry, SCALE);
    const closeNotional = ceil(qty * effectiveStop, SCALE);
    const margin = ceil(notional, BigInt(input.leverage));
    const entryFee = ceil(notional * fee, BPS);
    const stopFee = ceil(closeNotional * fee, BPS);
    const adverseDifference =
      input.side === "long" ? effectiveEntry - effectiveStop : effectiveStop - effectiveEntry;
    const priceLoss = ceil(qty * adverseDifference, SCALE);
    const stopRisk = priceLoss + entryFee + stopFee;
    // Pretend reserved future adds eventually fill at an adverse comparable
    // price, WITHOUT making orders or treating these budgets as actual margin.
    const plannedRecoveryRisk =
      ceil(newRecovery * adverseDifference, effectiveEntry) + ceil(newRecovery * fee * 2n, BPS);
    const maintenance = ceil((notional > closeNotional ? notional : closeNotional) * mmr, BPS);
    // Account-wide cross margin: unused collateral is available as support.
    // Never treat initial margin of this isolated order as liquidation equity.
    // Conservative combined stop exposure from the entire account is used below.
    const projectedGross = openNotional + notional + reservedLong + reservedShort + newRecovery;
    const wholeStopRisk = openRisk + reservedRisk + stopRisk + plannedRecoveryRisk;
    const proposedStressMaintenance = ceil(
      (notional + newRecovery) * (mmr > 200n ? mmr : 200n),
      BPS,
    );
    const stopMaintenance = existingStressMaintenance + proposedStressMaintenance;
    const stopEquityRemaining = markedEquity - wholeStopRisk;
    if (stopEquityRemaining <= stopMaintenance) return deny("liquidation_before_stop");
    // Reserve capacity BEFORE other independent ideas consume free collateral.
    if (
      margin + entryFee + ceil(reservedLong + reservedShort + newRecovery, BigInt(input.leverage)) >
      available
    )
      return deny("insufficient_margin");
    // Futures exposure is bounded by live account equity under a simultaneous
    // adverse-move stress, not a legacy fixed SPOT notional cap. Count gross
    // long + short notional: opposite hedge legs are NOT guaranteed to offset.
    // These are experimental buffers, not liquidation prices or authority
    // to widen/remove an existing stop.
    if (sameIdeaRisk > openRisk) return deny("invalid_input");
    const shockBps = 5000n;
    const survivalReserveBps = 2500n;
    const survivalReserve = ceil(markedEquity * survivalReserveBps, BPS);
    // Larger shocks remain diagnostics, not an additional admission gate.
    // A long collapse to zero / 200% short rally can still exhaust equity.
    // This simplified PAPER stress is not a venue liquidation guarantee.
    const projectedLong =
      longNotional + reservedLong + (input.side === "long" ? notional + newRecovery : 0n);
    const projectedShort =
      shortNotional + reservedShort + (input.side === "short" ? notional + newRecovery : 0n);
    const catastropheLoss = projectedLong + 2n * projectedShort;
    const catastropheMaintenance = stopMaintenance;
    const shockLoss = ceil(projectedGross * shockBps, BPS);
    const maintenanceReserve = stopMaintenance;
    if (markedEquity <= shockLoss + maintenanceReserve + survivalReserve)
      return deny("portfolio_stress_exceeded");
    if (
      dailyLoss >= dailyCap ||
      sameIdeaRisk + reservedSameIdea + stopRisk + plannedRecoveryRisk > effectiveIdeaCap ||
      stopRisk > min(effectiveIdeaCap, dailyCap - dailyLoss) ||
      openRisk + reservedRisk + stopRisk + plannedRecoveryRisk > effectiveOpenCap
    )
      return deny("risk_budget_exceeded");

    const favorable = input.side === "long" ? target - effectiveEntry : effectiveEntry - target;
    if (favorable <= 0n) return deny("invalid_exit_prices");
    const reward = (qty * favorable) / SCALE;
    const targetFee = ceil(ceil(qty * target, SCALE) * fee, BPS);
    const netReward = reward > entryFee + targetFee ? reward - entryFee - targetFee : 0n;
    // Whole percentage-point ratio to avoid pretending numerical precision.
    const rrHundredths = (netReward * 100n) / stopRisk;
    return {
      status: "inert_preview",
      mode: "paper_only",
      positionBucket,
      side: input.side,
      leverage: input.leverage,
      effectiveEntryQuote: fmt(effectiveEntry),
      effectiveStopQuote: fmt(effectiveStop),
      quantityBase: fmt(qty),
      notionalQuote: fmt(notional),
      initialMarginQuote: fmt(margin),
      entryFeeQuote: fmt(entryFee),
      stopExitFeeQuote: fmt(stopFee),
      worstCaseStopLossQuote: fmt(stopRisk),
      plannedRecoveryNotionalQuote: fmt(newRecovery),
      plannedRecoveryRiskQuote: fmt(plannedRecoveryRisk),
      maintenanceMarginQuote: fmt(maintenance),
      collateralRemainingAtStopQuote: fmt(stopEquityRemaining),
      riskPolicyVersion: limits.policyVersion,
      maxPerIdeaRiskQuote: limits.maxPerIdeaRiskQuote,
      equityRemainingAfterStressQuote: fmt(markedEquity - shockLoss - maintenanceReserve),
      equityRemainingAfterExtremeQuote: fmt(markedEquity - projectedGross - stopMaintenance),
      equityRemainingAfterCatastropheQuote: fmt(
        markedEquity - catastropheLoss - catastropheMaintenance,
      ),
      peakDrawdownPercent: limits.peakDrawdownPercent,
      riskRewardRatio: (Number(rrHundredths) / 100).toFixed(2),
    };
  } catch {
    return deny("invalid_input");
  }
}
