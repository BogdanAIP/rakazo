import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { assessTradingPaperEntrySessionInTransaction } from "./trading-paper-entry-session.js";
import { assessTradingPaperWorkerRecurrencePreflightInTransaction } from "./trading-paper-worker-recurrence-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export class PaperWorkerSuccessorIntentIntegrityError extends Error {
  constructor(message = "Synthetic paper worker successor intent integrity mismatch") {
    super(message);
    this.name = "PaperWorkerSuccessorIntentIntegrityError";
  }
}

export type TradingPaperWorkerSuccessorIntentResult =
  | {
      status: "prepared" | "duplicate";
      mode: "paper_only";
      ledgerId: string;
      gateRevision: number;
      recurrenceRevision: number;
      sourceScheduledFor: string;
      successorScheduledFor: string;
      recurrenceApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "stop";
      mode: "paper_only";
      ledgerId: string;
      reason: "recurrence_denied" | "recurrence_scope_changed" | "session_denied";
      recurrenceReason?: string;
      sessionReason?: string;
      currentGateRevision?: number;
    };

function intentDigest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  sourceScheduledFor: string;
  successorScheduledFor: string;
  gateRevision: number;
  recurrenceRevision: number;
  recurrenceApprovalEffectId: string;
  workerApprovalEffectId: string;
  paperApprovalEffectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.sourceScheduledFor,
        value.successorScheduledFor,
        value.gateRevision,
        value.recurrenceRevision,
        value.recurrenceApprovalEffectId,
        value.workerApprovalEffectId,
        value.paperApprovalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

function normalizeIntent(row: {
  ledgerId: string;
  sourceScheduledFor: Date;
  gateRevision: number;
  recurrenceRevision: number;
  spaceId: string;
  userId: string;
  recurrenceApprovalEffectId: string;
  workerApprovalEffectId: string;
  paperApprovalEffectId: string;
  successorScheduledFor: Date;
  intentSha256: string;
}) {
  const value = {
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    sourceScheduledFor: row.sourceScheduledFor.toISOString(),
    successorScheduledFor: row.successorScheduledFor.toISOString(),
    gateRevision: row.gateRevision,
    recurrenceRevision: row.recurrenceRevision,
    recurrenceApprovalEffectId: row.recurrenceApprovalEffectId,
    workerApprovalEffectId: row.workerApprovalEffectId,
    paperApprovalEffectId: row.paperApprovalEffectId,
  };
  if (
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.recurrenceRevision) ||
    row.recurrenceRevision < 1 ||
    row.successorScheduledFor.getTime() <= row.sourceScheduledFor.getTime() ||
    row.intentSha256 !== intentDigest(value)
  ) {
    throw new PaperWorkerSuccessorIntentIntegrityError();
  }
  return { ...value, intentSha256: row.intentSha256 };
}

