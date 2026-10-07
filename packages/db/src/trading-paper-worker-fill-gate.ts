import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  type TradingPaperWorkerMarketTargetAuthority,
  verifyHistoricalTradingPaperWorkerMarketTargetApprovalInTransaction,
} from "./trading-paper-worker-market-target.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import { assessTradingPaperWorkerSignalPreflightInTransaction } from "./trading-paper-worker-signal-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
const STRATEGY_ID = "breakout_20_1h_v1" as const;

type FillGateRequest =
  | {
      action: "enable";
      ledgerId: string;
      expectedGateRevision: number;
      expectedSignalRevision: number;
      strategyId: typeof STRATEGY_ID;
    }
  | {
      action: "disable";
      ledgerId: string;
      expectedGateRevision: number;
      expectedSignalRevision: number;
    };

export class PaperWorkerFillGateIntegrityError extends Error {
  constructor(message = "Synthetic paper worker fill gate integrity mismatch") {
    super(message);
    this.name = "PaperWorkerFillGateIntegrityError";
  }
}

export type TradingPaperWorkerFillGateStatus =
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
      fillRevision: number;
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperWorkerFillControlResult =
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
      fillRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable";
      ledgerId: string;
      error: "stale_gate_revision" | "stale_signal_revision" | "signal_preflight_denied";
      expectedGateRevision: number;
      expectedSignalRevision: number;
      currentGateRevision?: number;
      currentSignalRevision?: number;
      reason?: string;
    };

export type TradingPaperWorkerFillPreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      strategyId: typeof STRATEGY_ID;
      policyRevision: number;
      gateRevision: number;
      signalRevision: number;
      fillRevision: number;
      fillApprovalEffectId: string;
      signalApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason: "fill_gate_disabled" | "signal_preflight_denied" | "fill_gate_signal_changed";
      signalReason?: string;
      currentGateRevision?: number;
      currentSignalRevision?: number;
    };

export type TradingPaperWorkerFillAuthority = Extract<
  TradingPaperWorkerFillPreflight,
  { status: "ready" }
>;

function sameFillAuthority(
  left: TradingPaperWorkerFillAuthority,
  right: TradingPaperWorkerFillAuthority,
): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.strategyId === right.strategyId &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.signalRevision === right.signalRevision &&
    left.fillRevision === right.fillRevision &&
    left.fillApprovalEffectId === right.fillApprovalEffectId &&
    left.signalApprovalEffectId === right.signalApprovalEffectId &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId
  );
}

