import type { MarketAdaptationMode, MarketEntry, MarketPreferredVariant } from "@rakazo/contracts";
import {
  prepareMarketResolverResearch,
  resolveMarketResolverPlanFromEntries,
  selectMarketResolverReadOnlyImplementation,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

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

type Owner = { spaceId: string; userId: string };
type ResolveInput = Parameters<typeof resolveMarketResolverPlanFromEntries>[2];
type Db = Pick<PrismaClient, "$transaction">;
export async function readOwnedMarketResolverPlan(prisma: Db, owner: Owner, input: ResolveInput) {
  return prisma.$transaction(async (tx) => {
    const [resolvers, skills] = await Promise.all([
      tx.marketEntry.findMany({
        where: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          kind: "resolver",
          tags: { has: input.semanticKey },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 100,
      }),
      tx.marketEntry.findMany({
        where: { spaceId: owner.spaceId, userId: owner.userId, kind: "skill" },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 2000,
      }),
    ]);
    return resolveMarketResolverPlanFromEntries(
      resolvers.map(mapMarketEntry),
      skills.map(mapMarketEntry),
      input,
    );
  });
}
export async function readOwnedMarketPreparedResearch(
  prisma: Db,
  owner: Owner,
  input: Omit<ResolveInput, "requireReadOnly">,
) {
  return prisma.$transaction(async (tx) => {
    const db = {
      $transaction: async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        action(tx),
    } as unknown as Db;
    const plan = await readOwnedMarketResolverPlan(db, owner, { ...input, requireReadOnly: false });
    const selection = selectMarketResolverReadOnlyImplementation(plan);
    const row =
      selection.status === "ready" && selection.skill
        ? await tx.marketEntry.findFirst({
            where: { id: selection.skill.entryId, spaceId: owner.spaceId, userId: owner.userId },
          })
        : null;
    return prepareMarketResolverResearch(
      selection,
      row ? mapMarketEntry(row) : undefined,
      new Date().toISOString(),
    );
  });
}