export async function readVerifiedTradingPaperWorkerSuccessorIntent(
  prisma: Db,
  owner: Owner,
  input: {
    ledgerId: string;
    sourceScheduledFor: string;
    gateRevision: number;
    recurrenceRevision: number;
  },
) {
  const sourceScheduledFor = new Date(input.sourceScheduledFor);
  if (!Number.isFinite(sourceScheduledFor.getTime())) {
    throw new PaperWorkerSuccessorIntentIntegrityError("Invalid source scheduledFor");
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const row = await tx.tradingPaperWorkerSuccessorIntent.findUnique({
          where: {
            ledgerId_sourceScheduledFor_gateRevision_recurrenceRevision: {
              ledgerId: input.ledgerId,
              sourceScheduledFor,
              gateRevision: input.gateRevision,
              recurrenceRevision: input.recurrenceRevision,
            },
          },
        });
        if (!row) return null;
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerSuccessorIntentIntegrityError("Successor intent owner mismatch");
        }
        return normalizeIntent(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Persists one deterministic successor decision after a full D7 recurrence preflight.
 * This function has no JobPublisher and cannot enqueue work. */
export async function prepareTradingPaperWorkerSuccessorIntent(
  prisma: Db,
  owner: Owner,
  input: {
    ledgerId: string;
    sourceScheduledFor: string;
    gateRevision: number;
    sessionRevision?: number;
    now?: Date;
  },
): Promise<TradingPaperWorkerSuccessorIntentResult> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new PaperWorkerSuccessorIntentIntegrityError("Invalid successor intent clock");
  }
  const sourceScheduledFor = new Date(input.sourceScheduledFor);
  if (!Number.isFinite(sourceScheduledFor.getTime())) {
    throw new PaperWorkerSuccessorIntentIntegrityError("Invalid source scheduledFor");
  }
  if (!Number.isSafeInteger(input.gateRevision) || input.gateRevision < 0) {
    throw new PaperWorkerSuccessorIntentIntegrityError("Invalid worker gate revision");
  }

  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<TradingPaperWorkerSuccessorIntentResult> => {
        const session =
          input.sessionRevision === undefined
            ? null
            : await assessTradingPaperEntrySessionInTransaction(
                tx,
                owner,
                input.ledgerId,
                input.sessionRevision,
              );
        if (session && session.status !== "ready") {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "session_denied",
            sessionReason: session.reason,
          };
        }
        const recurrence = await assessTradingPaperWorkerRecurrencePreflightInTransaction(
          tx,
          owner,
          input.ledgerId,
          now,
        );
        if (recurrence.status !== "ready") {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "recurrence_denied",
            recurrenceReason: recurrence.reason,
            currentGateRevision: recurrence.currentGateRevision,
          };
        }
        if (recurrence.gateRevision !== input.gateRevision) {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "recurrence_scope_changed",
            currentGateRevision: recurrence.gateRevision,
          };
        }
        if (
          !Number.isSafeInteger(recurrence.cadenceMinutes) ||
          recurrence.cadenceMinutes < 5 ||
          recurrence.cadenceMinutes > 1440
        ) {
          throw new PaperWorkerSuccessorIntentIntegrityError("Invalid verified worker cadence");
        }

        const cadenceMs = recurrence.cadenceMinutes * 60_000;
        const intervals = Math.max(
          1,
          Math.floor((now.getTime() - sourceScheduledFor.getTime()) / cadenceMs) + 1,
        );
        const successorScheduledFor = new Date(
          sourceScheduledFor.getTime() + intervals * cadenceMs,
        );
        if (session && successorScheduledFor.getTime() >= Date.parse(session.expiresAt)) {
          return {
            status: "stop",
            mode: "paper_only",
            ledgerId: input.ledgerId,
            reason: "session_denied",
            sessionReason: "successor_after_session_expiry",
          };
        }
        const value = {
          ledgerId: input.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          sourceScheduledFor: sourceScheduledFor.toISOString(),
          successorScheduledFor: successorScheduledFor.toISOString(),
          gateRevision: recurrence.gateRevision,
          recurrenceRevision: recurrence.recurrenceRevision,
          recurrenceApprovalEffectId: recurrence.recurrenceApprovalEffectId,
          workerApprovalEffectId: recurrence.workerApprovalEffectId,
          paperApprovalEffectId: recurrence.paperApprovalEffectId,
        };
        const where = {
          ledgerId_sourceScheduledFor_gateRevision_recurrenceRevision: {
            ledgerId: value.ledgerId,
            sourceScheduledFor,
            gateRevision: value.gateRevision,
            recurrenceRevision: value.recurrenceRevision,
          },
        };
        const existing = await tx.tradingPaperWorkerSuccessorIntent.findUnique({ where });
        if (existing) {
          if (existing.spaceId !== owner.spaceId || existing.userId !== owner.userId) {
            throw new PaperWorkerSuccessorIntentIntegrityError("Successor intent owner mismatch");
          }
          const verified = normalizeIntent(existing);
          if (
            verified.successorScheduledFor !== value.successorScheduledFor ||
            verified.recurrenceApprovalEffectId !== value.recurrenceApprovalEffectId ||
            verified.workerApprovalEffectId !== value.workerApprovalEffectId ||
            verified.paperApprovalEffectId !== value.paperApprovalEffectId
          ) {
            throw new PaperWorkerSuccessorIntentIntegrityError(
              "Existing successor intent disagrees with current authorized plan",
            );
          }
          return { status: "duplicate", mode: "paper_only", ...value };
        }

        await tx.tradingPaperWorkerSuccessorIntent.create({
          data: {
            ledgerId: value.ledgerId,
            spaceId: value.spaceId,
            userId: value.userId,
            sourceScheduledFor,
            successorScheduledFor,
            gateRevision: value.gateRevision,
            recurrenceRevision: value.recurrenceRevision,
            recurrenceApprovalEffectId: value.recurrenceApprovalEffectId,
            workerApprovalEffectId: value.workerApprovalEffectId,
            paperApprovalEffectId: value.paperApprovalEffectId,
            intentSha256: intentDigest(value),
          },
        });
        return { status: "prepared", mode: "paper_only", ...value };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