function parseRequest(value: unknown): FillGateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperWorkerFillGateIntegrityError("Invalid paper worker fill gate payload");
  }
  const row = value as Record<string, unknown>;
  const action = row.action;
  const expectedKeys =
    action === "enable"
      ? ["action", "expected_gate_revision", "expected_signal_revision", "ledger_id", "strategy_id"]
      : ["action", "expected_gate_revision", "expected_signal_revision", "ledger_id"];
  if (
    (action !== "enable" && action !== "disable") ||
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new PaperWorkerFillGateIntegrityError("Unexpected paper worker fill gate fields");
  }
  const ledgerId = row.ledger_id;
  const gateRevision = row.expected_gate_revision;
  const signalRevision = row.expected_signal_revision;
  if (
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(gateRevision) ||
    (gateRevision as number) < 0 ||
    !Number.isSafeInteger(signalRevision) ||
    (signalRevision as number) < 0
  ) {
    throw new PaperWorkerFillGateIntegrityError("Invalid paper worker fill gate payload");
  }
  if (action === "disable") {
    return {
      action,
      ledgerId,
      expectedGateRevision: gateRevision as number,
      expectedSignalRevision: signalRevision as number,
    };
  }
  if (row.strategy_id !== STRATEGY_ID) {
    throw new PaperWorkerFillGateIntegrityError("Unsupported automatic PAPER fill strategy");
  }
  return {
    action,
    ledgerId,
    expectedGateRevision: gateRevision as number,
    expectedSignalRevision: signalRevision as number,
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
  fillRevision: number;
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
        value.fillRevision,
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
  fillRevision: number;
  approvalEffectId: string;
  gateSha256: string;
  updatedAt: Date;
}): Extract<TradingPaperWorkerFillGateStatus, { configured: true }> {
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
    fillRevision: row.fillRevision,
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.signalRevision) ||
    row.signalRevision < 0 ||
    !Number.isSafeInteger(row.fillRevision) ||
    row.fillRevision < 1 ||
    (row.enabled
      ? strategyId !== STRATEGY_ID || row.signalRevision < 1
      : row.strategyId !== null) ||
    row.gateSha256 !== digest(value)
  ) {
    throw new PaperWorkerFillGateIntegrityError();
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
    fillRevision: row.fillRevision,
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
  if (!ledger) throw new PaperWorkerFillGateIntegrityError("Paper ledger is unavailable");
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
  gate: Extract<TradingPaperWorkerFillGateStatus, { configured: true }>,
): Promise<void> {
  if (!gate.enabled || gate.strategyId !== STRATEGY_ID) {
    throw new PaperWorkerFillGateIntegrityError("Enabled paper worker fill gate expected");
  }
  const effect = await tx.externalEffect.findUnique({
    where: { id: gate.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_worker_fill_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperWorkerFillGateIntegrityError(
      "Paper worker fill gate lacks completed explicit approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  if (
    request.action !== "enable" ||
    request.ledgerId !== gate.ledgerId ||
    request.expectedGateRevision !== gate.gateRevision ||
    request.expectedSignalRevision !== gate.signalRevision ||
    request.strategyId !== gate.strategyId ||
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== "enable" ||
    result.ledgerId !== gate.ledgerId ||
    result.enabled !== true ||
    result.strategyId !== gate.strategyId ||
    result.policyRevision !== gate.policyRevision ||
    result.gateRevision !== gate.gateRevision ||
    result.signalRevision !== gate.signalRevision ||
    result.fillRevision !== gate.fillRevision
  ) {
    throw new PaperWorkerFillGateIntegrityError(
      "Paper worker fill approval disagrees with persisted gate",
    );
  }
}

type WorkerFillUseInput = {
  reservationId: string;
  signalId: string;
  evidenceId: string;
  reserveEventSequence: number;
  fillEventSequence: number;
  actedAt: string;
};

function fillUseDigest(value: {
  ledgerId: string;
  reservationId: string;
  spaceId: string;
  userId: string;
  signalId: string;
  fillApprovalEffectId: string;
  targetApprovalEffectId: string;
  strategyId: typeof STRATEGY_ID;
  venue: "okx" | "bingx";
  symbol: string;
  policyRevision: number;
  gateRevision: number;
  signalRevision: number;
  fillRevision: number;
  targetRevision: number;
  evidenceId: string;
  reserveEventSequence: number;
  fillEventSequence: number;
  actedAt: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.reservationId,
        value.spaceId,
        value.userId,
        value.signalId,
        value.fillApprovalEffectId,
        value.targetApprovalEffectId,
        value.strategyId,
        value.venue,
        value.symbol,
        value.policyRevision,
        value.gateRevision,
        value.signalRevision,
        value.fillRevision,
        value.targetRevision,
        value.evidenceId,
        value.reserveEventSequence,
        value.fillEventSequence,
        value.actedAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

function normalizeFillUse(row: {
  ledgerId: string;
  reservationId: string;
  spaceId: string;
  userId: string;
  signalId: string;
  fillApprovalEffectId: string;
  targetApprovalEffectId: string;
  strategyId: string;
  venue: string;
  symbol: string;
  policyRevision: number;
  gateRevision: number;
  signalRevision: number;
  fillRevision: number;
  targetRevision: number;
  evidenceId: string;
  reserveEventSequence: number;
  fillEventSequence: number;
  actedAt: Date;
  useSha256: string;
}) {
  const strategyId = row.strategyId === STRATEGY_ID ? STRATEGY_ID : null;
  const venue = row.venue === "okx" || row.venue === "bingx" ? row.venue : null;
  if (
    strategyId !== STRATEGY_ID ||
    venue === null ||
    !/^[A-Z0-9]{2,40}-[A-Z0-9]{2,40}$/u.test(row.symbol) ||
    !row.evidenceId ||
    row.evidenceId.length > 128 ||
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.signalRevision) ||
    row.signalRevision < 1 ||
    !Number.isSafeInteger(row.fillRevision) ||
    row.fillRevision < 1 ||
    !Number.isSafeInteger(row.targetRevision) ||
    row.targetRevision < 1 ||
    !Number.isSafeInteger(row.reserveEventSequence) ||
    row.reserveEventSequence < 1 ||
    !Number.isSafeInteger(row.fillEventSequence) ||
    row.fillEventSequence <= row.reserveEventSequence
  ) {
    throw new PaperWorkerFillGateIntegrityError("Automatic paper fill provenance is invalid");
  }
  const value = {
    ledgerId: row.ledgerId,
    reservationId: row.reservationId,
    spaceId: row.spaceId,
    userId: row.userId,
    signalId: row.signalId,
    fillApprovalEffectId: row.fillApprovalEffectId,
    targetApprovalEffectId: row.targetApprovalEffectId,
    strategyId,
    venue,
    symbol: row.symbol,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    signalRevision: row.signalRevision,
    fillRevision: row.fillRevision,
    targetRevision: row.targetRevision,
    evidenceId: row.evidenceId,
    reserveEventSequence: row.reserveEventSequence,
    fillEventSequence: row.fillEventSequence,
    actedAt: row.actedAt.toISOString(),
  };
  if (row.useSha256 !== fillUseDigest(value)) {
    throw new PaperWorkerFillGateIntegrityError("Automatic paper fill provenance digest mismatch");
  }
  return value;
}

export async function verifyTradingPaperWorkerFillAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  expected: TradingPaperWorkerFillAuthority,
  now: Date,
): Promise<TradingPaperWorkerFillAuthority | null> {
  const current = await assessTradingPaperWorkerFillPreflightInTransaction(
    tx,
    owner,
    expected.ledgerId,
    now,
  );
  return current.status === "ready" && sameFillAuthority(expected, current) ? current : null;
}

export async function recordTradingPaperWorkerFillUseInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  authority: TradingPaperWorkerFillAuthority,
  targetAuthority: TradingPaperWorkerMarketTargetAuthority,
  input: WorkerFillUseInput,
): Promise<void> {
  await requireOwnedLedger(tx, owner, authority.ledgerId);
  const actedAt = new Date(input.actedAt);
  if (
    targetAuthority.ledgerId !== authority.ledgerId ||
    targetAuthority.gateRevision !== authority.gateRevision
  ) {
    throw new PaperWorkerFillGateIntegrityError(
      "Automatic paper fill target authority is outside F2 scope",
    );
  }
  if (
    !Number.isFinite(actedAt.getTime()) ||
    !input.reservationId ||
    input.reservationId.length > 128 ||
    !input.signalId ||
    input.signalId.length > 128 ||
    !input.evidenceId ||
    input.evidenceId.length > 128 ||
    !Number.isSafeInteger(input.reserveEventSequence) ||
    input.reserveEventSequence < 1 ||
    !Number.isSafeInteger(input.fillEventSequence) ||
    input.fillEventSequence <= input.reserveEventSequence
  ) {
    throw new PaperWorkerFillGateIntegrityError("Invalid automatic paper fill provenance scope");
  }
  const value = {
    ledgerId: authority.ledgerId,
    reservationId: input.reservationId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    signalId: input.signalId,
    fillApprovalEffectId: authority.fillApprovalEffectId,
    targetApprovalEffectId: targetAuthority.targetApprovalEffectId,
    strategyId: authority.strategyId,
    venue: targetAuthority.venue,
    symbol: targetAuthority.symbol,
    policyRevision: authority.policyRevision,
    gateRevision: authority.gateRevision,
    signalRevision: authority.signalRevision,
    fillRevision: authority.fillRevision,
    targetRevision: targetAuthority.targetRevision,
    evidenceId: input.evidenceId,
    reserveEventSequence: input.reserveEventSequence,
    fillEventSequence: input.fillEventSequence,
    actedAt: actedAt.toISOString(),
  };
  await tx.tradingPaperWorkerFillUse.create({
    data: {
      ...value,
      actedAt,
      useSha256: fillUseDigest(value),
    },
  });
}

export type HistoricalTradingPaperWorkerFillScope = {
  ledgerId: string;
  reservationId: string;
  signalId: string;
  policyRevision: number;
  evidenceId: string;
  reserveEventSequence: number;
  fillEventSequence: number;
  actedAt: string;
};

export async function verifyHistoricalTradingPaperWorkerFillApprovalInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  effectId: string,
  expected: HistoricalTradingPaperWorkerFillScope,
): Promise<boolean> {
  await requireOwnedLedger(tx, owner, expected.ledgerId);
  const row = await tx.tradingPaperWorkerFillUse.findUnique({
    where: {
      ledgerId_reservationId: {
        ledgerId: expected.ledgerId,
        reservationId: expected.reservationId,
      },
    },
  });
  if (!row) return false;
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperWorkerFillGateIntegrityError("Automatic paper fill provenance owner mismatch");
  }
  const use = normalizeFillUse(row);
  if (use.fillApprovalEffectId !== effectId) return false;

  const effect = await tx.externalEffect.findUnique({
    where: { id: effectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_worker_fill_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperWorkerFillGateIntegrityError(
      "Historical automatic fill lacks explicit F2 approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  const targetApproved =
    await verifyHistoricalTradingPaperWorkerMarketTargetApprovalInTransaction(
      tx,
      owner,
      use.targetApprovalEffectId,
      {
        ledgerId: use.ledgerId,
        venue: use.venue,
        symbol: use.symbol,
        gateRevision: use.gateRevision,
        targetRevision: use.targetRevision,
      },
    );
  if (!targetApproved) {
    throw new PaperWorkerFillGateIntegrityError(
      "Historical automatic fill lacks matching market-target approval",
    );
  }
  const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
    tx,
    owner,
    use.ledgerId,
    use.evidenceId,
  );
  if (
    !evidence ||
    evidence.market.venue !== use.venue ||
    evidence.market.symbol !== use.symbol
  ) {
    throw new PaperWorkerFillGateIntegrityError(
      "Historical automatic fill evidence disagrees with approved target",
    );
  }

  if (
    request.action !== "enable" ||
    request.ledgerId !== use.ledgerId ||
    request.expectedGateRevision !== use.gateRevision ||
    request.expectedSignalRevision !== use.signalRevision ||
    request.strategyId !== use.strategyId ||
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== "enable" ||
    result.ledgerId !== use.ledgerId ||
    result.enabled !== true ||
    result.strategyId !== use.strategyId ||
    result.policyRevision !== use.policyRevision ||
    result.gateRevision !== use.gateRevision ||
    result.signalRevision !== use.signalRevision ||
    result.fillRevision !== use.fillRevision
  ) {
    throw new PaperWorkerFillGateIntegrityError(
      "Historical automatic fill approval disagrees with persisted provenance",
    );
  }
  return (
    expected.ledgerId === use.ledgerId &&
    expected.reservationId === use.reservationId &&
    expected.signalId === use.signalId &&
    expected.policyRevision === use.policyRevision &&
    expected.evidenceId === use.evidenceId &&
    expected.reserveEventSequence === use.reserveEventSequence &&
    expected.fillEventSequence === use.fillEventSequence &&
    expected.actedAt === use.actedAt
  );
}

export async function readVerifiedTradingPaperWorkerFillGate(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperWorkerFillGateStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperWorkerFillGate.findUnique({ where: { ledgerId } });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperWorkerFillGateIntegrityError("Paper worker fill gate owner mismatch");
        }
        return normalize(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function assessTradingPaperWorkerFillPreflightInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  now: Date,
): Promise<TradingPaperWorkerFillPreflight> {
  await requireOwnedLedger(tx, owner, ledgerId);
  const row = await tx.tradingPaperWorkerFillGate.findUnique({ where: { ledgerId } });
  if (!row) {
    return { status: "deny", mode: "paper_only", ledgerId, reason: "fill_gate_disabled" };
  }
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperWorkerFillGateIntegrityError("Paper worker fill gate owner mismatch");
  }
  const gate = normalize(row);
  if (!gate.enabled || gate.strategyId !== STRATEGY_ID) {
    return { status: "deny", mode: "paper_only", ledgerId, reason: "fill_gate_disabled" };
  }
  await verifyEnabledApproval(tx, owner, gate);
  const signal = await assessTradingPaperWorkerSignalPreflightInTransaction(
    tx,
    owner,
    ledgerId,
    now,
  );
  if (signal.status !== "ready") {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "signal_preflight_denied",
      signalReason: signal.reason,
    };
  }
  if (
    signal.strategyId !== gate.strategyId ||
    signal.policyRevision !== gate.policyRevision ||
    signal.gateRevision !== gate.gateRevision ||
    signal.signalRevision !== gate.signalRevision
  ) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "fill_gate_signal_changed",
      currentGateRevision: signal.gateRevision,
      currentSignalRevision: signal.signalRevision,
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
    fillRevision: gate.fillRevision,
    fillApprovalEffectId: gate.approvalEffectId,
    signalApprovalEffectId: signal.signalApprovalEffectId,
    workerApprovalEffectId: signal.workerApprovalEffectId,
    paperApprovalEffectId: signal.paperApprovalEffectId,
  };
}

