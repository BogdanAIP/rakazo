import type {
  MarketResolverImplementation,
  MarketResolverPlan,
  MarketResolverSkillLink,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  MarketResolverSelectionIntegrityError,
  selectMarketResolverReadOnlyImplementation,
} from "./market-resolver-selection.js";

const digest = (character: string) => character.repeat(64);

const resolvedSkill = (
  overrides: Partial<Extract<MarketResolverSkillLink, { status: "resolved" }>> = {},
): Extract<MarketResolverSkillLink, { status: "resolved" }> => ({
  status: "resolved",
  entryId: "market-skill-1",
  key: "okx/agent-trade-kit:skills/okx-cex-market/SKILL.md@abc",
  name: "okx-cex-market",
  repository: "okx/agent-trade-kit",
  digest: digest("b"),
  variant: "original",
  tags: ["trading", "research-ready", "market-data"],
  ...overrides,
});

const implementation = (
  overrides: Partial<MarketResolverImplementation> = {},
): MarketResolverImplementation => ({
  name: "Public API",
  kind: "api",
  reference: "vendor:public-api",
  skillReference: null,
  priority: 1,
  readOnly: true,
  constraints: ["public data only"],
  skill: null,
  ...overrides,
});

const plan = (
  candidates: MarketResolverImplementation[],
  preferred: MarketResolverImplementation | null = candidates[0] ?? null,
): MarketResolverPlan => ({
  resolver: {
    entryId: "market-resolver-1",
    key: "market.data@abc",
    digest: digest("a"),
    semanticKey: "market.data",
  },
  preferred,
  candidates,
});

describe("selectMarketResolverReadOnlyImplementation", () => {
  it("selects a direct read-only route without inventing Skill provenance", () => {
    const candidate = implementation();

    expect(selectMarketResolverReadOnlyImplementation(plan([candidate]))).toEqual({
      status: "ready",
      resolver: plan([candidate]).resolver,
      implementation: {
        name: "Public API",
        kind: "api",
        reference: "vendor:public-api",
        skillReference: null,
        priority: 1,
        readOnly: true,
        constraints: ["public data only"],
      },
      skill: null,
      skipped: [],
    });
  });

  it("follows deterministic fallback order and requires exact Market Skill provenance", () => {
    const privateFirst = implementation({
      name: "Private trading API",
      reference: "vendor:private",
      priority: 1,
      readOnly: false,
    });
    const missingSkill = implementation({
      name: "Missing Market Skill",
      reference: "market:okx/agent-trade-kit:missing-skill",
      priority: 2,
      skill: { status: "missing" },
    });
    const usable = implementation({
      name: "OKX CEX Market Skill",
      reference: "market:okx/agent-trade-kit:okx-cex-market",
      priority: 3,
      skill: resolvedSkill(),
    });

    expect(
      selectMarketResolverReadOnlyImplementation(
        plan([privateFirst, missingSkill, usable], privateFirst),
      ),
    ).toEqual({
      status: "ready",
      resolver: plan([privateFirst, missingSkill, usable], privateFirst).resolver,
      implementation: {
        name: "OKX CEX Market Skill",
        kind: "api",
        reference: "market:okx/agent-trade-kit:okx-cex-market",
        skillReference: null,
        priority: 3,
        readOnly: true,
        constraints: ["public data only"],
      },
      skill: resolvedSkill(),
      skipped: [
        {
          name: "Private trading API",
          reference: "vendor:private",
          priority: 1,
          reason: "implementation_not_read_only",
        },
        {
          name: "Missing Market Skill",
          reference: "market:okx/agent-trade-kit:missing-skill",
          priority: 2,
          reason: "market_skill_missing",
        },
      ],
    });
  });

  it("fails closed when all Market Skill links are unresolved", () => {
    const missing = implementation({
      name: "Missing",
      reference: "market:ccxt/ccxt:ccxt-mcp",
      priority: 1,
      skill: { status: "missing" },
    });
    const ambiguous = implementation({
      name: "Ambiguous",
      reference: "ccxt/ccxt",
      skillReference: "market:ccxt/ccxt:ccxt-mcp",
      priority: 2,
      skill: { status: "ambiguous", matches: 2 },
    });

    expect(selectMarketResolverReadOnlyImplementation(plan([missing, ambiguous]))).toEqual({
      status: "deny",
      resolver: plan([missing, ambiguous]).resolver,
      reason: "no_eligible_read_only_implementation",
      skipped: [
        {
          name: "Missing",
          reference: "market:ccxt/ccxt:ccxt-mcp",
          priority: 1,
          reason: "market_skill_missing",
        },
        {
          name: "Ambiguous",
          reference: "ccxt/ccxt",
          priority: 2,
          reason: "market_skill_ambiguous",
          matches: 2,
        },
      ],
    });
  });

  it("rejects a preferred implementation that disagrees with deterministic resolver order", () => {
    const first = implementation({ name: "First", reference: "a", priority: 1 });
    const second = implementation({ name: "Second", reference: "b", priority: 2 });

    expect(() => selectMarketResolverReadOnlyImplementation(plan([first, second], second))).toThrow(
      MarketResolverSelectionIntegrityError,
    );
  });

  it("rejects unexpected Market Skill provenance on a non-Market route", () => {
    const candidate = implementation({
      reference: "ccxt/ccxt",
      skill: resolvedSkill({ repository: "ccxt/ccxt", name: "ccxt-mcp" }),
    });

    expect(() => selectMarketResolverReadOnlyImplementation(plan([candidate]))).toThrow(
      "unexpectedly carries Market Skill provenance",
    );
  });
});
