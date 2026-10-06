import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  MarketResolverContentSchema,
  type Actor,
  type MarketAdaptationMode,
  type MarketCatalogEntry,
  type MarketEntry,
  type MarketEntryKind,
  type MarketPreferredVariant,
} from "@rakazo/contracts";
import {
  analyzeRcclSkillMd,
  buildSkillMd,
  parseSkillMd,
} from "@rakazo/core";
import { IsolationError, Prisma, type PrismaClient } from "@rakazo/db";

type MarketEntryRow = {
  id: string;
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

type ImportInput = {
  kind: MarketEntryKind;
  key: string;
  name?: string;
  description?: string;
  tags: string[];
  content: string;
  sourceUrl: string;
  repository: string;
  sourcePath?: string;
  sourceRef: string;
  license?: string;
  trust: "curated";
  metadata: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asVariant(value: string): MarketPreferredVariant {
  if (value === "rccl" || value === "wrapped" || value === "hybrid") return value;
  return "original";
}

function asAdaptationMode(value: string | null): MarketAdaptationMode | null {
  if (value === "rccl" || value === "wrapped" || value === "hybrid") return value;
  return null;
}

export function mapMarketEntry(row: MarketEntryRow): MarketEntry {
  return {
    id: row.id,
    kind: row.kind === "resolver" ? "resolver" : "skill",
    key: row.key,
    name: row.name,
    description: row.description,
    tags: row.tags,
    originalContent: row.originalContent,
    adaptedContent: row.adaptedContent,
    adaptationMode: asAdaptationMode(row.adaptationMode),
    preferredVariant: asVariant(row.preferredVariant),
    sourceUrl: row.sourceUrl,
    repository: row.repository,
    sourcePath: row.sourcePath,
    sourceRef: row.sourceRef,
    license: row.license,
    digest: row.digest,
    trust: "curated",
    metrics: asRecord(row.metrics),
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function catalogEntry(row: MarketEntryRow): MarketCatalogEntry {
  const full = mapMarketEntry(row);
  const {
    originalContent: _originalContent,
    adaptedContent: _adaptedContent,
    metrics: _metrics,
    metadata: _metadata,
    ...catalog
  } = full;
  return catalog;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeTags(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

function assertGithubSource(sourceUrl: string, repository: string): void {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Market sourceUrl must be a valid URL." });
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Market v1 accepts curated sources only from https://github.com.",
    });
  }
  const expected = "/" + repository.toLowerCase();
  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  if (path !== expected && !path.startsWith(expected + "/")) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Market sourceUrl does not match the declared GitHub repository.",
    });
  }
}

function validatedImport(input: ImportInput): {
  name: string;
  description: string;
  tags: string[];
  digest: string;
} {
  assertGithubSource(input.sourceUrl, input.repository);
  if (JSON.stringify(input.metadata).length > 20_000) {
    throw new ORPCError("BAD_REQUEST", { message: "Market metadata is too large." });
  }

  if (input.kind === "skill") {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) {
      throw new ORPCError("BAD_REQUEST", { message: parsed.error });
    }
    return {
      name: parsed.name,
      description: parsed.description,
      tags: normalizeTags(input.tags),
      digest: sha256(input.content),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.content);
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "Resolver Market content must be valid JSON.",
    });
  }
  const resolver = MarketResolverContentSchema.safeParse(parsedJson);
  if (!resolver.success) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Resolver Market content does not match the resolver schema.",
    });
  }
  const name = input.name?.trim();
  const description = input.description?.trim();
  if (!name || !description) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Resolver Market entries require name and description.",
    });
  }
  return {
    name,
    description,
    tags: normalizeTags([...input.tags, resolver.data.semanticKey]),
    digest: sha256(input.content),
  };
}

function scoreEntry(row: MarketEntryRow, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const key = row.key.toLowerCase();
  const name = row.name.toLowerCase();
  const description = row.description.toLowerCase();
  const tags = row.tags.map((tag) => tag.toLowerCase());

  let score = row.trust === "curated" ? 20 : 0;
  if (key === normalized) score += 1_000;
  if (name === normalized) score += 900;
  if (name.includes(normalized)) score += 400;
  if (key.includes(normalized)) score += 300;
  if (description.includes(normalized)) score += 160;
  if (tags.includes(normalized)) score += 220;
  for (const token of tokens) {
    if (name.includes(token)) score += 80;
    if (key.includes(token)) score += 60;
    if (description.includes(token)) score += 30;
    if (tags.some((tag) => tag.includes(token))) score += 50;
  }
  if (row.adaptedContent) score += 5;
  return score;
}

