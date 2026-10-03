import {
  TradingCandleSchema,
  TradingResearchOutputSchema,
  TradingSignalSchema,
  type TradingCandle,
  type TradingInstrument,
  type TradingResearchOutput,
} from "@rakazo/contracts";

const HOUR = 3_600_000;
const LOOKBACK = 20;
const MAX_AGE_MS = HOUR;
const STRATEGY = "breakout_20_1h_v1";

type ResearchInput = {
  market: TradingInstrument;
  candles: readonly TradingCandle[];
  fetchedAt: string;
  now: Date;
};

/**
 * A deterministic RESEARCH BASELINE, not an established profitable strategy.
 * It considers only closed, contiguous history; latest bar is never included
 * in its own prior 20-bar breakout threshold. No account or execution access.
 */
export function researchClosedHourBreakout(input: ResearchInput): TradingResearchOutput {
  const { market, candles, fetchedAt, now } = input;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new Error("Invalid research clock");
  }
  const createdAt = now.toISOString();
  const latest = candles.at(-1);
  const latestOpened = latest ? Date.parse(latest.openedAt) : Number.NaN;
  const closedAt = Number.isFinite(latestOpened) ? latestOpened + HOUR : null;
  const evidenceId = "okx:" + market.symbol + ":1H:" + (latest?.openedAt ?? "no-bars");
  const resultBase = {
    algorithm: STRATEGY as const,
    venue: "okx" as const,
    market,
    fetchedAt,
    candleCount: candles.length,
    latestClosedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
  };
  const expiry = new Date(nowMs + 30 * 60_000).toISOString();
  const noTrade = (reason: string): TradingResearchOutput =>
    TradingResearchOutputSchema.parse({
      ...resultBase,
      signal: TradingSignalSchema.parse({
        kind: "no_trade",
        signalId: evidenceId + ":abstain",
        strategyId: STRATEGY,
        strategyVersion: "1",
        createdAt,
        expiresAt: expiry,
        evidenceIds: [evidenceId],
        reason,
      }),
    });

  if (market.venue !== "okx" || market.status !== "active") {
    return noTrade("The venue/instrument is unavailable or inactive.");
  }
  if (market.kind !== "spot" && market.kind !== "perpetual") {
    return noTrade("The baseline is not validated for this contract type.");
  }
  if (market.expiryAt !== null) return noTrade("Unexpected expiry on a non-dated instrument.");
  if (Date.parse(fetchedAt) > nowMs + 2_000 || nowMs - Date.parse(fetchedAt) > 60_000) {
    return noTrade("Market history fetch time is stale or in the future.");
  }
  if (candles.length < LOOKBACK + 1 || candles.length > 100) {
    return noTrade("At least 21 and at most 100 confirmed 1H bars are required.");
  }

  // Only the most recent 21 bars matter; check identity, schema, contiguity,
  // completion and data sanity before doing any arithmetic.
  const window = candles.slice(-(LOOKBACK + 1));
  for (let i = 0; i < window.length; i++) {
    const bar = window[i];
    if (!bar || !TradingCandleSchema.safeParse(bar).success) {
      return noTrade("Malformed or unconfirmed candle.");
    }
    if (bar.venue !== market.venue || bar.kind !== market.kind || bar.symbol !== market.symbol) {
      return noTrade("Market/candle identity mismatch.");
    }
    const opened = Date.parse(bar.openedAt);
    if (opened + HOUR > nowMs) return noTrade("An unclosed or future candle was supplied.");
    if (i > 0 && opened - Date.parse(window[i - 1]!.openedAt) !== HOUR) {
      return noTrade("Missing, duplicated or out-of-order 1H bars.");
    }
  }
  if (closedAt === null || closedAt > nowMs || nowMs - closedAt > MAX_AGE_MS) {
    return noTrade("Latest completed candle is too old.");
  }

  const prior = window.slice(0, LOOKBACK);
  const last = window[LOOKBACK]!;
  const averageVolume = prior.reduce((sum, c) => sum + Number(c.quoteVolume), 0) / LOOKBACK;
  const latestVolume = Number(last.quoteVolume);
  const highest = Math.max(...prior.map((c) => Number(c.high)));
  const lowest = Math.min(...prior.map((c) => Number(c.low)));
  const averageRange =
    prior.reduce((sum, c) => sum + Number(c.high) - Number(c.low), 0) / LOOKBACK;
  const close = Number(last.close);
  const tick = Number(market.priceIncrement);
  const digits = market.priceIncrement?.split(".")[1]?.length ?? 0;
  if (
    !Number.isFinite(tick) ||
    tick <= 0 ||
    digits > 8 ||
    !Number.isFinite(averageVolume) ||
    averageVolume <= 0 ||
    !Number.isFinite(averageRange) ||
    averageRange <= 0 ||
    !Number.isFinite(close)
  ) {
    return noTrade("Invalid price precision or insufficient historical liquidity.");
  }
  if (latestVolume < averageVolume * 1.5) {
    return noTrade("The latest confirmed volume does not pass the 1.5x research filter.");
  }

  const bullish = close > highest + tick;
  const bearish = close < lowest - tick;
  if (!bullish && !bearish) return noTrade("No confirmed close outside the previous 20-bar range.");
  if (bearish && market.kind === "spot") {
    return noTrade("Bearish breakout has no approved short-selling route on spot.");
  }

  const rounding = (value: number, direction: "up" | "down"): string => {
    const units = direction === "up"
      ? Math.ceil(value / tick - 1e-9)
      : Math.floor(value / tick + 1e-9);
    return (units * tick).toFixed(digits);
  };
  // Illustrative price levels only; sizing/slippage require authorized account
  // and depth data, and must not be silently supplied by the LLM.
  const buffer = Math.max(averageRange * 1.5, close * 0.01);
  const long = bullish;
  const entry = Number(rounding(close, long ? "up" : "down"));
  const stop = Number(rounding(close + (long ? -buffer : buffer), long ? "down" : "up"));
  const target = Number(
    rounding(entry + (long ? 1 : -1) * 2 * Math.abs(entry - stop), long ? "up" : "down"),
  );
  if (
    ![entry, stop, target].every((value) => Number.isFinite(value) && value > 0) ||
    (long && !(stop < entry && entry < target)) ||
    (!long && !(target < entry && entry < stop))
  ) {
    return noTrade("Risk/target research levels cannot be represented at exchange tick precision.");
  }
  const action = long ? (market.kind === "spot" ? "spot_buy" : "long") : "short";
  const signal = TradingSignalSchema.parse({
    kind: "proposal",
    executionStatus: "research_only",
    signalId: evidenceId + (long ? ":up" : ":down"),
    strategyId: STRATEGY,
    strategyVersion: "1",
    createdAt,
    expiresAt: new Date(Math.min(nowMs + 30 * 60_000, closedAt + HOUR)).toISOString(),
    evidenceIds: [evidenceId],
    market,
    action,
    entryTrigger: rounding(entry, long ? "up" : "down"),
    stopLoss: rounding(stop, long ? "down" : "up"),
    takeProfit: [rounding(target, long ? "up" : "down")],
    invalidation: "Cancel if the price returns into the previous 20-bar range or the signal expires.",
    rationale: "Illustrative 1H closed-candle breakout with a 20-bar prior range and 1.5x " +
      "quote-volume filter. This is an unvalidated baseline, not an expected-profit estimate.",
    riskBudgetQuote: null,
    maxSlippageBps: null,
  });
  return TradingResearchOutputSchema.parse({ ...resultBase, signal });
}
