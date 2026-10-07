import type { TradingResolvedResearchEnvelope } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  assessResolvedTradingResearch,
  resolvedTradingResearchApprovalScope,
} from "./trading-resolved-research.js";

const market = {
  venue: "okx",
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

const provenance = {
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
  skill: {
    marketEntryId: "market-entry-1",
    marketKey: "ccxt-market",
    sourceDigest: "b".repeat(64),
    variant: "original",
  },
  resolvedAt: "2026-10-07T20:00:00.000Z",
} as const;

function proposal(expiresAt = "2026-10-07T21:00:00.000Z"): TradingResolvedResearchEnvelope {
  return {
    schemaVersion: "trading-resolved-research-v1",
    mode: "research_only",
    executionAuthority: "none",
    provenance,
    signal: {
      kind: "proposal",
      signalId: "signal-1",
      strategyId: "resolver-strategy",
      strategyVersion: "2",
      createdAt: "2026-10-07T20:00:00.000Z",
      expiresAt,
      evidenceIds: ["evidence-1"],
      executionStatus: "research_only",
      market,
      action: "spot_buy",
      entryTrigger: "140",
      stopLoss: "136",
      takeProfit: ["145"],
      invalidation: "Price closes below support",
      rationale: "Fixture",
      riskBudgetQuote: null,
      maxSlippageBps: null,
    },
  };
}

describe("resolved trading research boundary", () => {
  it("pins Resolver, Skill and strategy identity without signal price levels", () => {
    const scope = resolvedTradingResearchApprovalScope(proposal());
    expect(scope).toEqual({
      schemaVersion: "trading-resolved-research-scope-v1",
      semanticKey: "market.data",
      resolverKey: "resolver:market.data@1",
      resolverDigest: "a".repeat(64),
      implementationReference: "ccxt/ccxt",
      skillSourceDigest: "b".repeat(64),
      strategyId: "resolver-strategy",
      strategyVersion: "2",
    });
    expect(scope).not.toHaveProperty("entryTrigger");
    expect(scope).not.toHaveProperty("riskBudgetQuote");
    expect(scope).not.toHaveProperty("executionAuthority");
  });

  it("returns a proposal only while the normalized research signal is still fresh", () => {
    expect(
      assessResolvedTradingResearch(proposal(), new Date("2026-10-07T20:30:00.000Z")).status,
    ).toBe("proposal");
    expect(
      assessResolvedTradingResearch(
        proposal("2026-10-07T20:30:00.000Z"),
        new Date("2026-10-07T20:30:00.000Z"),
      ).status,
    ).toBe("expired");
  });

  it("keeps explicit NO_TRADE as an abstention and never upgrades it to a proposal", () => {
    const envelope: TradingResolvedResearchEnvelope = {
      ...proposal(),
      signal: {
        kind: "no_trade",
        signalId: "signal-no-trade",
        strategyId: "resolver-strategy",
        strategyVersion: "2",
        createdAt: "2026-10-07T20:00:00.000Z",
        expiresAt: "2026-10-07T21:00:00.000Z",
        evidenceIds: ["evidence-1"],
        reason: "No candidate passed the research filters.",
      },
    };
    const result = assessResolvedTradingResearch(
      envelope,
      new Date("2026-10-07T20:30:00.000Z"),
    );
    expect(result.status).toBe("no_trade");
    expect(result.signal.kind).toBe("no_trade");
  });

  it("fails before returning a scope for non-read-only Resolver provenance or an invalid clock", () => {
    expect(() =>
      assessResolvedTradingResearch(
        {
          ...proposal(),
          provenance: {
            ...provenance,
            implementation: { ...provenance.implementation, readOnly: false },
          },
        },
        new Date("2026-10-07T20:30:00.000Z"),
      ),
    ).toThrow();

    expect(() => assessResolvedTradingResearch(proposal(), new Date("invalid"))).toThrow(
      "Invalid resolved trading research clock",
    );
  });
});
