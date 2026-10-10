import { createHash } from "node:crypto";
import type { TradingResolvedResearchEnvelope } from "@rakazo/contracts";
import { TradingResolvedResearchEnvelopeSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { PaperLedgerIntegrityError } from "./trading-paper-store.js";

type Owner = { spaceId: string; userId: string };
type Key = { ledgerId: string; sessionRevision: number; scheduledFor: string };
const digest = (envelope: TradingResolvedResearchEnvelope) =>
  createHash("sha256").update(JSON.stringify(envelope), "utf8").digest("hex");
async function owned(tx: Prisma.TransactionClient, owner: Owner, key: Key) {
  if (
    !Number.isSafeInteger(key.sessionRevision) ||
    key.sessionRevision < 1 ||
    !Number.isFinite(Date.parse(key.scheduledFor))
  )
    throw new Error("Invalid PAPER research wake");
  const row = await tx.tradingPaperLedger.findFirst({
    where: { id: key.ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { id: true },
  });
  if (!row) throw new Error("PAPER research ledger unavailable");
}
export async function readTradingPaperResearchSnapshot(
  prisma: PrismaClient,
  owner: Owner,
  key: Key,
) {
  return prisma.$transaction(async (tx) => {
    await owned(tx, owner, key);
    const row = await tx.tradingPaperResearchSnapshot.findUnique({
      where: {
        ledgerId_sessionRevision_scheduledFor: { ...key, scheduledFor: new Date(key.scheduledFor) },
      },
    });
    if (!row) return null;
    const parsed = TradingResolvedResearchEnvelopeSchema.safeParse(row.envelope);
    if (!parsed.success || digest(parsed.data) !== row.envelopeSha256)
      throw new PaperLedgerIntegrityError("PAPER research snapshot changed");
    return parsed.data;
  });
}
export async function recordTradingPaperResearchSnapshot(
  prisma: PrismaClient,
  owner: Owner,
  key: Key,
  input: TradingResolvedResearchEnvelope,
) {
  const envelope = TradingResolvedResearchEnvelopeSchema.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      await owned(tx, owner, key);
      await tx.tradingPaperResearchSnapshot.create({
        data: {
          ...key,
          scheduledFor: new Date(key.scheduledFor),
          envelope: envelope as unknown as Prisma.InputJsonValue,
          envelopeSha256: digest(envelope),
        },
      });
      return envelope;
    });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002"))
      throw error;
    const existing = await readTradingPaperResearchSnapshot(prisma, owner, key);
    if (!existing) throw error;
    return existing;
  }
}
