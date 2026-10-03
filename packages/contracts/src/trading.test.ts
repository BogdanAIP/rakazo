import { describe, expect, it } from "vitest";
import { TradingInstrumentSchema, TradingSignalSchema, TradingTickerSchema } from "./trading.js";

const spot = {
  venue: "bingx",
  kind: "spot",
  symbol: "SOL-USDT",
  base: "SOL",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.01",
  quantityIncrement: "0.001",
  minNotional: "5",
  expiryAt: null,
} as const;
const base = {
  signalId: "signal-test",
  strategyId: "offline-baseline",
  strategyVersion: "1",
  createdAt: "2026-10-03T10:00:00.000Z",
  expiresAt: "2026-10-03T10:05:00.000Z",
  evidenceIds: ["snapshot-test"],
};

describe("trading contracts (research-only)", () => {
  it("models active altcoin spot and distinguishes futures expiry", () => {
    expect(TradingInstrumentSchema.parse(spot).symbol).toBe("SOL-USDT");
    expect(
      TradingInstrumentSchema.safeParse({
        ...spot,
        kind: "dated_future",
        expiryAt: null,
      }).success,
    ).toBe(false);
    expect(
      TradingInstrumentSchema.safeParse({
        ...spot,
        kind: "perpetual",
        expiryAt: null,
      }).success,
    ).toBe(true);
  });

  it("rejects missing/non-finite/negative precision and malformed tickers", () => {
    expect(TradingInstrumentSchema.safeParse({ ...spot, priceIncrement: "0" }).success).toBe(false);
    expect(TradingInstrumentSchema.safeParse({ ...spot, priceIncrement: "Infinity" }).success).toBe(false);
    expect(TradingTickerSchema.safeParse({
      venue: "bingx",
      kind: "spot",
      symbol: "SOL-USDT",
      observedAt: "2026-10-03T10:00:00.000Z",
      fetchedAt: "2026-10-03T10:00:00.000Z",
      bid: "-1",
      ask: "10",
      quoteVolume24h: "100000",
    }).success).toBe(false);
  });

  it("accepts NO_TRADE and requires a forward expiration", () => {
    const abstain = { ...base, kind: "no_trade", reason: "Data are stale" };
    expect(TradingSignalSchema.parse(abstain).kind).toBe("no_trade");
    expect(TradingSignalSchema.safeParse({ ...abstain, expiresAt: base.createdAt }).success).toBe(false);
    expect(TradingSignalSchema.safeParse({ ...abstain, evidenceIds: [] }).success).toBe(false);
  });

  it("never models an AI proposal as an executable order", () => {
    const proposal = {
      ...base,
      kind: "proposal",
      executionStatus: "research_only",
      market: spot,
      action: "spot_buy",
      entryTrigger: "140",
      stopLoss: "136",
      takeProfit: ["145", "150"],
      invalidation: "Price closes below support",
      riskBudgetQuote: "10",
      maxSlippageBps: 25,
    };
    expect(TradingSignalSchema.parse(proposal).kind).toBe("proposal");
    expect(TradingSignalSchema.safeParse({ ...proposal, executionStatus: "live" }).success).toBe(false);
    expect(TradingSignalSchema.safeParse({ ...proposal, action: "short" }).success).toBe(false);
    expect(TradingSignalSchema.safeParse({ ...proposal, maxSlippageBps: -1 }).success).toBe(false);
  });
});
