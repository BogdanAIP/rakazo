import { createHash } from "node:crypto";
import {
  type TradingInstrument,
  type TradingResolvedResearchApprovalScope,
  TradingResolvedResearchApprovalScopeSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import {
  assessTradingPaperResolvedResearchScopeAuthorityInTransaction,
  verifyTradingPaperResolvedResearchReserveUseScopeInTransaction,
} from "./trading-paper-resolved-research-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

type ResolvedResearchFillGateRequest =
  | {
      action: "enable";
      ledgerId: string;
      expectedGateRevision: number;
      expectedResearchRevision: number;
      scope: TradingResolvedResearchApprovalScope;
    }
  | {
      action: "disable";
      ledgerId: string;
      expectedGateRevision: number;
      expectedResearchRevision: number;
    };

export class PaperResolvedResearchFillGateIntegrityError extends Error {
  constructor(message = "Resolved research PAPER fill gate integrity mismatch") {
    super(message);
    this.name = "PaperResolvedResearchFillGateIntegrityError";
  }
}

export type TradingPaperResolvedResearchFillGateStatus =
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
      scope: TradingResolvedResearchApprovalScope | null;
      policyRevision: number;
      gateRevision: number;
      researchRevision: number;
      fillRevision: number;
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperResolvedResearchFillControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      enabled: boolean;
      scope: TradingResolvedResearchApprovalScope | null;
      policyRevision: number;
      gateRevision: number;
      researchRevision: number;
      fillRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable";
      ledgerId: string;
      error:
        | "stale_gate_revision"
        | "stale_research_revision"
        | "resolved_research_preflight_denied";
      expectedGateRevision: number;
      expectedResearchRevision: number;
      currentGateRevision?: number;
      currentResearchRevision?: number;
      reason?: string;
    };

export type TradingPaperResolvedResearchFillPreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      scope: TradingResolvedResearchApprovalScope;
      policyRevision: number;
      gateRevision: number;
      researchRevision: number;
      fillRevision: number;
      fillApprovalEffectId: string;
      researchApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason:
        | "resolved_fill_gate_disabled"
        | "resolved_research_preflight_denied"
        | "resolved_fill_gate_research_changed";
      researchReason?: string;
      currentGateRevision?: number;
      currentResearchRevision?: number;
    };

export type TradingPaperResolvedResearchFillAuthority = Extract<
  TradingPaperResolvedResearchFillPreflight,
  { status: "ready" }
>;

function canonicalScope(value: unknown): TradingResolvedResearchApprovalScope {
  return TradingResolvedResearchApprovalScopeSchema.parse(value);
}

function sameScope(
  left: TradingResolvedResearchApprovalScope,
  right: TradingResolvedResearchApprovalScope,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseRequest(value: unknown): ResolvedResearchFillGateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Invalid resolved research fill gate payload",
    );
  }
  const row = value as Record<string, unknown>;
  const action = row.action;
  const expectedKeys =
    action === "enable"
      ? ["action", "expected_gate_revision", "expected_research_revision", "ledger_id", "scope"]
      : ["action", "expected_gate_revision", "expected_research_revision", "ledger_id"];
  if (
    (action !== "enable" && action !== "disable") ||
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Unexpected resolved research fill gate fields",
    );
  }
  const ledgerId = row.ledger_id;
  const gateRevision = row.expected_gate_revision;
  const researchRevision = row.expected_research_revision;
  if (
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(gateRevision) ||
    (gateRevision as number) < 0 ||
    !Number.isSafeInteger(researchRevision) ||
    (researchRevision as number) < 0
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Invalid resolved research fill gate payload",
    );
  }
  if (action === "disable") {
    return {
      action,
      ledgerId,
      expectedGateRevision: gateRevision as number,
      expectedResearchRevision: researchRevision as number,
    };
  }
  let scope: TradingResolvedResearchApprovalScope;
  try {
    scope = canonicalScope(row.scope);
  } catch {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Invalid resolved research fill approval scope",
    );
  }
  return {
    action,
    ledgerId,
    expectedGateRevision: gateRevision as number,
    expectedResearchRevision: researchRevision as number,
    scope,
  };
}

