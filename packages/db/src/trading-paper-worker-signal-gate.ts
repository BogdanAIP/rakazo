import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { assessTradingPaperWorkerWakePreflightInTransaction } from "./trading-paper-worker-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
const STRATEGY_ID = "breakout_20_1h_v1" as const;

type SignalGateRequest =
  | {
      action: "enable";
      ledgerId: string;
      expectedGateRevision: number;
      strategyId: typeof STRATEGY_ID;
    }
  | {
      action: "disable";
      ledgerId: string;
      expectedGateRevision: number;
    };

export class PaperWorkerSignalGateIntegrityError extends Error {
  constructor(message = "Synthetic paper worker signal gate integrity mismatch") {
    super(message);
    this.name = "PaperWorkerSignalGateIntegrityError";
  }
}

export type TradingPaperWorkerSignalGateStatus =
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
      strategyId: typeof STRATEGY_ID | null;
      policyRevision: number;
      gateRevision: number;
      signalRevision: number;
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperWorkerSignalControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      enabled: boolean;
      strategyId: typeof STRATEGY_ID | null;
      policyRevision: number;
      gateRevision: number;
      signalRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable";
      ledgerId: string;
      error: "stale_gate_revision" | "worker_preflight_denied";
      expectedGateRevision: number;
      currentGateRevision?: number;
      reason?: string;
    };

export type TradingPaperWorkerSignalPreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      strategyId: typeof STRATEGY_ID;
      policyRevision: number;
      gateRevision: number;
      signalRevision: number;
      signalApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason: "signal_gate_disabled" | "worker_preflight_denied" | "signal_gate_worker_changed";
      workerReason?: string;
      currentGateRevision?: number;
    };

function parseRequest(value: unknown): SignalGateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperWorkerSignalGateIntegrityError("Invalid paper worker signal gate payload");
  }
  const row = value as Record<string, unknown>;
  const action = row.action;
  const expectedKeys =
    action === "enable"
      ? ["action", "expected_gate_revision", "ledger_id", "strategy_id"]
      : ["action", "expected_gate_revision", "ledger_id"];
  if (
    (action !== "enable" && action !== "disable") ||
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new PaperWorkerSignalGateIntegrityError("Unexpected paper worker signal gate fields");
  }
  const ledgerId = row.ledger_id;
  const revision = row.expected_gate_revision;
  if (
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new PaperWorkerSignalGateIntegrityError("Invalid paper worker signal gate payload");
  }
  if (action === "disable") {
    return { action, ledgerId, expectedGateRevision: revision as number };
  }
  if (row.strategy_id !== STRATEGY_ID) {
    throw new PaperWorkerSignalGateIntegrityError("Unsupported automatic PAPER strategy");
  }
  return {
    action,
    ledgerId,
    expectedGateRevision: revision as number,
    strategyId: STRATEGY_ID,
  };
}

function digest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  strategyId: typeof STRATEGY_ID | null;
  policyRevision: number;
  gateRevision: number;
  signalRevision: number;
  approvalEffectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.enabled,
        value.strategyId,
        value.policyRevision,
        value.gateRevision,
        value.signalRevision,
        value.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

function normalize(row: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  strategyId: string | null;
  policyRevision: number;
  gateRevision: number;
  signalRevision: number;
  approvalEffectId: string;
  gateSha256: string;
  updatedAt: Date;
}): Extract<TradingPaperWorkerSignalGateStatus, { configured: true }> {
  const strategyId = row.strategyId === STRATEGY_ID ? STRATEGY_ID : null;
  const value = {
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    enabled: row.enabled,
    strategyId,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    signalRevision: row.signalRevision,
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.signalRevision) ||
    row.signalRevision < 1 ||
    (row.enabled ? strategyId !== STRATEGY_ID : row.strategyId !== null) ||
    row.gateSha256 !== digest(value)
  ) {
    throw new PaperWorkerSignalGateIntegrityError();
  }
  return {
    configured: true,
    mode: "paper_only",
    ledgerId: row.ledgerId,
    enabled: row.enabled,
    strategyId,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    signalRevision: row.signalRevision,
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
  if (!ledger) throw new PaperWorkerSignalGateIntegrityError("Paper ledger is unavailable");
}

