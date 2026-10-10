import type { TradingResolvedResearchEnvelope } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  assessResolvedTradingResearch,
  buildTradingResolvedResearchEnvelope,
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

describe("Market pinned provenance bridge", () => {
  it("maps the exact read-only Market provenance into a research-only Trading envelope", () => {
    const signal = proposal().signal;
    const built = buildTradingResolvedResearchEnvelope(provenance, signal);

    expect(built).toEqual({
      schemaVersion: "trading-resolved-research-v1",
      mode: "research_only",
      executionAuthority: "none",
      provenance,
      signal,
    });
  });

  it("fails closed instead of truncating wider Market keys or accepting write-capable routes", () => {
    expect(() =>
      buildTradingResolvedResearchEnvelope(
        { ...provenance, resolverKey: "r".repeat(201) },
        proposal().signal,
      ),
    ).toThrow();

    expect(() =>
      buildTradingResolvedResearchEnvelope(
        {
          ...provenance,
          implementation: { ...provenance.implementation, readOnly: false },
        },
        proposal().signal,
      ),
    ).toThrow();
  });
});

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
      venue: "okx",
      marketKind: "spot",
      action: "spot_buy",
    });
    expect(scope).not.toHaveProperty("entryTrigger");
    expect(scope).not.toHaveProperty("riskBudgetQuote");
    expect(scope).not.toHaveProperty("executionAuthority");
  });

  it("pins selected RCCL / wrapped / hybrid instructions in a new owner approval scope", () => {
    const baseline = proposal();
    const digest = "c".repeat(64);
    const adapted = {
      ...baseline,
      provenance: {
        ...baseline.provenance,
        skill: {
          ...provenance.skill,
          variant: "rccl" as const,
          contentSha256: digest,
        },
      },
    };
    const scope = resolvedTradingResearchApprovalScope(adapted);
    expect(scope).toMatchObject({
      schemaVersion: "trading-resolved-research-scope-v2",
      skillSourceDigest: provenance.skill.sourceDigest,
      skillVariant: "rccl",
      skillContentSha256: digest,
    });

    const wrapped = resolvedTradingResearchApprovalScope({
      ...adapted,
      provenance: {
        ...adapted.provenance,
        skill: { ...adapted.provenance.skill, variant: "wrapped" },
      },
    });
    const edited = resolvedTradingResearchApprovalScope({
      ...adapted,
      provenance: {
        ...adapted.provenance,
        skill: { ...adapted.provenance.skill, contentSha256: "d".repeat(64) },
      },
    });
    expect(wrapped).not.toEqual(scope);
    expect(edited).not.toEqual(scope);
  });

  it("refuses to downgrade an adapted Skill to an old source-only PAPER approval", () => {
    const baseline = proposal();
    expect(() =>
      resolvedTradingResearchApprovalScope({
        ...baseline,
        provenance: {
          ...baseline.provenance,
          skill: { ...provenance.skill, variant: "rccl" },
        },
      }),
    ).toThrow("lacks pinned instruction content digest");

    // Legacy original-Skill v1 scopes remain unchanged for historical replay.
    expect(resolvedTradingResearchApprovalScope(baseline).schemaVersion).toBe(
      "trading-resolved-research-scope-v1",
    );
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
    const result = assessResolvedTradingResearch(envelope, new Date("2026-10-07T20:30:00.000Z"));
    expect(result.status).toBe("no_trade");
    expect(result.signal.kind).toBe("no_trade");
    expect(result.scope).toMatchObject({
      venue: null,
      marketKind: null,
      action: null,
    });
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
