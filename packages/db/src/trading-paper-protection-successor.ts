import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { assessTradingPaperProtectionWakePreflightInTransaction } from "./trading-paper-protection-lease.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export class PaperProtectionSuccessorIntegrityError extends Error {
  constructor(message = "PAPER protection successor integrity mismatch") {
    super(message);
    this.name = "PaperProtectionSuccessorIntegrityError";
  }
}

type Planned = {
  ledgerId: string;
  spaceId: string;
  userId: string;
  leaseRevision: number;
  gateRevision: number;
  sourceScheduledFor: string;
  successorScheduledFor: string;
  approvalEffectId: string;
};

function checksum(value: Planned): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.leaseRevision,
        value.gateRevision,
        value.sourceScheduledFor,
        value.successorScheduledFor,
        value.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

export type PaperProtectionSuccessorIntentResult =
  | ({ status: "prepared" | "duplicate"; mode: "paper_only" } & Planned)
  | {
      status: "stop";
      mode: "paper_only";
      ledgerId: string;
      reason: "lease_denied" | "no_open_positions" | "next_after_expiry";
    };

/**
 * H2b2: independently plan the next stop-ONLY check with a durable,
 * deterministic intent. No queue publisher, entry capability or broker access.
 * Recheck owner approval, DB clock, stopped entry session and current PAPER
 * position state in the same serializable database transaction.
 */
export async function prepareTradingPaperProtectionSuccessorIntent(
  prisma: Db,
  owner: Owner,
  input: {
    ledgerId: string;
    leaseRevision: number;
    gateRevision: number;
    sourceScheduledFor: string;
  },
): Promise<PaperProtectionSuccessorIntentResult> {
  const source = new Date(input.sourceScheduledFor);
  if (
    !Number.isFinite(source.getTime()) ||
    !Number.isSafeInteger(input.leaseRevision) ||
    input.leaseRevision < 1 ||
    !Number.isSafeInteger(input.gateRevision) ||
    input.gateRevision < 0
  ) {
    throw new PaperProtectionSuccessorIntegrityError("Invalid protection successor scope");
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperProtectionSuccessorIntentResult> => {
        const clock = await tx.$queryRaw<Array<{ db_now: Date }>>(
          Prisma.sql`SELECT clock_timestamp() AS db_now`,
        );
        const now = clock[0]?.db_now;
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
          throw new PaperProtectionSuccessorIntegrityError("Trusted DB clock unavailable");
        }
        const authority = await assessTradingPaperProtectionWakePreflightInTransaction(
          tx,
          owner,
          input.ledgerId,
          input.leaseRevision,
          input.gateRevision,
        );
        if (authority.status !== "ready") {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "lease_denied",
          };
        }
        const report = await auditTradingPaperLifecycleInTransaction(
          tx,
          owner,
          input.ledgerId,
          now,
        );
        if (report.openPositions === 0) {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "no_open_positions",
          };
        }

        const cadenceMs = authority.cadenceMinutes * 60_000;
        const intervals = Math.max(
          1,
          Math.floor((now.getTime() - source.getTime()) / cadenceMs) + 1,
        );
        const successor = new Date(source.getTime() + intervals * cadenceMs);
        if (successor.getTime() >= Date.parse(authority.expiresAt)) {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "next_after_expiry",
          };
        }
        const row = await tx.tradingPaperProtectionLease.findUniqueOrThrow({
          where: { ledgerId: input.ledgerId },
          select: { approvalEffectId: true },
        });
        const planned: Planned = {
          ledgerId: input.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          leaseRevision: authority.revision,
          gateRevision: authority.gateRevision,
          sourceScheduledFor: source.toISOString(),
          successorScheduledFor: successor.toISOString(),
          approvalEffectId: row.approvalEffectId,
        };
        const where = {
          ledgerId_leaseRevision_sourceScheduledFor: {
            ledgerId: input.ledgerId,
            leaseRevision: input.leaseRevision,
            sourceScheduledFor: source,
          },
        };
        const existing = await tx.tradingPaperProtectionSuccessorIntent.findUnique({ where });
        const expectedChecksum = checksum(planned);
        if (existing) {
          if (
            existing.spaceId !== owner.spaceId ||
            existing.userId !== owner.userId ||
            existing.gateRevision !== planned.gateRevision ||
            existing.successorScheduledFor.toISOString() !== planned.successorScheduledFor ||
            existing.approvalEffectId !== planned.approvalEffectId ||
            existing.intentSha256 !== expectedChecksum
          ) {
            throw new PaperProtectionSuccessorIntegrityError("Persisted successor intent changed");
          }
          return { status: "duplicate", mode: "paper_only", ...planned };
        }
        await tx.tradingPaperProtectionSuccessorIntent.create({
          data: {
            id: `paper-protection-successor:${expectedChecksum}`,
            ledgerId: input.ledgerId,
            spaceId: owner.spaceId,
            userId: owner.userId,
            leaseRevision: planned.leaseRevision,
            gateRevision: planned.gateRevision,
            sourceScheduledFor: source,
            successorScheduledFor: successor,
            approvalEffectId: planned.approvalEffectId,
            intentSha256: expectedChecksum,
          },
        });
        return { status: "prepared", mode: "paper_only", ...planned };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
