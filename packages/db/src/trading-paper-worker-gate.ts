import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
const MIN_CADENCE_MINUTES = 5;
const MAX_CADENCE_MINUTES = 1440;

type WorkerRequest = {
  action: "enable" | "disable";
  ledgerId: string;
  expectedPolicyRevision: number;
  cadenceMinutes: number | null;
};

export class PaperWorkerGateIntegrityError extends Error {
  constructor(message = "Synthetic paper worker gate integrity mismatch") {
    super(message);
    this.name = "PaperWorkerGateIntegrityError";
  }
}

export type TradingPaperWorkerGateStatus =
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
      cadenceMinutes: number | null;
      policyRevision: number;
      gateRevision: number;
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperWorkerControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      enabled: boolean;
      cadenceMinutes: number | null;
      policyRevision: number;
      gateRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      error: "stale_policy_revision" | "paper_capability_disabled" | "reconciliation_required";
      currentPolicyRevision: number;
    };

function digest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  cadenceMinutes: number | null;
  policyRevision: number;
  gateRevision: number;
  approvalEffectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.enabled,
        value.cadenceMinutes,
        value.policyRevision,
        value.gateRevision,
        value.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

function parseRequest(value: unknown): WorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperWorkerGateIntegrityError("Invalid paper worker approval payload");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const allowedEnable = ["action", "cadence_minutes", "expected_policy_revision", "ledger_id"];
  const allowedDisable = ["action", "expected_policy_revision", "ledger_id"];
  const action = row.action;
  if (action !== "enable" && action !== "disable") {
    throw new PaperWorkerGateIntegrityError("Invalid paper worker action");
  }
  const expectedKeys = action === "enable" ? allowedEnable : allowedDisable;
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new PaperWorkerGateIntegrityError("Unexpected paper worker approval fields");
  }
  const ledgerId = row.ledger_id;
  const revision = row.expected_policy_revision;
  if (
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new PaperWorkerGateIntegrityError("Invalid paper worker approval payload");
  }
  let cadenceMinutes: number | null = null;
  if (action === "enable") {
    const cadence = row.cadence_minutes;
    if (
      !Number.isSafeInteger(cadence) ||
      (cadence as number) < MIN_CADENCE_MINUTES ||
      (cadence as number) > MAX_CADENCE_MINUTES
    ) {
      throw new PaperWorkerGateIntegrityError(
        "Paper worker cadence must be a whole number from 5 to 1440 minutes",
      );
    }
    cadenceMinutes = cadence as number;
  }
  return {
    action,
    ledgerId,
    expectedPolicyRevision: revision as number,
    cadenceMinutes,
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
  if (!ledger) throw new PaperWorkerGateIntegrityError("Paper ledger is unavailable");
}

function normalizeGate(row: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  cadenceMinutes: number | null;
  policyRevision: number;
  gateRevision: number;
  approvalEffectId: string;
  gateSha256: string;
  updatedAt: Date;
}) {
  const value = {
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    enabled: row.enabled,
    cadenceMinutes: row.cadenceMinutes,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    (row.enabled
      ? row.cadenceMinutes === null ||
        !Number.isSafeInteger(row.cadenceMinutes) ||
        row.cadenceMinutes < MIN_CADENCE_MINUTES ||
        row.cadenceMinutes > MAX_CADENCE_MINUTES
      : row.cadenceMinutes !== null) ||
    row.gateSha256 !== digest(value)
  ) {
    throw new PaperWorkerGateIntegrityError();
  }
  return {
    configured: true as const,
    mode: "paper_only" as const,
    ledgerId: row.ledgerId,
    enabled: row.enabled,
    cadenceMinutes: row.cadenceMinutes,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    approvalEffectId: row.approvalEffectId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readVerifiedTradingPaperWorkerGate(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperWorkerGateStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerGate.findUnique({ where: { ledgerId } });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerGateIntegrityError("Paper worker gate owner mismatch");
        }
        return normalizeGate(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Applies an already-claimed explicit owner approval. This only writes a
 * default-deny permission/config row; no Graphile job or schedule is created. */
export async function applyApprovedTradingPaperWorkerControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperWorkerControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperWorkerControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { id: true, spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_worker_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperWorkerGateIntegrityError(
            "Paper worker control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, request.ledgerId);
        const policy = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, request.ledgerId);

        const complete = async (result: PaperWorkerControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperWorkerGateIntegrityError("Paper worker effect completion CAS failed");
          }
          return result;
        };
        const fail = (error: Extract<PaperWorkerControlResult, { ok: false }>["error"]) =>
          complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            error,
            currentPolicyRevision: policy.revision,
          });

        if (policy.revision !== request.expectedPolicyRevision) {
          return fail("stale_policy_revision");
        }

        let previous = await tx.tradingPaperWorkerGate.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (request.action === "enable") {
          if (!policy.policy.enabled || policy.policy.killSwitch) {
            return fail("paper_capability_disabled");
          }
          const lifecycle = await auditTradingPaperLifecycleInTransaction(
            tx,
            owner,
            request.ledgerId,
            new Date(),
          );
          if (lifecycle.openReservations > 0) {
            return fail("reconciliation_required");
          }
          if (previous) {
            if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
              throw new PaperWorkerGateIntegrityError("Paper worker gate owner mismatch");
            }
            normalizeGate(previous);
          }
        }

        const priorRevision =
          previous && Number.isSafeInteger(previous.gateRevision) && previous.gateRevision >= 0
            ? previous.gateRevision
            : 0;
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          enabled: request.action === "enable",
          cadenceMinutes: request.action === "enable" ? request.cadenceMinutes : null,
          policyRevision: policy.revision,
          gateRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperWorkerGate.upsert({
          where: { ledgerId: request.ledgerId },
          create: { ...next, gateSha256: digest(next) },
          update: { ...next, gateSha256: digest(next) },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          enabled: next.enabled,
          cadenceMinutes: next.cadenceMinutes,
          policyRevision: next.policyRevision,
          gateRevision: next.gateRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