function digest(value: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  scope: TradingResolvedResearchApprovalScope | null;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
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
        value.scope,
        value.policyRevision,
        value.gateRevision,
        value.researchRevision,
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
  scope: Prisma.JsonValue | null;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  fillRevision: number;
  approvalEffectId: string;
  gateSha256: string;
  updatedAt: Date;
}): Extract<TradingPaperResolvedResearchFillGateStatus, { configured: true }> {
  let scope: TradingResolvedResearchApprovalScope | null = null;
  if (row.scope !== null) {
    try {
      scope = canonicalScope(row.scope);
    } catch {
      throw new PaperResolvedResearchFillGateIntegrityError(
        "Stored resolved research fill scope invalid",
      );
    }
  }
  const value = {
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    enabled: row.enabled,
    scope,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    researchRevision: row.researchRevision,
    fillRevision: row.fillRevision,
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.researchRevision) ||
    row.researchRevision < 0 ||
    !Number.isSafeInteger(row.fillRevision) ||
    row.fillRevision < 1 ||
    (row.enabled ? scope === null || row.researchRevision < 1 : scope !== null) ||
    row.gateSha256 !== digest(value)
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError();
  }
  return {
    configured: true,
    mode: "paper_only",
    ledgerId: row.ledgerId,
    enabled: row.enabled,
    scope,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    researchRevision: row.researchRevision,
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
  if (!ledger) {
    throw new PaperResolvedResearchFillGateIntegrityError("Paper ledger is unavailable");
  }
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
  gate: Extract<TradingPaperResolvedResearchFillGateStatus, { configured: true }>,
): Promise<void> {
  if (!gate.enabled || !gate.scope) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Enabled resolved research fill gate expected",
    );
  }
  const effect = await tx.externalEffect.findUnique({
    where: { id: gate.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_resolved_research_fill_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill gate lacks completed explicit approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  let resultScope: TradingResolvedResearchApprovalScope | null = null;
  try {
    resultScope = result?.scope ? canonicalScope(result.scope) : null;
  } catch {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill approval result scope invalid",
    );
  }
  if (
    request.action !== "enable" ||
    request.ledgerId !== gate.ledgerId ||
    request.expectedGateRevision !== gate.gateRevision ||
    request.expectedResearchRevision !== gate.researchRevision ||
    !sameScope(request.scope, gate.scope) ||
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== "enable" ||
    result.ledgerId !== gate.ledgerId ||
    result.enabled !== true ||
    !resultScope ||
    !sameScope(resultScope, gate.scope) ||
    result.policyRevision !== gate.policyRevision ||
    result.gateRevision !== gate.gateRevision ||
    result.researchRevision !== gate.researchRevision ||
    result.fillRevision !== gate.fillRevision
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill approval disagrees with persisted gate",
    );
  }
}

function sameFillAuthority(
  left: TradingPaperResolvedResearchFillAuthority,
  right: TradingPaperResolvedResearchFillAuthority,
): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    sameScope(left.scope, right.scope) &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.researchRevision === right.researchRevision &&
    left.fillRevision === right.fillRevision &&
    left.fillApprovalEffectId === right.fillApprovalEffectId &&
    left.researchApprovalEffectId === right.researchApprovalEffectId &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId
  );
}

export async function readVerifiedTradingPaperResolvedResearchFillGate(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperResolvedResearchFillGateStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperResolvedResearchFillGate.findUnique({
          where: { ledgerId },
        });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperResolvedResearchFillGateIntegrityError(
            "Resolved research fill gate owner mismatch",
          );
        }
        return normalize(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function assessTradingPaperResolvedResearchFillPreflightInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  now: Date,
): Promise<TradingPaperResolvedResearchFillPreflight> {
  await requireOwnedLedger(tx, owner, ledgerId);
  const row = await tx.tradingPaperResolvedResearchFillGate.findUnique({ where: { ledgerId } });
  if (!row) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_fill_gate_disabled",
    };
  }
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill gate owner mismatch",
    );
  }
  const gate = normalize(row);
  if (!gate.enabled || !gate.scope) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_fill_gate_disabled",
    };
  }
  await verifyEnabledApproval(tx, owner, gate);

  const research = await assessTradingPaperResolvedResearchScopeAuthorityInTransaction(
    tx,
    owner,
    ledgerId,
    gate.scope,
    gate.researchRevision,
    now,
  );
  if (research.status !== "ready") {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_preflight_denied",
      researchReason: research.reason,
      currentGateRevision: research.currentGateRevision,
      currentResearchRevision: research.currentResearchRevision,
    };
  }
  if (
    research.policyRevision !== gate.policyRevision ||
    research.gateRevision !== gate.gateRevision ||
    research.researchRevision !== gate.researchRevision ||
    !sameScope(research.scope, gate.scope)
  ) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_fill_gate_research_changed",
      currentGateRevision: research.gateRevision,
      currentResearchRevision: research.researchRevision,
    };
  }
  return {
    status: "ready",
    mode: "paper_only",
    ledgerId,
    scope: gate.scope,
    policyRevision: gate.policyRevision,
    gateRevision: gate.gateRevision,
    researchRevision: gate.researchRevision,
    fillRevision: gate.fillRevision,
    fillApprovalEffectId: gate.approvalEffectId,
    researchApprovalEffectId: research.researchApprovalEffectId,
    workerApprovalEffectId: research.workerApprovalEffectId,
    paperApprovalEffectId: research.paperApprovalEffectId,
  };
}

