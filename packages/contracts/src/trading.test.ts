import { describe, expect, it } from "vitest";
import {
  TradingInstrumentSchema,
  TradingResolvedResearchEnvelopeSchema,
  TradingSignalSchema,
  TradingTickerSchema,
} from "./trading.js";

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
    expect(TradingInstrumentSchema.safeParse({ ...spot, priceIncrement: "Infinity" }).success).toBe(
      false,
    );
    expect(
      TradingTickerSchema.safeParse({
        venue: "bingx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: "2026-10-03T10:00:00.000Z",
        fetchedAt: "2026-10-03T10:00:00.000Z",
        bid: "-1",
        ask: "10",
        quoteVolume24h: "100000",
      }).success,
    ).toBe(false);
  });

  it("accepts NO_TRADE and requires a forward expiration", () => {
    const abstain = { ...base, kind: "no_trade", reason: "Data are stale" };
    expect(TradingSignalSchema.parse(abstain).kind).toBe("no_trade");
    expect(TradingSignalSchema.safeParse({ ...abstain, expiresAt: base.createdAt }).success).toBe(
      false,
    );
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
      rationale: "Synthetic fixture; not a live trading signal.",
      riskBudgetQuote: "10",
      maxSlippageBps: 25,
    };
    expect(TradingSignalSchema.parse(proposal).kind).toBe("proposal");
    expect(TradingSignalSchema.safeParse({ ...proposal, executionStatus: "live" }).success).toBe(
      false,
    );
    expect(TradingSignalSchema.safeParse({ ...proposal, action: "short" }).success).toBe(false);
    expect(TradingSignalSchema.safeParse({ ...proposal, maxSlippageBps: -1 }).success).toBe(false);
  });

  it("accepts a Resolver-selected research proposal without granting execution authority", () => {
    const proposal = {
      ...base,
      kind: "proposal",
      executionStatus: "research_only",
      market: spot,
      action: "spot_buy",
      entryTrigger: "140",
      stopLoss: "136",
      takeProfit: ["145"],
      invalidation: "Price closes below support",
      rationale: "Resolver-selected research fixture.",
      riskBudgetQuote: null,
      maxSlippageBps: null,
    } as const;
    const envelope = {
      schemaVersion: "trading-resolved-research-v1",
      mode: "research_only",
      executionAuthority: "none",
      provenance: {
        semanticKey: "market.data",
        resolverKey: "resolver:market.data@1",
        resolverDigest: "a".repeat(64),
        implementation: {
          name: "CCXT MCP market tier",
          kind: "mcp",
          reference: "ccxt/ccxt",
          priority: 1,
          readOnly: true,
        },
        skill: null,
        resolvedAt: "2026-10-07T20:00:00.000Z",
      },
      signal: proposal,
    } as const;

    expect(TradingResolvedResearchEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      TradingResolvedResearchEnvelopeSchema.safeParse({
        ...envelope,
        executionAuthority: "paper",
      }).success,
    ).toBe(false);
    expect(
      TradingResolvedResearchEnvelopeSchema.safeParse({
        ...envelope,
        provenance: {
          ...envelope.provenance,
          implementation: { ...envelope.provenance.implementation, readOnly: false },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts explicit NO_TRADE from a pinned Market Skill and rejects weak provenance", () => {
    const envelope = {
      schemaVersion: "trading-resolved-research-v1",
      mode: "research_only",
      executionAuthority: "none",
      provenance: {
        semanticKey: "signal.discovery",
        resolverKey: "resolver:signal.discovery@1",
        resolverDigest: "b".repeat(64),
        implementation: {
          name: "Public signal workflow",
          kind: "api",
          reference: "market:ccxt/ccxt:trading-signal",
          priority: 1,
          readOnly: true,
        },
        skill: {
          marketEntryId: "market-entry-1",
          marketKey: "ccxt-trading-signal",
          sourceDigest: "c".repeat(64),
          variant: "original",
        },
        resolvedAt: "2026-10-07T20:00:00.000Z",
      },
      signal: {
        ...base,
        kind: "no_trade",
        reason: "No candidate passed the research filters.",
      },
    } as const;

    expect(TradingResolvedResearchEnvelopeSchema.parse(envelope).signal.kind).toBe("no_trade");
    expect(
      TradingResolvedResearchEnvelopeSchema.safeParse({
        ...envelope,
        provenance: { ...envelope.provenance, resolverDigest: "not-a-digest" },
      }).success,
    ).toBe(false);
    expect(
      TradingResolvedResearchEnvelopeSchema.safeParse({
        ...envelope,
        provenance: {
          ...envelope.provenance,
          skill: { ...envelope.provenance.skill!, sourceDigest: "1234" },
        },
      }).success,
    ).toBe(false);
  });
});