function objectResult(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function verifyEnabledApproval(
  tx: Prisma.TransactionClient,
  owner: Owner,
  gate: Extract<TradingPaperWorkerSignalGateStatus, { configured: true }>,
): Promise<void> {
  if (!gate.enabled || gate.strategyId !== STRATEGY_ID) {
    throw new PaperWorkerSignalGateIntegrityError("Enabled paper worker signal gate expected");
  }
  const effect = await tx.externalEffect.findUnique({
    where: { id: gate.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_worker_signal_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperWorkerSignalGateIntegrityError(
      "Paper worker signal gate lacks completed explicit approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  if (
    request.action !== "enable" ||
    request.ledgerId !== gate.ledgerId ||
    request.expectedGateRevision !== gate.gateRevision ||
    request.strategyId !== gate.strategyId ||
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== "enable" ||
    result.ledgerId !== gate.ledgerId ||
    result.enabled !== true ||
    result.strategyId !== gate.strategyId ||
    result.policyRevision !== gate.policyRevision ||
    result.gateRevision !== gate.gateRevision ||
    result.signalRevision !== gate.signalRevision
  ) {
    throw new PaperWorkerSignalGateIntegrityError(
      "Paper worker signal approval disagrees with persisted gate",
    );
  }
}

export async function readVerifiedTradingPaperWorkerSignalGate(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperWorkerSignalGateStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerSignalGate.findUnique({ where: { ledgerId } });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerSignalGateIntegrityError("Paper worker signal gate owner mismatch");
        }
        return normalize(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function readTradingPaperWorkerSignalPreflight(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<TradingPaperWorkerSignalPreflight> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<TradingPaperWorkerSignalPreflight> => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerSignalGate.findUnique({ where: { ledgerId } });
        if (!row) {
          return { status: "deny", mode: "paper_only", ledgerId, reason: "signal_gate_disabled" };
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerSignalGateIntegrityError("Paper worker signal gate owner mismatch");
        }
        const gate = normalize(row);
        if (!gate.enabled || gate.strategyId !== STRATEGY_ID) {
          return { status: "deny", mode: "paper_only", ledgerId, reason: "signal_gate_disabled" };
        }
        await verifyEnabledApproval(tx, owner, gate);
        const worker = await assessTradingPaperWorkerWakePreflightInTransaction(
          tx,
          owner,
          ledgerId,
          now,
        );
        if (worker.status !== "ready") {
          return {
            status: "deny",
            mode: "paper_only",
            ledgerId,
            reason: "worker_preflight_denied",
            workerReason: worker.reason,
          };
        }
        if (
          worker.gateRevision !== gate.gateRevision ||
          worker.policyRevision !== gate.policyRevision
        ) {
          return {
            status: "deny",
            mode: "paper_only",
            ledgerId,
            reason: "signal_gate_worker_changed",
            currentGateRevision: worker.gateRevision,
          };
        }
        return {
          status: "ready",
          mode: "paper_only",
          ledgerId,
          strategyId: STRATEGY_ID,
          policyRevision: gate.policyRevision,
          gateRevision: gate.gateRevision,
          signalRevision: gate.signalRevision,
          signalApprovalEffectId: gate.approvalEffectId,
          workerApprovalEffectId: worker.workerApprovalEffectId,
          paperApprovalEffectId: worker.paperApprovalEffectId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function applyApprovedTradingPaperWorkerSignalControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperWorkerSignalControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperWorkerSignalControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_worker_signal_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperWorkerSignalGateIntegrityError(
            "Paper worker signal control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await requireOwnedLedger(tx, owner, request.ledgerId);
        const previous = await tx.tradingPaperWorkerSignalGate.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (previous) {
          if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
            throw new PaperWorkerSignalGateIntegrityError(
              "Paper worker signal gate owner mismatch",
            );
          }
          normalize(previous);
        }

        const complete = async (result: PaperWorkerSignalControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperWorkerSignalGateIntegrityError(
              "Paper worker signal effect completion CAS failed",
            );
          }
          return result;
        };

        let policyRevision = previous?.policyRevision ?? 0;
        let gateRevision = previous?.gateRevision ?? request.expectedGateRevision;
        if (request.action === "enable") {
          const worker = await assessTradingPaperWorkerWakePreflightInTransaction(
            tx,
            owner,
            request.ledgerId,
            new Date(),
          );
          if (worker.status !== "ready") {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "worker_preflight_denied",
              expectedGateRevision: request.expectedGateRevision,
              reason: worker.reason,
            });
          }
          if (worker.gateRevision !== request.expectedGateRevision) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "stale_gate_revision",
              expectedGateRevision: request.expectedGateRevision,
              currentGateRevision: worker.gateRevision,
            });
          }
          policyRevision = worker.policyRevision;
          gateRevision = worker.gateRevision;
        }

        const priorRevision =
          previous && Number.isSafeInteger(previous.signalRevision) && previous.signalRevision >= 1
            ? previous.signalRevision
            : 0;
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          enabled: request.action === "enable",
          strategyId: request.action === "enable" ? STRATEGY_ID : null,
          policyRevision,
          gateRevision,
          signalRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperWorkerSignalGate.upsert({
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
          strategyId: next.strategyId,
          policyRevision: next.policyRevision,
          gateRevision: next.gateRevision,
          signalRevision: next.signalRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