export async function readTradingPaperResolvedResearchFillPreflight(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<TradingPaperResolvedResearchFillPreflight> {
  if (!Number.isFinite(now.getTime())) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Invalid resolved research fill gate clock",
    );
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx) =>
        assessTradingPaperResolvedResearchFillPreflightInTransaction(tx, owner, ledgerId, now),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function verifyTradingPaperResolvedResearchFillAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  expected: TradingPaperResolvedResearchFillAuthority,
  now: Date,
): Promise<TradingPaperResolvedResearchFillAuthority | null> {
  const current = await assessTradingPaperResolvedResearchFillPreflightInTransaction(
    tx,
    owner,
    expected.ledgerId,
    now,
  );
  return current.status === "ready" && sameFillAuthority(expected, current) ? current : null;
}

type ResolvedResearchFillUseInput = {
  reservationId: string;
  signalId: string;
  reserveEvidenceId: string;
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
  researchApprovalEffectId: string;
  scope: TradingResolvedResearchApprovalScope;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  fillRevision: number;
  reserveEvidenceId: string;
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
        value.researchApprovalEffectId,
        value.scope,
        value.policyRevision,
        value.gateRevision,
        value.researchRevision,
        value.fillRevision,
        value.reserveEvidenceId,
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
  researchApprovalEffectId: string;
  scope: Prisma.JsonValue;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  fillRevision: number;
  reserveEvidenceId: string;
  evidenceId: string;
  reserveEventSequence: number;
  fillEventSequence: number;
  actedAt: Date;
  useSha256: string;
}) {
  let scope: TradingResolvedResearchApprovalScope;
  try {
    scope = canonicalScope(row.scope);
  } catch {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Stored resolved research fill provenance scope invalid",
    );
  }
  if (
    !row.reservationId ||
    row.reservationId.length > 128 ||
    !row.signalId ||
    row.signalId.length > 128 ||
    !row.reserveEvidenceId ||
    row.reserveEvidenceId.length > 128 ||
    !row.evidenceId ||
    row.evidenceId.length > 128 ||
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.researchRevision) ||
    row.researchRevision < 1 ||
    !Number.isSafeInteger(row.fillRevision) ||
    row.fillRevision < 1 ||
    !Number.isSafeInteger(row.reserveEventSequence) ||
    row.reserveEventSequence < 1 ||
    !Number.isSafeInteger(row.fillEventSequence) ||
    row.fillEventSequence <= row.reserveEventSequence
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill provenance is invalid",
    );
  }
  const value = {
    ledgerId: row.ledgerId,
    reservationId: row.reservationId,
    spaceId: row.spaceId,
    userId: row.userId,
    signalId: row.signalId,
    fillApprovalEffectId: row.fillApprovalEffectId,
    researchApprovalEffectId: row.researchApprovalEffectId,
    scope,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    researchRevision: row.researchRevision,
    fillRevision: row.fillRevision,
    reserveEvidenceId: row.reserveEvidenceId,
    evidenceId: row.evidenceId,
    reserveEventSequence: row.reserveEventSequence,
    fillEventSequence: row.fillEventSequence,
    actedAt: row.actedAt.toISOString(),
  };
  if (row.useSha256 !== fillUseDigest(value)) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill provenance digest mismatch",
    );
  }
  return value;
}

export async function readTradingPaperResolvedResearchFillUseInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  reservationId: string,
) {
  await requireOwnedLedger(tx, owner, ledgerId);
  const row = await tx.tradingPaperResolvedResearchFillUse.findUnique({
    where: { ledgerId_reservationId: { ledgerId, reservationId } },
  });
  if (!row) return null;
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill provenance owner mismatch",
    );
  }
  return normalizeFillUse(row);
}

