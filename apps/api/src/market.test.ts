import type { Actor } from "@rakazo/contracts";
import { buildRcclSkillTemplate, buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createMarketService } from "./market.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const sourceRef = "a".repeat(40);

function originalSkill(name = "Research Paper Analysis") {
  return buildSkillMd({
    name,
    description: "Extract evidence from a scientific paper.",
    body: "Read the paper, extract evidence, and report it with citations.",
  });
}

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  kind: string;
  key: string;
  name: string;
  description: string;
  tags: string[];
  originalContent: string;
  adaptedContent: string | null;
  adaptationMode: string | null;
  preferredVariant: string;
  sourceUrl: string;
  repository: string;
  sourcePath: string | null;
  sourceRef: string;
  license: string | null;
  digest: string;
  trust: string;
  metrics: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function setup() {
  const rows: Row[] = [];
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR" && Array.isArray(value)) {
        return value.some(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            matches(row, candidate as Record<string, unknown>),
        );
      }
      const rowValue = row[key as keyof Row];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const filter = value as Record<string, unknown>;
        if (typeof rowValue === "string" && typeof filter.contains === "string") {
          return rowValue.toLowerCase().includes(filter.contains.toLowerCase());
        }
        if (Array.isArray(rowValue) && Array.isArray(filter.hasSome)) {
          return filter.hasSome.some((item) => rowValue.includes(String(item)));
        }
        if (Array.isArray(rowValue) && typeof filter.has === "string") {
          return rowValue.includes(filter.has);
        }
      }
      return rowValue === value;
    });

  const marketEntry = {
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
      rows.filter((row) => matches(row, where)).slice(0, take),
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, where)),
    ),
    create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
      const row: Row = {
        ...data,
        id: "market-" + String(rows.length + 1),
        adaptedContent: data.adaptedContent ?? null,
        adaptationMode: data.adaptationMode ?? null,
        sourcePath: data.sourcePath ?? null,
        license: data.license ?? null,
        createdAt: new Date(rows.length),
        updatedAt: new Date(rows.length),
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((item) => item.id === where.id);
      if (!row) throw new Error("missing row");
      Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
      return row;
    }),
  };

  return {
    rows,
    marketEntry,
    service: createMarketService({ marketEntry } as unknown as PrismaClient),
  };
}