function assertDigest(row: MarketEntryRow, expectedDigest: string): void {
  if (row.digest !== expectedDigest) {
    throw new ORPCError("CONFLICT", {
      message: "Market entry source digest changed; reload the entry before updating it.",
    });
  }
}

function validateAdaptedSkill(content: string, mode: MarketAdaptationMode): void {
  const parsed = parseSkillMd(content);
  if ("error" in parsed) {
    throw new ORPCError("BAD_REQUEST", { message: parsed.error });
  }
  if (mode !== "rccl") return;
  const analysis = analyzeRcclSkillMd(content, { strict: true });
  if (!analysis.strictReady) {
    throw new ORPCError("BAD_REQUEST", {
      message: "RCCL adaptation must pass the strict RCCL Skill Profile.",
    });
  }
}

async function owned(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
): Promise<MarketEntryRow> {
  const row = await prisma.marketEntry.findFirst({
    where: { id: entryId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!row) throw new IsolationError();
  return row;
}

export function createMarketService(prisma: PrismaClient) {
  return {
    async search(
      actor: Actor,
      input: { query: string; kind?: MarketEntryKind; limit: number },
    ): Promise<MarketCatalogEntry[]> {
      const rows = await prisma.marketEntry.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(input.kind ? { kind: input.kind } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 2_000,
      });
      const query = input.query.trim();
      const ranked = query
        ? rows
            .map((row) => ({ row, score: scoreEntry(row, query) }))
            .filter((item) => item.score > 20)
            .sort(
              (a, b) =>
                b.score - a.score ||
                a.row.name.localeCompare(b.row.name) ||
                a.row.id.localeCompare(b.row.id),
            )
            .map((item) => item.row)
        : rows;
      return ranked.slice(0, input.limit).map(catalogEntry);
    },

    async get(
      actor: Actor,
      input: { entryId?: string; kind?: MarketEntryKind; key?: string },
    ): Promise<MarketEntry> {
      const row = input.entryId
        ? await prisma.marketEntry.findFirst({
            where: { id: input.entryId, spaceId: actor.spaceId, userId: actor.userId },
          })
        : await prisma.marketEntry.findFirst({
            where: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              kind: input.kind!,
              key: input.key!,
            },
          });
      if (!row) throw new IsolationError();
      return mapMarketEntry(row);
    },

    async importEntry(actor: Actor, input: ImportInput): Promise<MarketEntry> {
      const validated = validatedImport(input);
      const existing = await prisma.marketEntry.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          kind: input.kind,
          key: input.key,
        },
      });
      if (existing) {
        const sameProvenance =
          existing.digest === validated.digest &&
          existing.repository === input.repository &&
          existing.sourceRef === input.sourceRef &&
          existing.sourcePath === (input.sourcePath ?? null) &&
          existing.sourceUrl === input.sourceUrl;
        if (!sameProvenance) {
          throw new ORPCError("CONFLICT", {
            message:
              "Market key already exists with different source/provenance. Import the new source version under a new key.",
          });
        }
        return mapMarketEntry(existing);
      }

      const row = await prisma.marketEntry.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          kind: input.kind,
          key: input.key,
          name: validated.name,
          description: validated.description,
          tags: validated.tags,
          originalContent: input.content,
          preferredVariant: "original",
          sourceUrl: input.sourceUrl,
          repository: input.repository,
          sourcePath: input.sourcePath,
          sourceRef: input.sourceRef,
          license: input.license,
          digest: validated.digest,
          trust: input.trust,
          metrics: {},
          metadata: input.metadata as Prisma.InputJsonValue,
        },
      });
      return mapMarketEntry(row);
    },

    async adapt(
      actor: Actor,
      input: {
        entryId: string;
        expectedDigest: string;
        mode: MarketAdaptationMode;
        content: string;
      },
    ): Promise<MarketEntry> {
      const row = await owned(prisma, actor, input.entryId);
      assertDigest(row, input.expectedDigest);
      if (row.kind !== "skill") {
        throw new ORPCError("BAD_REQUEST", {
          message: "Only Market Skills can have RCCL/wrapped/hybrid adaptations.",
        });
      }
      validateAdaptedSkill(input.content, input.mode);
      if (row.adaptedContent) {
        if (row.adaptedContent === input.content && row.adaptationMode === input.mode) {
          return mapMarketEntry(row);
        }
        throw new ORPCError("CONFLICT", {
          message:
            "This Market Skill already has an adaptation. Preserve it and import a new revision instead of overwriting comparison evidence.",
        });
      }
      const updated = await prisma.marketEntry.update({
        where: { id: row.id },
        data: {
          adaptedContent: input.content,
          adaptationMode: input.mode,
          preferredVariant: "original",
        },
      });
      return mapMarketEntry(updated);
    },

    async evaluate(
      actor: Actor,
      input: {
        entryId: string;
        expectedDigest: string;
        preferredVariant: MarketPreferredVariant;
        metrics: Record<string, unknown>;
        note?: string;
      },
    ): Promise<MarketEntry> {
      const row = await owned(prisma, actor, input.entryId);
      assertDigest(row, input.expectedDigest);
      if (JSON.stringify(input.metrics).length > 20_000) {
        throw new ORPCError("BAD_REQUEST", { message: "Market comparison metrics are too large." });
      }
      if (input.preferredVariant !== "original") {
        if (!row.adaptedContent || row.adaptationMode !== input.preferredVariant) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Preferred adapted variant must match the stored adaptation mode.",
          });
        }
      }
      const current = asRecord(row.metrics);
      const prior = Array.isArray(current.comparisons)
        ? current.comparisons.filter((value) => value && typeof value === "object").slice(-49)
        : [];
      const comparison = {
        at: new Date().toISOString(),
        preferredVariant: input.preferredVariant,
        metrics: input.metrics,
        ...(input.note ? { note: input.note } : {}),
      };
      const metrics = {
        ...current,
        comparisons: [...prior, comparison],
        comparisonCount: Number(current.comparisonCount ?? 0) + 1,
        lastPreferredVariant: input.preferredVariant,
      };
      const updated = await prisma.marketEntry.update({
        where: { id: row.id },
        data: {
          preferredVariant: input.preferredVariant,
          metrics: metrics as Prisma.InputJsonValue,
        },
      });
      return mapMarketEntry(updated);
    },

    async materializeForInstall(
      actor: Actor,
      input: { entryId: string; variant?: MarketPreferredVariant; nameOverride?: string },
    ): Promise<{ entry: MarketEntry; content: string; variant: MarketPreferredVariant }> {
      const row = await owned(prisma, actor, input.entryId);
      if (row.kind !== "skill") {
        throw new ORPCError("BAD_REQUEST", { message: "Only Market Skills can be installed." });
      }
      const variant = input.variant ?? asVariant(row.preferredVariant);
      const sourceContent =
        variant === "original"
          ? row.originalContent
          : row.adaptedContent && row.adaptationMode === variant
            ? row.adaptedContent
            : null;
      if (!sourceContent) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Requested Market Skill variant is not available.",
        });
      }
      const parsed = parseSkillMd(sourceContent);
      if ("error" in parsed) {
        throw new ORPCError("BAD_REQUEST", { message: parsed.error });
      }
      const frontmatter = {
        ...parsed.frontmatter,
        "rakazo-market-entry": row.id,
        "rakazo-market-key": row.key,
        "rakazo-market-repository": row.repository,
        "rakazo-market-source-ref": row.sourceRef,
        "rakazo-market-source-digest": row.digest,
        "rakazo-market-variant": variant,
      };
      const content = buildSkillMd({
        name: input.nameOverride?.trim() || parsed.name,
        description: parsed.description,
        body: parsed.body,
        frontmatter,
      });
      return { entry: mapMarketEntry(row), content, variant };
    },
  };
}

export type MarketService = ReturnType<typeof createMarketService>;
