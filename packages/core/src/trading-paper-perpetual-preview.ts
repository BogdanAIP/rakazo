import {
  getPaperExperimentPreset,
  type PaperExperimentStrategy,
  type PaperExperimentVenue,
  type PaperHedgeSide,
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
  /** Snapshot MUST come from the same owner-scoped ledger, never from the model. */
  portfolio: Readonly<{
    openPositions: number;
    openNotionalQuote: string;
    /** Gross marked/opening value of long legs. Never net shorts against longs. */
    openLongNotionalQuote: string;
    /** Gross marked/opening value of short legs. */
    openShortNotionalQuote: string;
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
      maintenanceMarginQuote: string;
      collateralRemainingAtStopQuote: string;
      equityRemainingAfterStressQuote: string;
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
    if (longNotional + shortNotional !== openNotional) return deny("invalid_input");
    const markedEquity = exact(input.portfolio.markedEquityQuote);
    const peakEquity = exact(input.portfolio.peakEquityQuote);
    const openRisk = exact(input.portfolio.openStopRiskQuote);
    const sameIdeaRisk = exact(input.portfolio.sameIdeaStopRiskQuote);
    const dailyLoss = exact(input.portfolio.realizedLossTodayQuote);
    const perIdeaCap = exact(preset.maxPerIdeaRiskQuote);
    const dailyCap = exact(preset.maxDailyLossQuote);
    const openCap = exact(preset.maxOpenRiskQuote);
    if (markedEquity === 0n || peakEquity === 0n || peakEquity < markedEquity)
      return deny("invalid_input");
    // High-watermark drawdown attenuates only NEW exposure, never protective exits.
    // Thresholds are experimental PAPER research settings (basis points).
    const softBps =
      input.strategy === "conservative" ? 250n : input.strategy === "moderate" ? 500n : 800n;
    const hardBps =
      input.strategy === "conservative" ? 500n : input.strategy === "moderate" ? 1000n : 1500n;
    const drawdownBps = ((peakEquity - markedEquity) * BPS) / peakEquity;
    if (drawdownBps >= hardBps) return deny("drawdown_circuit_breaker");
    const throttled = drawdownBps >= softBps;
    const effectiveIdeaCap = throttled ? perIdeaCap / 2n : perIdeaCap;
    const effectiveOpenCap = throttled ? openCap / 2n : openCap;
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
    const maintenance = ceil((notional > closeNotional ? notional : closeNotional) * mmr, BPS);
    // Account-wide cross margin: unused collateral is available as support.
    // Never treat initial margin of this isolated order as liquidation equity.
    // Conservative combined stop exposure from the entire account is used below.
    const projectedGross = openNotional + notional;
    const wholeStopRisk = openRisk + stopRisk;
    const stopMaintenance = ceil(projectedGross * (mmr > 200n ? mmr : 200n), BPS);
    const stopEquityRemaining = markedEquity - wholeStopRisk;
    if (stopEquityRemaining <= stopMaintenance) return deny("liquidation_before_stop");
    if (margin + entryFee > available) return deny("insufficient_margin");
    // Futures exposure is bounded by live account equity under a simultaneous
    // adverse-move stress, not a legacy fixed SPOT notional cap. Count gross
    // long + short notional: opposite hedge legs are NOT guaranteed to offset.
    // These are experimental buffers, not liquidation prices or authority
    // to widen/remove an existing stop.
    if (sameIdeaRisk > openRisk) return deny("invalid_input");
    const shockBps =
      input.strategy === "conservative" ? 3500n : input.strategy === "moderate" ? 2500n : 2000n;
    const survivalReserveBps = 2500n;
    const stressMaintenanceBps = mmr > 200n ? mmr : 200n; // minimum 2% gross
    const survivalReserve = ceil(markedEquity * survivalReserveBps, BPS);
    // Liquidation-avoidance is a PRE-ENTRY sizing objective, never a promise.
    // Even a full long collapse to zero and a 200% adverse short rally must
    // leave a reserve. Shorts can exceed +200%; actual venues may liquidate
    // earlier during gaps, funding, risk-tier changes or unavailable quotes.
    const projectedLong = longNotional + (input.side === "long" ? notional : 0n);
    const projectedShort = shortNotional + (input.side === "short" ? notional : 0n);
    const catastropheLoss = projectedLong + 2n * projectedShort;
    const catastropheMaintenance = ceil(projectedGross * stressMaintenanceBps, BPS);
    const catastropheResidual =
      markedEquity - catastropheLoss - catastropheMaintenance - survivalReserve;
    if (catastropheResidual <= 0n) return deny("catastrophic_survival_exceeded");
    const shockLoss = ceil(projectedGross * shockBps, BPS);
    const maintenanceReserve = ceil(projectedGross * stressMaintenanceBps, BPS);
    if (markedEquity <= shockLoss + maintenanceReserve + survivalReserve)
      return deny("portfolio_stress_exceeded");
    if (
      dailyLoss >= dailyCap ||
      sameIdeaRisk + stopRisk > effectiveIdeaCap ||
      stopRisk > min(effectiveIdeaCap, dailyCap - dailyLoss) ||
      openRisk + stopRisk > effectiveOpenCap
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
      maintenanceMarginQuote: fmt(maintenance),
      collateralRemainingAtStopQuote: fmt(stopEquityRemaining),
      equityRemainingAfterStressQuote: fmt(markedEquity - shockLoss - maintenanceReserve),
      equityRemainingAfterCatastropheQuote: fmt(
        markedEquity - catastropheLoss - catastropheMaintenance,
      ),
      peakDrawdownPercent: (Number(drawdownBps) / 100).toFixed(2),
      riskRewardRatio: (Number(rrHundredths) / 100).toFixed(2),
    };
  } catch {
    return deny("invalid_input");
  }
}