export async function recordTradingPaperResolvedResearchFillUseInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  authority: TradingPaperResolvedResearchFillAuthority,
  input: ResolvedResearchFillUseInput,
): Promise<void> {
  await requireOwnedLedger(tx, owner, authority.ledgerId);
  const actedAt = new Date(input.actedAt);
  if (
    !Number.isFinite(actedAt.getTime()) ||
    !input.reservationId ||
    input.reservationId.length > 128 ||
    !input.signalId ||
    input.signalId.length > 128 ||
    !input.reserveEvidenceId ||
    input.reserveEvidenceId.length > 128 ||
    !input.evidenceId ||
    input.evidenceId.length > 128 ||
    !Number.isSafeInteger(input.reserveEventSequence) ||
    input.reserveEventSequence < 1 ||
    !Number.isSafeInteger(input.fillEventSequence) ||
    input.fillEventSequence <= input.reserveEventSequence
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Invalid resolved research fill provenance scope",
    );
  }
  const value = {
    ledgerId: authority.ledgerId,
    reservationId: input.reservationId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    signalId: input.signalId,
    fillApprovalEffectId: authority.fillApprovalEffectId,
    researchApprovalEffectId: authority.researchApprovalEffectId,
    scope: authority.scope,
    policyRevision: authority.policyRevision,
    gateRevision: authority.gateRevision,
    researchRevision: authority.researchRevision,
    fillRevision: authority.fillRevision,
    reserveEvidenceId: input.reserveEvidenceId,
    evidenceId: input.evidenceId,
    reserveEventSequence: input.reserveEventSequence,
    fillEventSequence: input.fillEventSequence,
    actedAt: actedAt.toISOString(),
  };
  await tx.tradingPaperResolvedResearchFillUse.create({
    data: {
      ...value,
      scope: asInputJson(value.scope),
      actedAt,
      useSha256: fillUseDigest(value),
    },
  });
}

export type HistoricalTradingPaperResolvedResearchFillScope = {
  ledgerId: string;
  reservationId: string;
  signalId: string;
  policyRevision: number;
  reserveEvidenceId: string;
  evidenceId: string;
  reserveEventSequence: number;
  fillEventSequence: number;
  actedAt: string;
  market: TradingInstrument;
};

export async function verifyHistoricalTradingPaperResolvedResearchFillApprovalInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  effectId: string,
  expected: HistoricalTradingPaperResolvedResearchFillScope,
): Promise<boolean> {
  await requireOwnedLedger(tx, owner, expected.ledgerId);
  const row = await tx.tradingPaperResolvedResearchFillUse.findUnique({
    where: {
      ledgerId_reservationId: {
        ledgerId: expected.ledgerId,
        reservationId: expected.reservationId,
      },
    },
  });
  if (!row) return false;
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Resolved research fill provenance owner mismatch",
    );
  }
  const use = normalizeFillUse(row);
  if (use.fillApprovalEffectId !== effectId) return false;

  const effect = await tx.externalEffect.findUnique({
    where: { id: effectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_resolved_research_fill_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Historical resolved research fill lacks explicit G3 approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  let resultScope: TradingResolvedResearchApprovalScope | null = null;
  try {
    resultScope = result?.scope ? canonicalScope(result.scope) : null;
  } catch {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Historical resolved research fill approval result scope invalid",
    );
  }
  const reserveApproved = await verifyTradingPaperResolvedResearchReserveUseScopeInTransaction(
    tx,
    owner,
    {
      ledgerId: use.ledgerId,
      scope: use.scope,
      policyRevision: use.policyRevision,
      gateRevision: use.gateRevision,
      researchRevision: use.researchRevision,
      researchApprovalEffectId: use.researchApprovalEffectId,
    },
    {
      reservationId: use.reservationId,
      signalId: use.signalId,
      evidenceId: use.reserveEvidenceId,
      reserveEventSequence: use.reserveEventSequence,
    },
  );
  if (!reserveApproved) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Historical resolved research fill lacks matching G2 reserve provenance",
    );
  }
  const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
    tx,
    owner,
    use.ledgerId,
    use.evidenceId,
  );
  if (!evidence || JSON.stringify(evidence.market) !== JSON.stringify(expected.market)) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Historical resolved research fill evidence disagrees with reservation market",
    );
  }
  if (
    request.action !== "enable" ||
    request.ledgerId !== use.ledgerId ||
    request.expectedGateRevision !== use.gateRevision ||
    request.expectedResearchRevision !== use.researchRevision ||
    !sameScope(request.scope, use.scope) ||
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== "enable" ||
    result.ledgerId !== use.ledgerId ||
    result.enabled !== true ||
    !resultScope ||
    !sameScope(resultScope, use.scope) ||
    result.policyRevision !== use.policyRevision ||
    result.gateRevision !== use.gateRevision ||
    result.researchRevision !== use.researchRevision ||
    result.fillRevision !== use.fillRevision
  ) {
    throw new PaperResolvedResearchFillGateIntegrityError(
      "Historical resolved research fill approval disagrees with persisted provenance",
    );
  }
  return (
    expected.ledgerId === use.ledgerId &&
    expected.reservationId === use.reservationId &&
    expected.signalId === use.signalId &&
    expected.policyRevision === use.policyRevision &&
    expected.reserveEvidenceId === use.reserveEvidenceId &&
    expected.evidenceId === use.evidenceId &&
    expected.reserveEventSequence === use.reserveEventSequence &&
    expected.fillEventSequence === use.fillEventSequence &&
    expected.actedAt === use.actedAt
  );
}

