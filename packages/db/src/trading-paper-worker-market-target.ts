import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { assessTradingPaperWorkerWakePreflightInTransaction } from "./trading-paper-worker-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
type Venue = "okx" | "bingx";
type TargetRequest =
  | { action: "enable"; ledgerId: string; expectedGateRevision: number; venue: Venue; symbol: string }
  | { action: "disable"; ledgerId: string; expectedGateRevision: number };

export class PaperWorkerMarketTargetIntegrityError extends Error {
  constructor(message = "Synthetic paper worker market target integrity mismatch") {
    super(message);
    this.name = "PaperWorkerMarketTargetIntegrityError";
  }
}

export type TradingPaperWorkerMarketTargetStatus =
  | { configured: false; mode: "paper_only"; ledgerId: string; enabled: false }
  | {
      configured: true;
      mode: "paper_only";
      ledgerId: string;
      enabled: boolean;
      venue: Venue | null;
      symbol: string | null;
      gateRevision: number;
      targetRevision: number;
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperWorkerMarketTargetControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      enabled: boolean;
      venue: Venue | null;
      symbol: string | null;
      gateRevision: number;
      targetRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable";
      ledgerId: string;
      error: "stale_gate_revision" | "worker_preflight_denied" | "quote_currency_mismatch";
      expectedGateRevision: number;
      currentGateRevision?: number;
      reason?: string;
    };

export type TradingPaperWorkerMarketTargetPreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      venue: Venue;
      symbol: string;
      gateRevision: number;
      targetRevision: number;
      targetApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason: "target_disabled" | "target_gate_changed" | "worker_preflight_denied";
      workerReason?: string;
      currentGateRevision?: number;
    };

const SYMBOL = /^[A-Z0-9]{2,40}-[A-Z0-9]{2,40}$/u;

function parseRequest(value: unknown): TargetRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperWorkerMarketTargetIntegrityError("Invalid paper market target payload");
  }
  const row = value as Record<string, unknown>;
  const action = row.action;
  const expectedKeys =
    action === "enable"
      ? ["action", "expected_gate_revision", "ledger_id", "symbol", "venue"]
      : ["action", "expected_gate_revision", "ledger_id"];
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)) {
    throw new PaperWorkerMarketTargetIntegrityError("Unexpected paper market target fields");
  }
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
    throw new PaperWorkerMarketTargetIntegrityError("Invalid paper market target payload");
  }
  if (action === "disable") {
    return { action, ledgerId, expectedGateRevision: revision as number };
  }
  const venue = row.venue;
  const symbol = row.symbol;
  if (
    (venue !== "okx" && venue !== "bingx") ||
    typeof symbol !== "string" ||
    !SYMBOL.test(symbol)
  ) {
    throw new PaperWorkerMarketTargetIntegrityError("Invalid paper market target");
  }
  return { action, ledgerId, expectedGateRevision: revision as number, venue, symbol };
}