describe("Market Skills + Market Resolver service", () => {
  it("imports a pinned GitHub Skill idempotently and rejects key reuse with changed content", async () => {
    const { service, marketEntry } = setup();
    const input = {
      kind: "skill" as const,
      key: "anthropics/claude-plugins-official:paper-analysis@" + sourceRef,
      tags: ["Research", "papers"],
      content: originalSkill(),
      sourceUrl:
        "https://github.com/anthropics/claude-plugins-official/blob/" +
        sourceRef +
        "/skills/paper-analysis/SKILL.md",
      repository: "anthropics/claude-plugins-official",
      sourcePath: "skills/paper-analysis/SKILL.md",
      sourceRef,
      license: "Apache-2.0",
      trust: "curated" as const,
      metadata: { publisher: "Anthropic" },
    };

    const first = await service.importEntry(actor, input);
    const second = await service.importEntry(actor, input);

    expect(first).toMatchObject({
      kind: "skill",
      name: "Research Paper Analysis",
      preferredVariant: "original",
      trust: "curated",
      repository: "anthropics/claude-plugins-official",
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
    expect(marketEntry.create).toHaveBeenCalledTimes(1);

    await expect(
      service.importEntry(actor, { ...input, content: originalSkill("Changed") }),
    ).rejects.toThrow("different source/provenance");
  });

  it("imports resolver/data batches idempotently without bypassing per-entry validation", async () => {
    const { service, marketEntry } = setup();
    const shared = {
      tags: ["resolver"],
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated" as const,
      metadata: { batch: "resolver-v1" },
    };
    const items = [
      {
        kind: "resolver" as const,
        key: "market.data@" + sourceRef,
        name: "Market data resolver",
        description: "Read-only market data routes.",
        content: JSON.stringify({
          semanticKey: "market.data",
          implementations: [
            {
              name: "Public market data",
              kind: "api",
              reference: "market:test",
              priority: 1,
              readOnly: true,
              constraints: ["read-only"],
            },
          ],
        }),
        sourceUrl:
          "https://github.com/BogdanAIP/rakazo/blob/" +
          sourceRef +
          "/market/resolver-seeds.v1.json",
        ...shared,
      },
      {
        kind: "resolver" as const,
        key: "market.risk@" + sourceRef,
        name: "Market risk resolver",
        description: "Read-only market risk routes.",
        content: JSON.stringify({
          semanticKey: "market.risk",
          implementations: [
            {
              name: "Public risk data",
              kind: "api",
              reference: "market:risk-test",
              priority: 1,
              readOnly: true,
              constraints: ["read-only"],
            },
          ],
        }),
        sourceUrl:
          "https://github.com/BogdanAIP/rakazo/blob/" +
          sourceRef +
          "/market/resolver-seeds.v1.json",
        ...shared,
      },
    ];

    const first = await service.importBatch(actor, items);
    const second = await service.importBatch(actor, items);

    expect(first).toHaveLength(2);
    expect(second.map((entry) => entry.key)).toEqual(first.map((entry) => entry.key));
    expect(first[0]).not.toHaveProperty("originalContent");
    expect(first[0]).not.toHaveProperty("adaptedContent");
    expect(marketEntry.create).toHaveBeenCalledTimes(2);
  });

  it("indexes Resolver knowledge as data rather than executable authority", async () => {
    const { service } = setup();
    const resolver = JSON.stringify({
      semanticKey: "browser.semantic",
      implementations: [
        {
          name: "Playwright MCP",
          kind: "mcp",
          reference: "microsoft/playwright-mcp",
          priority: 1,
          readOnly: false,
          constraints: ["must be installed and authorized"],
        },
        {
          name: "OpenCLI",
          kind: "browser",
          reference: "rakazo:opencli",
          priority: 2,
          constraints: ["requires linked Windows Host"],
        },
      ],
    });

    const entry = await service.importEntry(actor, {
      kind: "resolver",
      key: "browser.semantic@" + sourceRef,
      name: "Browser semantic resolver",
      description: "Preferred implementations for semantic browser work.",
      tags: ["browser"],
      content: resolver,
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/docs/hybrid-computer-use.md",
      repository: "BogdanAIP/rakazo",
      sourcePath: "docs/hybrid-computer-use.md",
      sourceRef,
      license: "AGPL-3.0",
      trust: "curated",
      metadata: {},
    });

    expect(entry.tags).toContain("browser.semantic");
    expect(entry.originalContent).toBe(resolver);
  });

  it("resolves a semantic Market route into a deterministic read-only candidate plan", async () => {
    const { service } = setup();
    const resolver = await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@" + sourceRef,
      name: "Market data resolver",
      description: "Ranked implementations for market data.",
      tags: ["trading", "market-data"],
      content: JSON.stringify({
        semanticKey: "market.data",
        implementations: [
          {
            name: "Private trading API",
            kind: "api",
            reference: "market:private-trading",
            priority: 1,
            readOnly: false,
            constraints: ["private account required"],
          },
          {
            name: "CCXT public market",
            kind: "mcp",
            reference: "ccxt/ccxt",
            priority: 2,
            readOnly: true,
            constraints: ["market tier only"],
          },
          {
            name: "Public fallback",
            kind: "api",
            reference: "market:public-fallback",
            priority: 3,
            readOnly: true,
            constraints: ["public data only"],
          },
        ],
      }),
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated",
      metadata: {},
    });

    await expect(
      service.resolve(actor, {
        semanticKey: "market.data",
        expectedDigest: resolver.digest,
        requireReadOnly: true,
        allowedKinds: ["mcp", "api"],
        limit: 2,
      }),
    ).resolves.toEqual({
      resolver: {
        entryId: resolver.id,
        key: resolver.key,
        digest: resolver.digest,
        semanticKey: "market.data",
      },
      preferred: {
        name: "CCXT public market",
        kind: "mcp",
        reference: "ccxt/ccxt",
        skillReference: null,
        priority: 2,
        readOnly: true,
        constraints: ["market tier only"],
        skill: null,
      },
      candidates: [
        {
          name: "CCXT public market",
          kind: "mcp",
          reference: "ccxt/ccxt",
          skillReference: null,
          priority: 2,
          readOnly: true,
          constraints: ["market tier only"],
          skill: null,
        },
        {
          name: "Public fallback",
          kind: "api",
          reference: "market:public-fallback",
          skillReference: null,
          priority: 3,
          readOnly: true,
          constraints: ["public data only"],
          skill: null,
        },
      ],
    });

    await expect(
      service.resolve(actor, {
        semanticKey: "market.data",
        expectedDigest: "0".repeat(64),
        requireReadOnly: true,
        limit: 32,
      }),
    ).rejects.toThrow("digest changed");
  });

  it("links market: Resolver references to exact owned Skill provenance", async () => {
    const { service } = setup();
    const skill = await service.importEntry(actor, {
      kind: "skill",
      key: "okx/agent-trade-kit:skills/okx-cex-market/SKILL.md@" + sourceRef,
      tags: ["trading", "research-ready", "market-data"],
      content: originalSkill("okx-cex-market"),
      sourceUrl:
        "https://github.com/okx/agent-trade-kit/blob/" +
        sourceRef +
        "/skills/okx-cex-market/SKILL.md",
      repository: "okx/agent-trade-kit",
      sourcePath: "skills/okx-cex-market/SKILL.md",
      sourceRef,
      license: "MIT",
      trust: "curated",
      metadata: {},
    });
    const resolver = await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@" + sourceRef,
      name: "Market data resolver",
      description: "Resolver with one Market Skill implementation.",
      tags: ["market.data"],
      content: JSON.stringify({
        semanticKey: "market.data",
        implementations: [
          {
            name: "OKX CEX Market Skill",
            kind: "api",
            reference: "market:okx/agent-trade-kit:okx-cex-market",
            priority: 1,
            readOnly: true,
            constraints: ["read-only market data"],
          },
        ],
      }),
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated",
      metadata: {},
    });

    await expect(
      service.resolve(actor, {
        semanticKey: "market.data",
        expectedDigest: resolver.digest,
        requireReadOnly: true,
        limit: 32,
      }),
    ).resolves.toMatchObject({
      preferred: {
        reference: "market:okx/agent-trade-kit:okx-cex-market",
        skillReference: null,
        skill: {
          status: "resolved",
          entryId: skill.id,
          key: skill.key,
          name: "okx-cex-market",
          repository: "okx/agent-trade-kit",
          digest: skill.digest,
          variant: "original",
          tags: ["trading", "research-ready", "market-data"],
        },
      },
    });
  });

  it("resolves a separate Skill recipe pinned by an MCP Resolver implementation", async () => {
    const { service } = setup();
    const skill = await service.importEntry(actor, {
      kind: "skill",
      key: "ccxt/ccxt:.claude/skills/ccxt-mcp/SKILL.md@" + sourceRef,
      tags: ["trading", "adapt-to-paper", "mcp", "market-data"],
      content: originalSkill("ccxt-mcp"),
      sourceUrl:
        "https://github.com/ccxt/ccxt/blob/" + sourceRef + "/.claude/skills/ccxt-mcp/SKILL.md",
      repository: "ccxt/ccxt",
      sourcePath: ".claude/skills/ccxt-mcp/SKILL.md",
      sourceRef,
      license: "MIT",
      trust: "curated",
      metadata: {},
    });
    const resolver = await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@" + sourceRef,
      name: "Market data resolver",
      description: "Resolver with an MCP implementation and a separate usage Skill.",
      tags: ["market.data"],
      content: JSON.stringify({
        semanticKey: "market.data",
        implementations: [
          {
            name: "CCXT MCP market tier",
            kind: "mcp",
            reference: "ccxt/ccxt",
            skillReference: "market:ccxt/ccxt:ccxt-mcp",
            priority: 1,
            readOnly: true,
            constraints: ["market tier only"],
          },
        ],
      }),
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated",
      metadata: {},
    });

    await expect(
      service.resolve(actor, {
        semanticKey: "market.data",
        expectedDigest: resolver.digest,
        requireReadOnly: true,
        limit: 32,
      }),
    ).resolves.toMatchObject({
      preferred: {
        reference: "ccxt/ccxt",
        skillReference: "market:ccxt/ccxt:ccxt-mcp",
        skill: {
          status: "resolved",
          entryId: skill.id,
          key: skill.key,
          name: "ccxt-mcp",
          repository: "ccxt/ccxt",
          digest: skill.digest,
          variant: "original",
        },
      },
    });
  });

  it("selects the first read-only Resolver route with exact Market Skill provenance", async () => {
    const { service } = setup();
    const skill = await service.importEntry(actor, {
      kind: "skill",
      key: "ccxt/ccxt:.claude/skills/ccxt-mcp/SKILL.md@" + sourceRef,
      tags: ["trading", "adapt-to-paper", "mcp", "market-data"],
      content: originalSkill("ccxt-mcp"),
      sourceUrl:
        "https://github.com/ccxt/ccxt/blob/" + sourceRef + "/.claude/skills/ccxt-mcp/SKILL.md",
      repository: "ccxt/ccxt",
      sourcePath: ".claude/skills/ccxt-mcp/SKILL.md",
      sourceRef,
      license: "MIT",
      trust: "curated",
      metadata: {},
    });
    const resolver = await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@" + sourceRef,
      name: "Market data resolver",
      description: "Resolver selection fallback fixture.",
      tags: ["market.data"],
      content: JSON.stringify({
        semanticKey: "market.data",
        implementations: [
          {
            name: "Missing Market Skill",
            kind: "api",
            reference: "market:okx/agent-trade-kit:missing-skill",
            priority: 1,
            readOnly: true,
            constraints: ["read-only"],
          },
          {
            name: "CCXT MCP market tier",
            kind: "mcp",
            reference: "ccxt/ccxt",
            skillReference: "market:ccxt/ccxt:ccxt-mcp",
            priority: 2,
            readOnly: true,
            constraints: ["market tier only"],
          },
        ],
      }),
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated",
      metadata: {},
    });

    await expect(
      service.select(actor, {
        semanticKey: "market.data",
        expectedDigest: resolver.digest,
        limit: 32,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      resolver: {
        entryId: resolver.id,
        key: resolver.key,
        digest: resolver.digest,
        semanticKey: "market.data",
      },
      implementation: {
        name: "CCXT MCP market tier",
        kind: "mcp",
        reference: "ccxt/ccxt",
        skillReference: "market:ccxt/ccxt:ccxt-mcp",
        priority: 2,
        readOnly: true,
      },
      skill: {
        status: "resolved",
        entryId: skill.id,
        key: skill.key,
        digest: skill.digest,
        variant: "original",
      },
      skipped: [
        {
          name: "Missing Market Skill",
          reference: "market:okx/agent-trade-kit:missing-skill",
          priority: 1,
          reason: "market_skill_missing",
        },
      ],
    });
  });

  it("prepares exact Resolver provenance and selected Skill content without installing it", async () => {
    const { service } = setup();
    const skillContent = originalSkill("ccxt-mcp");
    const skill = await service.importEntry(actor, {
      kind: "skill",
      key: "ccxt/ccxt:.claude/skills/ccxt-mcp/SKILL.md@" + sourceRef,
      tags: ["trading", "adapt-to-paper", "mcp", "market-data"],
      content: skillContent,
      sourceUrl:
        "https://github.com/ccxt/ccxt/blob/" + sourceRef + "/.claude/skills/ccxt-mcp/SKILL.md",
      repository: "ccxt/ccxt",
      sourcePath: ".claude/skills/ccxt-mcp/SKILL.md",
      sourceRef,
      license: "MIT",
      trust: "curated",
      metadata: {},
    });
    const resolver = await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@" + sourceRef,
      name: "Market data resolver",
      description: "Prepared research fixture.",
      tags: ["market.data"],
      content: JSON.stringify({
        semanticKey: "market.data",
        implementations: [
          {
            name: "CCXT MCP market tier",
            kind: "mcp",
            reference: "ccxt/ccxt",
            skillReference: "market:ccxt/ccxt:ccxt-mcp",
            priority: 1,
            readOnly: true,
            constraints: ["market tier only"],
          },
        ],
      }),
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated",
      metadata: {},
    });

    const prepared = await service.prepare(actor, {
      semanticKey: "market.data",
      expectedDigest: resolver.digest,
      limit: 32,
    });
    expect(prepared.selection).toMatchObject({
      status: "ready",
      resolver: {
        entryId: resolver.id,
        key: resolver.key,
        digest: resolver.digest,
        semanticKey: "market.data",
      },
      implementation: {
        name: "CCXT MCP market tier",
        reference: "ccxt/ccxt",
        readOnly: true,
      },
      skill: {
        status: "resolved",
        entryId: skill.id,
        key: skill.key,
        digest: skill.digest,
        variant: "original",
      },
    });
    expect(prepared.provenance).toMatchObject({
      semanticKey: "market.data",
      resolverKey: resolver.key,
      resolverDigest: resolver.digest,
      implementation: {
        name: "CCXT MCP market tier",
        kind: "mcp",
        reference: "ccxt/ccxt",
        priority: 1,
        readOnly: true,
      },
      skill: {
        marketEntryId: skill.id,
        marketKey: skill.key,
        sourceDigest: skill.digest,
        variant: "original",
      },
    });
    expect(Date.parse(prepared.provenance?.resolvedAt ?? "")).not.toBeNaN();
    expect(prepared.skillContent).toBe(skillContent);
  });

  it("fails closed on ambiguous semantic resolvers unless the caller pins a resolver key", async () => {
    const { service } = setup();
    const shared = {
      name: "Market data resolver",
      description: "Resolver revision.",
      tags: ["market.data"],
      repository: "BogdanAIP/rakazo",
      sourcePath: "market/resolver-seeds.v1.json",
      sourceRef,
      license: "repository license",
      trust: "curated" as const,
      metadata: {},
    };
    const content = JSON.stringify({
      semanticKey: "market.data",
      implementations: [
        {
          name: "Public market",
          kind: "api",
          reference: "market:public",
          priority: 1,
          readOnly: true,
          constraints: [],
        },
      ],
    });
    const first = await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@one-" + sourceRef,
      content,
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      ...shared,
    });
    await service.importEntry(actor, {
      kind: "resolver",
      key: "market.data@two-" + sourceRef,
      content,
      sourceUrl:
        "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/market/resolver-seeds.v1.json",
      ...shared,
    });

    await expect(
      service.resolve(actor, {
        semanticKey: "market.data",
        requireReadOnly: true,
        limit: 32,
      }),
    ).rejects.toThrow("Multiple Market Resolvers");

    await expect(
      service.resolve(actor, {
        semanticKey: "market.data",
        resolverKey: first.key,
        requireReadOnly: true,
        limit: 32,
      }),
    ).resolves.toMatchObject({
      resolver: { entryId: first.id, key: first.key, semanticKey: "market.data" },
      preferred: {
        reference: "market:public",
        skillReference: null,
        readOnly: true,
        skill: null,
      },
    });
  });

  it("keeps the original while storing and evaluating an RCCL adaptation", async () => {
    const { service } = setup();
    const imported = await service.importEntry(actor, {
      kind: "skill",
      key: "trusted:paper@" + sourceRef,
      tags: ["research"],
      content: originalSkill(),
      sourceUrl:
        "https://github.com/anthropics/claude-plugins-official/blob/" +
        sourceRef +
        "/skills/paper/SKILL.md",
      repository: "anthropics/claude-plugins-official",
      sourcePath: "skills/paper/SKILL.md",
      sourceRef,
      trust: "curated",
      metadata: {},
    });
    const rccl = buildRcclSkillTemplate({
      name: "Research Paper Analysis",
      description: "Extract evidence from a scientific paper.",
      capabilityRequirements: ["documents.read", "citations"],
    });

    const adapted = await service.adapt(actor, {
      entryId: imported.id,
      expectedDigest: imported.digest,
      mode: "rccl",
      content: rccl,
    });

    expect(adapted.originalContent).toBe(imported.originalContent);
    expect(adapted.adaptedContent).toBe(rccl);
    expect(adapted.preferredVariant).toBe("original");

    const evaluated = await service.evaluate(actor, {
      entryId: imported.id,
      expectedDigest: imported.digest,
      preferredVariant: "rccl",
      metrics: {
        original: { quality: 8.1, toolErrors: 2 },
        rccl: { quality: 8.8, toolErrors: 0 },
      },
      note: "Comparable paper extraction task.",
    });

    expect(evaluated.preferredVariant).toBe("rccl");
    expect(evaluated.metrics).toMatchObject({
      comparisonCount: 1,
      lastPreferredVariant: "rccl",
    });
  });

  it("materializes only an explicit selected Skill variant and adds provenance", async () => {
    const { service } = setup();
    const imported = await service.importEntry(actor, {
      kind: "skill",
      key: "trusted:paper@" + sourceRef,
      tags: [],
      content: originalSkill(),
      sourceUrl:
        "https://github.com/anthropics/claude-plugins-official/blob/" +
        sourceRef +
        "/skills/paper/SKILL.md",
      repository: "anthropics/claude-plugins-official",
      sourcePath: "skills/paper/SKILL.md",
      sourceRef,
      trust: "curated",
      metadata: {},
    });

    const materialized = await service.materializeForInstall(actor, {
      entryId: imported.id,
      nameOverride: "Paper Analysis - Market",
    });
    const parsed = parseSkillMd(materialized.content);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.name).toBe("Paper Analysis - Market");
    expect(parsed.frontmatter["rakazo-market-entry"]).toBe(imported.id);
    expect(parsed.frontmatter["rakazo-market-source-digest"]).toBe(imported.digest);
    expect(parsed.frontmatter["rakazo-market-variant"]).toBe("original");
  });

  it("ranks matching trusted entries without loading their content into the catalog", async () => {
    const { service } = setup();
    const shared = {
      sourceRef,
      trust: "curated" as const,
      metadata: {},
    };
    await service.importEntry(actor, {
      kind: "skill",
      key: "browser-investigation@" + sourceRef,
      tags: ["browser", "debug"],
      content: originalSkill("Browser Investigation"),
      sourceUrl:
        "https://github.com/anthropics/claude-plugins-official/blob/" +
        sourceRef +
        "/browser/SKILL.md",
      repository: "anthropics/claude-plugins-official",
      sourcePath: "browser/SKILL.md",
      ...shared,
    });
    await service.importEntry(actor, {
      kind: "skill",
      key: "paper-analysis@" + sourceRef,
      tags: ["research"],
      content: originalSkill(),
      sourceUrl:
        "https://github.com/anthropics/claude-plugins-official/blob/" +
        sourceRef +
        "/paper/SKILL.md",
      repository: "anthropics/claude-plugins-official",
      sourcePath: "paper/SKILL.md",
      ...shared,
    });

    const results = await service.search(actor, {
      query: "browser debug",
      kind: "skill",
      limit: 10,
    });
    expect(results[0]?.name).toBe("Browser Investigation");
    expect(results[0]).not.toHaveProperty("originalContent");
    expect(results[0]).not.toHaveProperty("adaptedContent");
  });
});
