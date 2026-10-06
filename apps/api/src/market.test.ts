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
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);

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
      key: "anthropics/skills:paper-analysis@" + sourceRef,
      tags: ["Research", "papers"],
      content: originalSkill(),
      sourceUrl:
        "https://github.com/anthropics/skills/blob/" + sourceRef + "/skills/paper-analysis/SKILL.md",
      repository: "anthropics/skills",
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
      repository: "anthropics/skills",
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
    expect(marketEntry.create).toHaveBeenCalledTimes(1);

    await expect(
      service.importEntry(actor, { ...input, content: originalSkill("Changed") }),
    ).rejects.toThrow("different source/provenance");
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
      sourceUrl: "https://github.com/BogdanAIP/rakazo/blob/" + sourceRef + "/docs/hybrid-computer-use.md",
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

  it("keeps the original while storing and evaluating an RCCL adaptation", async () => {
    const { service } = setup();
    const imported = await service.importEntry(actor, {
      kind: "skill",
      key: "trusted:paper@" + sourceRef,
      tags: ["research"],
      content: originalSkill(),
      sourceUrl: "https://github.com/anthropics/skills/blob/" + sourceRef + "/skills/paper/SKILL.md",
      repository: "anthropics/skills",
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
      sourceUrl: "https://github.com/anthropics/skills/blob/" + sourceRef + "/skills/paper/SKILL.md",
      repository: "anthropics/skills",
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
      sourceUrl: "https://github.com/anthropics/skills/blob/" + sourceRef + "/browser/SKILL.md",
      repository: "anthropics/skills",
      sourcePath: "browser/SKILL.md",
      ...shared,
    });
    await service.importEntry(actor, {
      kind: "skill",
      key: "paper-analysis@" + sourceRef,
      tags: ["research"],
      content: originalSkill(),
      sourceUrl: "https://github.com/anthropics/skills/blob/" + sourceRef + "/paper/SKILL.md",
      repository: "anthropics/skills",
      sourcePath: "paper/SKILL.md",
      ...shared,
    });

    const results = await service.search(actor, { query: "browser debug", kind: "skill", limit: 10 });
    expect(results[0]?.name).toBe("Browser Investigation");
    expect(results[0]).not.toHaveProperty("originalContent");
    expect(results[0]).not.toHaveProperty("adaptedContent");
  });
});
