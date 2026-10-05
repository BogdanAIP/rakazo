import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { assessTradingPaperWorkerWakePreflightInTransaction } from "./trading-paper-worker-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

type RecurrenceRequest = {
  action: "enable" | "disable";
  ledgerId: string;
  expectedGateRevision: number;
};

export class PaperWorkerRecurrenceIntegrityError extends Error {
  constructor(message = "Synthetic paper worker recurrence integrity mismatch") {
    super(message);
    this.name = "PaperWorkerRecurrenceIntegrityError";
  }
}

export type TradingPaperWorkerRecurrenceStatus =
  | {
      configured: false;
      mode: "paper_only";
      ledgerId: string;
      enabled: false;
    }
  | {
      configured: true;
      mode: "paper_only";
      ledgerId: string;
      enabled: boolean;
      gateRevision: number;
      recurrenceRevision: number;
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperWorkerRecurrenceControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      enabled: boolean;
      gateRevision: number;
      recurrenceRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      error: "stale_gate_revision" | "preflight_denied";
      expectedGateRevision: number;
      currentGateRevision?: number;
      reason?: string;
    };

function parseRequest(value: unknown): RecurrenceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperWorkerRecurrenceIntegrityError("Invalid paper worker recurrence payload");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(["action", "expected_gate_revision", "ledger_id"])
  ) {
    throw new PaperWorkerRecurrenceIntegrityError(
      "Unexpected paper worker recurrence approval fields",
    );
  }
  const action = row.action;
  const ledgerId = row.ledger_id;
  const revision = row.expected_gate_revision;
  if (
    (action !== "enable" && action !== "disable") ||
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new PaperWorkerRecurrenceIntegrityError("Invalid paper worker recurrence payload");
  }
  return {
    action,
    ledgerId,
    expectedGateRevision: revision as number,
  };
}

function recurrenceDigest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  gateRevision: number;
  recurrenceRevision: number;
  approvalEffectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.enabled,
        value.gateRevision,
        value.recurrenceRevision,
        value.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

function normalizeRecurrence(row: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  gateRevision: number;
  recurrenceRevision: number;
  approvalEffectId: string;
  recurrenceSha256: string;
  updatedAt: Date;
}) {
  const value = {
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    enabled: row.enabled,
    gateRevision: row.gateRevision,
    recurrenceRevision: row.recurrenceRevision,
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.recurrenceRevision) ||
    row.recurrenceRevision < 1 ||
    row.recurrenceSha256 !== recurrenceDigest(value)
  ) {
    throw new PaperWorkerRecurrenceIntegrityError();
  }
  return {
    configured: true as const,
    mode: "paper_only" as const,
    ledgerId: row.ledgerId,
    enabled: row.enabled,
    gateRevision: row.gateRevision,
    recurrenceRevision: row.recurrenceRevision,
    approvalEffectId: row.approvalEffectId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireOwnedLedger(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<void> {
  const ledger = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { id: true },
  });
  if (!ledger) throw new PaperWorkerRecurrenceIntegrityError("Paper ledger is unavailable");
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function readVerifiedTradingPaperWorkerRecurrence(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperWorkerRecurrenceStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerRecurrence.findUnique({ where: { ledgerId } });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerRecurrenceIntegrityError("Paper worker recurrence owner mismatch");
        }
        return normalizeRecurrence(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Persists explicit permission only. No JobPublisher is available here. */
export async function applyApprovedTradingPaperWorkerRecurrenceControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperWorkerRecurrenceControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperWorkerRecurrenceControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_worker_recurrence_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperWorkerRecurrenceIntegrityError(
            "Paper worker recurrence control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await requireOwnedLedger(tx, owner, request.ledgerId);

        const complete = async (result: PaperWorkerRecurrenceControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperWorkerRecurrenceIntegrityError(
              "Paper worker recurrence effect completion CAS failed",
            );
          }
          return result;
        };

        const previous = await tx.tradingPaperWorkerRecurrence.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (previous) {
          if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
            throw new PaperWorkerRecurrenceIntegrityError(
              "Paper worker recurrence owner mismatch",
            );
          }
          normalizeRecurrence(previous);
        }

        let gateRevision =
          previous?.gateRevision ?? request.expectedGateRevision;

        if (request.action === "enable") {
          const preflight = await assessTradingPaperWorkerWakePreflightInTransaction(
            tx,
            owner,
            request.ledgerId,
            new Date(),
          );
          if (preflight.status !== "ready") {
            return complete({
              ok: false,
              mode: "paper_only",
              action: request.action,
              ledgerId: request.ledgerId,
              error: "preflight_denied",
              expectedGateRevision: request.expectedGateRevision,
              reason: preflight.reason,
            });
          }
          gateRevision = preflight.gateRevision;
          if (preflight.gateRevision !== request.expectedGateRevision) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: request.action,
              ledgerId: request.ledgerId,
              error: "stale_gate_revision",
              expectedGateRevision: request.expectedGateRevision,
              currentGateRevision: preflight.gateRevision,
            });
          }
        }

        const priorRevision =
          previous &&
          Number.isSafeInteger(previous.recurrenceRevision) &&
          previous.recurrenceRevision >= 1
            ? previous.recurrenceRevision
            : 0;
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          enabled: request.action === "enable",
          gateRevision,
          recurrenceRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperWorkerRecurrence.upsert({
          where: { ledgerId: request.ledgerId },
          create: { ...next, recurrenceSha256: recurrenceDigest(next) },
          update: { ...next, recurrenceSha256: recurrenceDigest(next) },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          enabled: next.enabled,
          gateRevision: next.gateRevision,
          recurrenceRevision: next.recurrenceRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