function targetDigest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  venue: Venue | null;
  symbol: string | null;
  gateRevision: number;
  targetRevision: number;
  approvalEffectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.spaceId,
        value.userId,
        value.enabled,
        value.venue,
        value.symbol,
        value.gateRevision,
        value.targetRevision,
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
  venue: string | null;
  symbol: string | null;
  gateRevision: number;
  targetRevision: number;
  approvalEffectId: string;
  targetSha256: string;
  updatedAt: Date;
}): Extract<TradingPaperWorkerMarketTargetStatus, { configured: true }> {
  const venue = row.venue === "okx" || row.venue === "bingx" ? row.venue : null;
  const value = {
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    enabled: row.enabled,
    venue,
    symbol: row.symbol,
    gateRevision: row.gateRevision,
    targetRevision: row.targetRevision,
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.targetRevision) ||
    row.targetRevision < 1 ||
    (row.enabled
      ? venue === null || row.symbol === null || !SYMBOL.test(row.symbol)
      : row.venue !== null || row.symbol !== null) ||
    row.targetSha256 !== targetDigest(value)
  ) {
    throw new PaperWorkerMarketTargetIntegrityError();
  }
  return {
    configured: true,
    mode: "paper_only",
    ledgerId: row.ledgerId,
    enabled: row.enabled,
    venue,
    symbol: row.symbol,
    gateRevision: row.gateRevision,
    targetRevision: row.targetRevision,
    approvalEffectId: row.approvalEffectId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireOwnedLedger(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<{ quoteCurrency: string }> {
  const ledger = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { quoteCurrency: true },
  });
  if (!ledger) throw new PaperWorkerMarketTargetIntegrityError("Paper ledger is unavailable");
  return ledger;
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
  target: Extract<TradingPaperWorkerMarketTargetStatus, { configured: true }>,
): Promise<void> {
  if (!target.enabled || target.venue === null || target.symbol === null) {
    throw new PaperWorkerMarketTargetIntegrityError("Enabled paper market target expected");
  }
  const effect = await tx.externalEffect.findUnique({
    where: { id: target.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_worker_market_target_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperWorkerMarketTargetIntegrityError(
      "Paper market target lacks completed explicit approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  if (
    request.action !== "enable" ||
    request.ledgerId !== target.ledgerId ||
    request.expectedGateRevision !== target.gateRevision ||
    request.venue !== target.venue ||
    request.symbol !== target.symbol ||
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== "enable" ||
    result.ledgerId !== target.ledgerId ||
    result.enabled !== true ||
    result.venue !== target.venue ||
    result.symbol !== target.symbol ||
    result.gateRevision !== target.gateRevision ||
    result.targetRevision !== target.targetRevision
  ) {
    throw new PaperWorkerMarketTargetIntegrityError(
      "Paper market target approval disagrees with persisted permission",
    );
  }
}

export async function readVerifiedTradingPaperWorkerMarketTarget(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperWorkerMarketTargetStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerMarketTarget.findUnique({ where: { ledgerId } });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerMarketTargetIntegrityError("Paper market target owner mismatch");
        }
        return normalize(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function readTradingPaperWorkerMarketTargetPreflight(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<TradingPaperWorkerMarketTargetPreflight> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<TradingPaperWorkerMarketTargetPreflight> => {
        if (!Number.isFinite(now.getTime())) {
          throw new PaperWorkerMarketTargetIntegrityError("Invalid paper market target clock");
        }
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerMarketTarget.findUnique({ where: { ledgerId } });
        if (!row) {
          return { status: "deny", mode: "paper_only", ledgerId, reason: "target_disabled" };
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerMarketTargetIntegrityError("Paper market target owner mismatch");
        }
        const target = normalize(row);
        if (!target.enabled || target.venue === null || target.symbol === null) {
          return { status: "deny", mode: "paper_only", ledgerId, reason: "target_disabled" };
        }
        await verifyEnabledApproval(tx, owner, target);
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
        if (worker.gateRevision !== target.gateRevision) {
          return {
            status: "deny",
            mode: "paper_only",
            ledgerId,
            reason: "target_gate_changed",
            currentGateRevision: worker.gateRevision,
          };
        }
        return {
          status: "ready",
          mode: "paper_only",
          ledgerId,
          venue: target.venue,
          symbol: target.symbol,
          gateRevision: target.gateRevision,
          targetRevision: target.targetRevision,
          targetApprovalEffectId: target.approvalEffectId,
          workerApprovalEffectId: worker.workerApprovalEffectId,
          paperApprovalEffectId: worker.paperApprovalEffectId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function applyApprovedTradingPaperWorkerMarketTargetControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperWorkerMarketTargetControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperWorkerMarketTargetControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_worker_market_target_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperWorkerMarketTargetIntegrityError(
            "Paper market target control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        const ledger = await requireOwnedLedger(tx, owner, request.ledgerId);
        const previous = await tx.tradingPaperWorkerMarketTarget.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (previous) {
          if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
            throw new PaperWorkerMarketTargetIntegrityError("Paper market target owner mismatch");
          }
          normalize(previous);
        }
        const complete = async (result: PaperWorkerMarketTargetControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperWorkerMarketTargetIntegrityError(
              "Paper market target effect completion CAS failed",
            );
          }
          return result;
        };
        let gateRevision = previous?.gateRevision ?? request.expectedGateRevision;
        let venue: Venue | null = null;
        let symbol: string | null = null;
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
              action: "enable",
              ledgerId: request.ledgerId,
              error: "worker_preflight_denied",
              expectedGateRevision: request.expectedGateRevision,
              reason: preflight.reason,
            });
          }
          gateRevision = preflight.gateRevision;
          if (preflight.gateRevision !== request.expectedGateRevision) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "stale_gate_revision",
              expectedGateRevision: request.expectedGateRevision,
              currentGateRevision: preflight.gateRevision,
            });
          }
          if (request.symbol.split("-").at(-1) !== ledger.quoteCurrency) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "quote_currency_mismatch",
              expectedGateRevision: request.expectedGateRevision,
            });
          }
          venue = request.venue;
          symbol = request.symbol;
        }
        const priorRevision =
          previous && Number.isSafeInteger(previous.targetRevision) && previous.targetRevision >= 1
            ? previous.targetRevision
            : 0;
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          enabled: request.action === "enable",
          venue,
          symbol,
          gateRevision,
          targetRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperWorkerMarketTarget.upsert({
          where: { ledgerId: request.ledgerId },
          create: { ...next, targetSha256: targetDigest(next) },
          update: { ...next, targetSha256: targetDigest(next) },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          enabled: next.enabled,
          venue: next.venue,
          symbol: next.symbol,
          gateRevision: next.gateRevision,
          targetRevision: next.targetRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
