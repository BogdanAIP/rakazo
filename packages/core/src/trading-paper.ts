import {
  type TradingPaperAssessment,
  type TradingPaperAssessmentInput,
  TradingPaperAssessmentInputSchema,
  TradingPaperAssessmentSchema,
} from "@rakazo/contracts";

/**
 * Inert paper PREVIEW, no broker order, persistent approval, exchange client,
 * balance read or privileged action. Risk is independent from model prose.
 */
export function evaluateTradingPaperRisk(raw: TradingPaperAssessmentInput): TradingPaperAssessment {
  const input = TradingPaperAssessmentInputSchema.parse(raw);
  const { policy, portfolio, signal, observedQuote } = input;
  const deny = (reason: string): TradingPaperAssessment =>
    TradingPaperAssessmentSchema.parse({ status: "deny", mode: "paper_only", reason });
  const now = Date.parse(input.now);
  const sample = Date.parse(observedQuote.observedAt);
  const snapshot = Date.parse(portfolio.snapshotAt);
  const recent = (at: number): boolean => at <= now + 2000 && now - at <= policy.maxAgeMs;

  if (!policy.enabled || policy.killSwitch)
    return deny("Paper risk policy disabled or kill switch active");
  if (signal.kind !== "proposal") return deny("NO_TRADE never creates a paper candidate");
  if (signal.executionStatus !== "research_only") return deny("Unexpected execution status");
  if (signal.market.kind !== "spot" || signal.action !== "spot_buy") {
    return deny("Only spot buy previews are supported; futures require separate risk models");
  }
  const market = signal.market;
  if (market.status !== "active" || !policy.allowedVenues.includes(market.venue)) {
    return deny("Market or venue is not enabled in the paper policy");
  }
  if (market.quote !== policy.quoteCurrency || portfolio.quoteCurrency !== policy.quoteCurrency) {
    return deny("Paper balance, instrument and policy quote currencies differ");
  }
  if (Date.parse(signal.createdAt) > now + 2000 || Date.parse(signal.expiresAt) <= now) {
    return deny("Signal is future-dated or expired");
  }
  if (!recent(sample) || !recent(snapshot))
    return deny("Market quote or portfolio snapshot is stale");
  if (portfolio.openPositions >= policy.maxPositions)
    return deny("Maximum paper positions reached");

  const amount = (s: string) => Number(s);
  const bid = amount(observedQuote.bid);
  const ask = amount(observedQuote.ask);
  const trigger = amount(signal.entryTrigger);
  const stop = amount(signal.stopLoss);
  const available = amount(portfolio.availableQuoteBalance);
  const exposure = amount(portfolio.openExposureQuote);
  const openRisk = amount(portfolio.openStopRiskQuote);
  const pnlToday = amount(portfolio.realizedPnlTodayQuote);
  const numValues = [bid, ask, trigger, stop, available, exposure, openRisk, pnlToday];
  if (numValues.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e12)) {
    return deny("Unbounded paper risk arithmetic");
  }
  if (bid > ask || ((ask - bid) / ((ask + bid) / 2)) * 10_000 > policy.maxSpreadBps) {
    return deny("Invalid or excessive bid/ask spread");
  }
  if (ask < trigger || ((ask - trigger) / trigger) * 10_000 > policy.maxTriggerDeviationBps) {
    return deny("Spot breakout trigger not crossed or price has moved too far");
  }
  if (signal.maxSlippageBps !== null && policy.assumedSlippageBpsPerSide > signal.maxSlippageBps) {
    return deny("Paper slippage assumption exceeds the signal limit");
  }
  if (available <= 0 || exposure >= amount(policy.maxTotalExposureQuote)) {
    return deny("No paper funds or aggregate exposure allowance remains");
  }
  const dailyRemaining = amount(policy.maxDailyLossQuote) - Math.max(0, -pnlToday) - openRisk;
  const openRiskRemaining = amount(policy.maxOpenRiskQuote) - openRisk;
  const riskBudget = Math.min(
    amount(policy.maxPerIdeaRiskQuote),
    signal.riskBudgetQuote === null ? Number.POSITIVE_INFINITY : amount(signal.riskBudgetQuote),
    dailyRemaining,
    openRiskRemaining,
  );
  if (!(riskBudget > 0)) return deny("Daily loss or total open-stop risk limit reached");
  const increment = market.quantityIncrement;
  if (increment === null || market.priceIncrement === null) {
    return deny("Missing exchange instrument precision");
  }
  const decimals = increment.split(".")[1]?.length ?? 0;
  const step = amount(increment);
  if (decimals > 8 || !(step > 0) || step > 1e6) {
    return deny("Unsupported quantity precision for research-only paper preview");
  }

  const slippage = policy.assumedSlippageBpsPerSide / 10_000;
  const fee = policy.assumedFeeBpsPerSide / 10_000;
  const entry = ask * (1 + slippage);
  const stopFill = stop * (1 - slippage);
  if (stop >= ask || !(stopFill > 0 && stopFill < entry)) {
    return deny("Stop-loss must be beneath the assumed entry after trading costs");
  }
  const lossPerUnit = entry - stopFill + fee * (entry + stopFill);
  const exposureRemaining = amount(policy.maxTotalExposureQuote) - exposure;
  const unrounded = Math.min(
    riskBudget / lossPerUnit,
    available / entry,
    exposureRemaining / entry,
  );
  if (!Number.isFinite(unrounded) || unrounded <= 0) return deny("No valid paper size");
  const units = Math.floor(unrounded / step + 1e-10);
  const qty = Number((units * step).toFixed(decimals));
  if (!(qty > 0) || !Number.isFinite(qty)) return deny("Paper size below quantity increment");
  const entryNotional = qty * entry;
  const estimatedStopLoss = qty * stopFill;
  const cost = qty * (entry - ask + (stop - stopFill) + fee * (entry + stopFill));
  const risk = qty * lossPerUnit;
  if (
    ![entryNotional, estimatedStopLoss, cost, risk].every(Number.isFinite) ||
    entryNotional > available + 1e-7 ||
    entryNotional > exposureRemaining + 1e-7 ||
    risk > riskBudget + 1e-7
  ) {
    return deny("Paper amount breaches available funds or independent risk caps");
  }
  if (market.minNotional !== null && entryNotional < amount(market.minNotional)) {
    return deny("Paper amount falls below minimum market notional");
  }
  return TradingPaperAssessmentSchema.parse({
    status: "paper_preview",
    mode: "paper_only",
    signalId: signal.signalId,
    symbol: market.symbol,
    quantityBase: qty.toFixed(decimals),
    assumedEntryQuote: String(entry),
    estimatedStopProceedsQuote: String(estimatedStopLoss),
    worstCaseStopRiskQuote: String(risk),
    assumedRoundTripCostQuote: String(cost),
    estimatedNotionalQuote: String(entryNotional),
    expiresAt: signal.expiresAt,
  });
}
