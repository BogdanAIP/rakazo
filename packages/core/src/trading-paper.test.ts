import {
  TradingInstrumentSchema,
  TradingPaperAssessmentInputSchema,
  TradingSignalSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { evaluateTradingPaperRisk } from "./trading-paper.js";

const now = "2026-10-03T10:01:00.000Z";
const market = TradingInstrumentSchema.parse({
  venue: "okx",
  kind: "spot",
  symbol: "SOL-USDT",
  base: "SOL",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.01",
  quantityIncrement: "0.01",
  minNotional: "5",
  expiryAt: null,
});
const signal = TradingSignalSchema.parse({
  kind: "proposal",
  executionStatus: "research_only",
  signalId: "synthetic-breakout-1",
  strategyId: "example-only",
  strategyVersion: "1",
  createdAt: "2026-10-03T10:00:30.000Z",
  expiresAt: "2026-10-03T10:05:00.000Z",
  evidenceIds: ["offline-test-candle"],
  market,
  action: "spot_buy",
  entryTrigger: "100",
  stopLoss: "95",
  takeProfit: ["110"],
  invalidation: "Close beneath the preceding range",
  rationale: "Synthetic test, not a current trade recommendation",
  riskBudgetQuote: null,
  maxSlippageBps: null,
});
const policy = {
  mode: "paper_only",
  enabled: true,
  killSwitch: false,
  allowedVenues: ["okx"],
  quoteCurrency: "USDT",
  maxAgeMs: 60_000,
  maxSpreadBps: 40,
  maxTriggerDeviationBps: 50,
  maxPositions: 2,
  maxPerIdeaRiskQuote: "20",
  maxDailyLossQuote: "100",
  maxOpenRiskQuote: "40",
  maxTotalExposureQuote: "1500",
  assumedFeeBpsPerSide: 10,
  assumedSlippageBpsPerSide: 10,
};
const portfolio = {
  snapshotAt: now,
  quoteCurrency: "USDT",
  availableQuoteBalance: "1000",
  realizedPnlTodayQuote: "-10",
  openStopRiskQuote: "5",
  openExposureQuote: "400",
  openPositions: 1,
};
const quote = { bid: "100", ask: "100.1", observedAt: now };
const assess = (change: Record<string, unknown> = {}) =>
  evaluateTradingPaperRisk(
    TradingPaperAssessmentInputSchema.parse({
      now,
      policy,
      portfolio,
      signal,
      observedQuote: quote,
      ...change,
    }),
  );

describe("inert independent paper risk preview", () => {
  it("previews a bounded, lot-rounded spot altcoin size, without an order credential", () => {
    const result = assess();
    expect(result.status).toBe("paper_preview");
    if (result.status !== "paper_preview") throw new Error("Expected preview");
    expect(result.mode).toBe("paper_only");
    expect(result.symbol).toBe("SOL-USDT");
    expect(Number(result.quantityBase)).toBeGreaterThan(0);
    expect(Number(result.estimatedNotionalQuote)).toBeLessThanOrEqual(1000);
    expect(Number(result.worstCaseStopRiskQuote)).toBeLessThanOrEqual(20 + 1e-7);
    expect(Number(result.assumedRoundTripCostQuote)).toBeGreaterThan(0);
    expect(result.expiresAt).toBe(signal.expiresAt);
    expect("orderId" in result || "apiKey" in result || "submit" in result).toBe(false);
  });

  it("defaults to denial when disabled, killed or fed NO_TRADE", () => {
    expect(assess({ policy: { ...policy, enabled: false } }).status).toBe("deny");
    expect(assess({ policy: { ...policy, killSwitch: true } }).status).toBe("deny");
    const noTrade = TradingSignalSchema.parse({
      kind: "no_trade",
      signalId: "synthetic-abstain",
      strategyId: signal.strategyId,
      strategyVersion: signal.strategyVersion,
      createdAt: signal.createdAt,
      expiresAt: signal.expiresAt,
      evidenceIds: signal.evidenceIds,
      reason: "No reliable entry",
    });
    expect(assess({ signal: noTrade }).status).toBe("deny");
  });

  it("rejects expired, stale, non-triggered and excessively deviated quotes", () => {
    expect(
      assess({ now: "2026-10-03T10:05:01.000Z", portfolio: { ...portfolio,
        snapshotAt: "2026-10-03T10:05:01.000Z" } }).status,
    ).toBe("deny");
    expect(assess({ observedQuote: { ...quote, observedAt: "2026-10-03T09:00:00.000Z" } }).status)
      .toBe("deny");
    expect(assess({ observedQuote: { ...quote, bid: "99", ask: "99.1" } }).status).toBe("deny");
    expect(assess({ observedQuote: { ...quote, bid: "110", ask: "110.1" } }).status).toBe("deny");
    expect(assess({ observedQuote: { ...quote, bid: "100", ask: "102" } }).status).toBe("deny");
  });

  it("enforces open position, daily loss, aggregate risk and cash constraints", () => {
    expect(assess({ portfolio: { ...portfolio, openPositions: 2 } }).status).toBe("deny");
    expect(assess({ portfolio: { ...portfolio, realizedPnlTodayQuote: "-100" } }).status).toBe(
      "deny",
    );
    expect(assess({ portfolio: { ...portfolio, openStopRiskQuote: "40" } }).status).toBe("deny");
    expect(assess({ portfolio: { ...portfolio, availableQuoteBalance: "0" } }).status).toBe("deny");
    expect(assess({ portfolio: { ...portfolio, openExposureQuote: "1500" } }).status).toBe("deny");
    expect(assess({ policy: { ...policy, maxPerIdeaRiskQuote: "0.01" } }).status).toBe("deny");
  });

  it("never previews futures or unsupported instrument/quote mismatch", () => {
    const future = TradingSignalSchema.parse({
      ...signal,
      action: "long",
      market: { ...market, kind: "perpetual", symbol: "SOL-USDT-SWAP" },
    });
    expect(assess({ signal: future }).status).toBe("deny");
    expect(assess({ policy: { ...policy, allowedVenues: ["bingx"] } }).status).toBe("deny");
    expect(assess({ portfolio: { ...portfolio, quoteCurrency: "USDC" } }).status).toBe("deny");
  });

  it("does not let AI's requested risk/slippage override configured independent limits", () => {
    const narrow = TradingSignalSchema.parse({
      ...signal,
      riskBudgetQuote: "5",
    });
    const lower = assess({ signal: narrow });
    expect(lower.status).toBe("paper_preview");
    if (lower.status === "paper_preview") {
      expect(Number(lower.worstCaseStopRiskQuote)).toBeLessThanOrEqual(5 + 1e-7);
    }
    const veryLowSlippage = TradingSignalSchema.parse({ ...signal, maxSlippageBps: 1 });
    expect(assess({ signal: veryLowSlippage }).status).toBe("deny");
  });
});
