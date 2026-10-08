import type {
  MarketEntry,
  MarketResolverImplementation,
  MarketResolverPlan,
  MarketResolverSkillLink,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  MarketResolverSelectionIntegrityError,
  pinMarketResolverResearchProvenance,
  readPinnedMarketResolverSkillContent,
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


const marketSkillEntry = (overrides: Partial<MarketEntry> = {}): MarketEntry => ({
  id: "market-skill-1",
  kind: "skill",
  key: "okx/agent-trade-kit:skills/okx-cex-market/SKILL.md@abc",
  name: "okx-cex-market",
  description: "Read-only market data Skill.",
  tags: ["trading", "research-ready", "market-data"],
  originalContent: "---\nname: okx-cex-market\ndescription: Read market data.\n---\nOriginal.",
  adaptedContent: null,
  adaptationMode: null,
  preferredVariant: "original",
  sourceUrl: "https://github.com/okx/agent-trade-kit/blob/" + "c".repeat(40) + "/SKILL.md",
  repository: "okx/agent-trade-kit",
  sourcePath: "skills/okx-cex-market/SKILL.md",
  sourceRef: "c".repeat(40),
  license: "MIT",
  digest: digest("b"),
  trust: "curated",
  metrics: {},
  metadata: {},
  createdAt: "2026-10-08T07:00:00.000Z",
  updatedAt: "2026-10-08T07:00:00.000Z",
  ...overrides,
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


describe("readPinnedMarketResolverSkillContent", () => {
  it("reads exactly the selected original Skill without installing it", () => {
    const skill = resolvedSkill();
    const candidate = implementation({
      name: "OKX CEX Market Skill",
      reference: "market:okx/agent-trade-kit:okx-cex-market",
      skill,
    });
    const selection = selectMarketResolverReadOnlyImplementation(plan([candidate]));
    const entry = marketSkillEntry();

    expect(readPinnedMarketResolverSkillContent(selection, entry)).toEqual({
      entry,
      content: entry.originalContent,
      variant: "original",
    });
  });

  it("reads only the exact pinned adapted variant", () => {
    const skill = resolvedSkill({ variant: "rccl" });
    const candidate = implementation({
      name: "OKX CEX Market Skill",
      reference: "market:okx/agent-trade-kit:okx-cex-market",
      skill,
    });
    const selection = selectMarketResolverReadOnlyImplementation(plan([candidate]));
    const entry = marketSkillEntry({
      preferredVariant: "rccl",
      adaptationMode: "rccl",
      adaptedContent:
        "---\nname: okx-cex-market\ndescription: Read market data.\n---\nRCCL adapted.",
    });

    expect(readPinnedMarketResolverSkillContent(selection, entry)).toMatchObject({
      content: entry.adaptedContent,
      variant: "rccl",
    });
  });

  it("fails closed when the selected Skill revision or preferred variant changed", () => {
    const skill = resolvedSkill();
    const candidate = implementation({
      reference: "market:okx/agent-trade-kit:okx-cex-market",
      skill,
    });
    const selection = selectMarketResolverReadOnlyImplementation(plan([candidate]));

    expect(() =>
      readPinnedMarketResolverSkillContent(
        selection,
        marketSkillEntry({ digest: digest("d") }),
      ),
    ).toThrow("Market Skill entry changed after Resolver selection");
    expect(() =>
      readPinnedMarketResolverSkillContent(
        selection,
        marketSkillEntry({
          preferredVariant: "rccl",
          adaptationMode: "rccl",
          adaptedContent: "adapted",
        }),
      ),
    ).toThrow("Market Skill entry changed after Resolver selection");
  });

  it("rejects direct Resolver routes because no Market Skill was pinned", () => {
    const selection = selectMarketResolverReadOnlyImplementation(plan([implementation()]));
    expect(() =>
      readPinnedMarketResolverSkillContent(selection, marketSkillEntry()),
    ).toThrow("Resolver selection does not pin a Market Skill");
  });
});

describe("pinMarketResolverResearchProvenance", () => {
  it("pins exact Resolver and Market Skill provenance without carrying invocation data", () => {
    const candidate = implementation({
      name: "OKX CEX Market Skill",
      kind: "api",
      reference: "market:okx/agent-trade-kit:okx-cex-market",
      skillReference: "market:okx/agent-trade-kit:okx-cex-market",
      priority: 3,
      constraints: ["public data only", "spot only"],
      notes: "research",
      skill: resolvedSkill(),
    });
    const selection = selectMarketResolverReadOnlyImplementation(plan([candidate]));
    const resolvedAt = "2026-10-08T08:00:00.000Z";

    expect(pinMarketResolverResearchProvenance(selection, resolvedAt)).toEqual({
      semanticKey: "market.data",
      resolverKey: "market.data@abc",
      resolverDigest: digest("a"),
      implementation: {
        name: "OKX CEX Market Skill",
        kind: "api",
        reference: "market:okx/agent-trade-kit:okx-cex-market",
        priority: 3,
        readOnly: true,
      },
      skill: {
        marketEntryId: "market-skill-1",
        marketKey: "okx/agent-trade-kit:skills/okx-cex-market/SKILL.md@abc",
        sourceDigest: digest("b"),
        variant: "original",
      },
      resolvedAt,
    });
  });

  it("pins a direct read-only route without inventing Skill provenance", () => {
    const selection = selectMarketResolverReadOnlyImplementation(plan([implementation()]));

    expect(
      pinMarketResolverResearchProvenance(selection, "2026-10-08T08:00:00.000Z"),
    ).toMatchObject({
      semanticKey: "market.data",
      implementation: {
        reference: "vendor:public-api",
        readOnly: true,
      },
      skill: null,
    });
  });

  it("rejects denied Resolver selections and invalid resolution timestamps", () => {
    const missing = implementation({
      reference: "market:ccxt/ccxt:ccxt-mcp",
      skill: { status: "missing" },
    });
    const denied = selectMarketResolverReadOnlyImplementation(plan([missing]));

    expect(() =>
      pinMarketResolverResearchProvenance(denied, "2026-10-08T08:00:00.000Z"),
    ).toThrow("Denied Resolver selection cannot produce research provenance");

    const ready = selectMarketResolverReadOnlyImplementation(plan([implementation()]));
    expect(() => pinMarketResolverResearchProvenance(ready, "not-a-date")).toThrow();
  });
});