export async function readTradingPaperWorkerFillPreflight(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<TradingPaperWorkerFillPreflight> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx) => assessTradingPaperWorkerFillPreflightInTransaction(tx, owner, ledgerId, now),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function applyApprovedTradingPaperWorkerFillControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperWorkerFillControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperWorkerFillControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_worker_fill_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperWorkerFillGateIntegrityError(
            "Paper worker fill control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await requireOwnedLedger(tx, owner, request.ledgerId);
        const previous = await tx.tradingPaperWorkerFillGate.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (previous) {
          if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
            throw new PaperWorkerFillGateIntegrityError("Paper worker fill gate owner mismatch");
          }
          normalize(previous);
        }

        const complete = async (result: PaperWorkerFillControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperWorkerFillGateIntegrityError(
              "Paper worker fill effect completion CAS failed",
            );
          }
          return result;
        };

        let policyRevision = previous?.policyRevision ?? 0;
        let gateRevision = previous?.gateRevision ?? request.expectedGateRevision;
        let signalRevision = previous?.signalRevision ?? request.expectedSignalRevision;
        let strategyId: typeof STRATEGY_ID | null =
          previous?.strategyId === STRATEGY_ID ? STRATEGY_ID : null;

        if (request.action === "enable") {
          const signal = await assessTradingPaperWorkerSignalPreflightInTransaction(
            tx,
            owner,
            request.ledgerId,
            new Date(),
          );
          if (signal.status !== "ready") {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "signal_preflight_denied",
              expectedGateRevision: request.expectedGateRevision,
              expectedSignalRevision: request.expectedSignalRevision,
              reason: signal.reason,
            });
          }
          if (signal.gateRevision !== request.expectedGateRevision) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "stale_gate_revision",
              expectedGateRevision: request.expectedGateRevision,
              expectedSignalRevision: request.expectedSignalRevision,
              currentGateRevision: signal.gateRevision,
              currentSignalRevision: signal.signalRevision,
            });
          }
          if (signal.signalRevision !== request.expectedSignalRevision) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "stale_signal_revision",
              expectedGateRevision: request.expectedGateRevision,
              expectedSignalRevision: request.expectedSignalRevision,
              currentGateRevision: signal.gateRevision,
              currentSignalRevision: signal.signalRevision,
            });
          }
          if (signal.strategyId !== request.strategyId) {
            throw new PaperWorkerFillGateIntegrityError(
              "Paper worker fill strategy disagrees with signal gate",
            );
          }
          policyRevision = signal.policyRevision;
          gateRevision = signal.gateRevision;
          signalRevision = signal.signalRevision;
          strategyId = signal.strategyId;
        }

        const priorRevision =
          previous && Number.isSafeInteger(previous.fillRevision) && previous.fillRevision >= 1
            ? previous.fillRevision
            : 0;
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          enabled: request.action === "enable",
          strategyId: request.action === "enable" ? strategyId : null,
          policyRevision,
          gateRevision,
          signalRevision,
          fillRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperWorkerFillGate.upsert({
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
          fillRevision: next.fillRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