export async function applyApprovedTradingPaperResolvedResearchFillControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperResolvedResearchFillControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperResolvedResearchFillControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_resolved_research_fill_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperResolvedResearchFillGateIntegrityError(
            "Resolved research fill control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await requireOwnedLedger(tx, owner, request.ledgerId);
        const previous = await tx.tradingPaperResolvedResearchFillGate.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (previous) {
          if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
            throw new PaperResolvedResearchFillGateIntegrityError(
              "Resolved research fill gate owner mismatch",
            );
          }
          normalize(previous);
        }

        const complete = async (result: PaperResolvedResearchFillControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperResolvedResearchFillGateIntegrityError(
              "Resolved research fill effect completion CAS failed",
            );
          }
          return result;
        };

        let policyRevision = previous?.policyRevision ?? 0;
        let gateRevision = previous?.gateRevision ?? request.expectedGateRevision;
        let researchRevision = previous?.researchRevision ?? request.expectedResearchRevision;
        let scope: TradingResolvedResearchApprovalScope | null =
          previous?.scope === null || previous?.scope === undefined
            ? null
            : canonicalScope(previous.scope);

        if (request.action === "enable") {
          const research = await assessTradingPaperResolvedResearchScopeAuthorityInTransaction(
            tx,
            owner,
            request.ledgerId,
            request.scope,
            request.expectedResearchRevision,
            new Date(),
          );
          if (research.status !== "ready") {
            if (
              research.reason === "resolved_research_revision_changed" &&
              research.currentResearchRevision !== undefined
            ) {
              return complete({
                ok: false,
                mode: "paper_only",
                action: "enable",
                ledgerId: request.ledgerId,
                error: "stale_research_revision",
                expectedGateRevision: request.expectedGateRevision,
                expectedResearchRevision: request.expectedResearchRevision,
                currentResearchRevision: research.currentResearchRevision,
                currentGateRevision: research.currentGateRevision,
              });
            }
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "resolved_research_preflight_denied",
              expectedGateRevision: request.expectedGateRevision,
              expectedResearchRevision: request.expectedResearchRevision,
              currentGateRevision: research.currentGateRevision,
              currentResearchRevision: research.currentResearchRevision,
              reason: research.reason,
            });
          }
          if (research.gateRevision !== request.expectedGateRevision) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: "enable",
              ledgerId: request.ledgerId,
              error: "stale_gate_revision",
              expectedGateRevision: request.expectedGateRevision,
              expectedResearchRevision: request.expectedResearchRevision,
              currentGateRevision: research.gateRevision,
              currentResearchRevision: research.researchRevision,
            });
          }
          policyRevision = research.policyRevision;
          gateRevision = research.gateRevision;
          researchRevision = research.researchRevision;
          scope = research.scope;
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
          scope: request.action === "enable" ? scope : null,
          policyRevision,
          gateRevision,
          researchRevision,
          fillRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperResolvedResearchFillGate.upsert({
          where: { ledgerId: request.ledgerId },
          create: {
            ...next,
            scope: next.scope ? asInputJson(next.scope) : Prisma.JsonNull,
            gateSha256: digest(next),
          },
          update: {
            ...next,
            scope: next.scope ? asInputJson(next.scope) : Prisma.JsonNull,
            gateSha256: digest(next),
          },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          enabled: next.enabled,
          scope: next.scope,
          policyRevision: next.policyRevision,
          gateRevision: next.gateRevision,
          researchRevision: next.researchRevision,
          fillRevision: next.fillRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
