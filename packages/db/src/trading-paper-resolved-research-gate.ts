import { createHash } from "node:crypto";
import {
  type TradingResolvedResearchApprovalScope,
  TradingResolvedResearchApprovalScopeSchema,
  type TradingResolvedResearchEnvelope,
} from "@rakazo/contracts";
import { assessResolvedTradingResearch } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { assessTradingPaperWorkerWakePreflightInTransaction } from "./trading-paper-worker-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

type ResolvedResearchGateRequest =
  | {
      action: "enable";
      ledgerId: string;
      expectedGateRevision: number;
      scope: TradingResolvedResearchApprovalScope;
    }
  | {
      action: "disable";
      ledgerId: string;
      expectedGateRevision: number;
    };

export class PaperResolvedResearchGateIntegrityError extends Error {
  constructor(message = "Resolved research PAPER gate integrity mismatch") {
    super(message);
    this.name = "PaperResolvedResearchGateIntegrityError";
  }
}

export type TradingPaperResolvedResearchGateStatus =
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
      approvalEffectId: string;
      updatedAt: string;
    };

export type PaperResolvedResearchControlResult =
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

export type TradingPaperResolvedResearchPreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      scope: TradingResolvedResearchApprovalScope;
      signalId: string;
      policyRevision: number;
      gateRevision: number;
      researchRevision: number;
      researchApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason:
        | "resolved_research_gate_disabled"
        | "worker_preflight_denied"
        | "resolved_research_gate_worker_changed"
        | "resolved_research_scope_mismatch"
        | "research_expired"
        | "research_no_trade";
      workerReason?: string;
      currentGateRevision?: number;
    };

export type TradingPaperResolvedResearchAuthority = Extract<
  TradingPaperResolvedResearchPreflight,
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

function sameAuthority(
  left: TradingPaperResolvedResearchAuthority,
  right: TradingPaperResolvedResearchAuthority,
): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.signalId === right.signalId &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.researchRevision === right.researchRevision &&
    left.researchApprovalEffectId === right.researchApprovalEffectId &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId &&
    sameScope(left.scope, right.scope)
  );
}

function parseRequest(value: unknown): ResolvedResearchGateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperResolvedResearchGateIntegrityError("Invalid resolved research gate payload");
  }
  const row = value as Record<string, unknown>;
  const action = row.action;
  const expectedKeys =
    action === "enable"
      ? ["action", "expected_gate_revision", "ledger_id", "scope"]
      : ["action", "expected_gate_revision", "ledger_id"];
  if (
    (action !== "enable" && action !== "disable") ||
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new PaperResolvedResearchGateIntegrityError("Unexpected resolved research gate fields");
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
    throw new PaperResolvedResearchGateIntegrityError("Invalid resolved research gate payload");
  }
  if (action === "disable") {
    return { action, ledgerId, expectedGateRevision: revision as number };
  }
  let scope: TradingResolvedResearchApprovalScope;
  try {
    scope = canonicalScope(row.scope);
  } catch {
    throw new PaperResolvedResearchGateIntegrityError("Invalid resolved research approval scope");
  }
  return {
    action,
    ledgerId,
    expectedGateRevision: revision as number,
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
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  approvalEffectId: string;
  scope: Prisma.JsonValue | null;
  gateSha256: string;
  updatedAt: Date;
}): Extract<TradingPaperResolvedResearchGateStatus, { configured: true }> {
  let scope: TradingResolvedResearchApprovalScope | null = null;
  if (row.scope !== null) {
    try {
      scope = canonicalScope(row.scope);
    } catch {
      throw new PaperResolvedResearchGateIntegrityError("Stored resolved research scope invalid");
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
    approvalEffectId: row.approvalEffectId,
  };
  if (
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.researchRevision) ||
    row.researchRevision < 1 ||
    (row.enabled ? scope === null : scope !== null) ||
    row.gateSha256 !== digest(value)
  ) {
    throw new PaperResolvedResearchGateIntegrityError();
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
  if (!ledger) throw new PaperResolvedResearchGateIntegrityError("Paper ledger is unavailable");
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
  gate: Extract<TradingPaperResolvedResearchGateStatus, { configured: true }>,
): Promise<void> {
  if (!gate.enabled || !gate.scope) {
    throw new PaperResolvedResearchGateIntegrityError("Enabled resolved research gate expected");
  }
  const effect = await tx.externalEffect.findUnique({
    where: { id: gate.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_resolved_research_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research gate lacks completed explicit approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  let resultScope: TradingResolvedResearchApprovalScope | null = null;
  try {
    resultScope = result?.scope ? canonicalScope(result.scope) : null;
  } catch {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research approval result scope invalid",
    );
  }
  if (
    request.action !== "enable" ||
    request.ledgerId !== gate.ledgerId ||
    request.expectedGateRevision !== gate.gateRevision ||
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
    result.researchRevision !== gate.researchRevision
  ) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research approval disagrees with persisted gate",
    );
  }
}

export async function readVerifiedTradingPaperResolvedResearchGate(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperResolvedResearchGateStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperResolvedResearchGate.findUnique({ where: { ledgerId } });
        if (!row) {
          return { configured: false, mode: "paper_only", ledgerId, enabled: false } as const;
        }
        if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
          throw new PaperResolvedResearchGateIntegrityError(
            "Resolved research gate owner mismatch",
          );
        }
        return normalize(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export type TradingPaperResolvedResearchScopeAuthority =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      scope: TradingResolvedResearchApprovalScope;
      policyRevision: number;
      gateRevision: number;
      researchRevision: number;
      researchApprovalEffectId: string;
      workerApprovalEffectId: string;
      paperApprovalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason:
        | "resolved_research_gate_disabled"
        | "worker_preflight_denied"
        | "resolved_research_gate_worker_changed"
        | "resolved_research_scope_mismatch"
        | "resolved_research_revision_changed";
      workerReason?: string;
      currentGateRevision?: number;
      currentResearchRevision?: number;
    };

export async function assessTradingPaperResolvedResearchScopeAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  expectedScope: TradingResolvedResearchApprovalScope,
  expectedResearchRevision: number,
  now: Date,
): Promise<TradingPaperResolvedResearchScopeAuthority> {
  await requireOwnedLedger(tx, owner, ledgerId);
  if (!Number.isSafeInteger(expectedResearchRevision) || expectedResearchRevision < 1) {
    throw new PaperResolvedResearchGateIntegrityError("Invalid resolved research revision");
  }
  const row = await tx.tradingPaperResolvedResearchGate.findUnique({ where: { ledgerId } });
  if (!row) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_gate_disabled",
    };
  }
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchGateIntegrityError("Resolved research gate owner mismatch");
  }
  const gate = normalize(row);
  if (!gate.enabled || !gate.scope) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_gate_disabled",
    };
  }
  await verifyEnabledApproval(tx, owner, gate);

  const worker = await assessTradingPaperWorkerWakePreflightInTransaction(tx, owner, ledgerId, now);
  if (worker.status !== "ready") {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "worker_preflight_denied",
      workerReason: worker.reason,
    };
  }
  if (worker.gateRevision !== gate.gateRevision || worker.policyRevision !== gate.policyRevision) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_gate_worker_changed",
      currentGateRevision: worker.gateRevision,
    };
  }
  if (!sameScope(gate.scope, expectedScope)) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_scope_mismatch",
    };
  }
  if (gate.researchRevision !== expectedResearchRevision) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_revision_changed",
      currentResearchRevision: gate.researchRevision,
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
    researchApprovalEffectId: gate.approvalEffectId,
    workerApprovalEffectId: worker.workerApprovalEffectId,
    paperApprovalEffectId: worker.paperApprovalEffectId,
  };
}

export async function assessTradingPaperResolvedResearchPreflightInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  envelope: TradingResolvedResearchEnvelope,
  now: Date,
): Promise<TradingPaperResolvedResearchPreflight> {
  await requireOwnedLedger(tx, owner, ledgerId);
  const research = assessResolvedTradingResearch(envelope, now);
  if (research.status === "no_trade") {
    return { status: "deny", mode: "paper_only", ledgerId, reason: "research_no_trade" };
  }
  if (research.status === "expired") {
    return { status: "deny", mode: "paper_only", ledgerId, reason: "research_expired" };
  }

  const row = await tx.tradingPaperResolvedResearchGate.findUnique({ where: { ledgerId } });
  if (!row) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_gate_disabled",
    };
  }
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchGateIntegrityError("Resolved research gate owner mismatch");
  }
  const gate = normalize(row);
  if (!gate.enabled || !gate.scope) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_gate_disabled",
    };
  }
  await verifyEnabledApproval(tx, owner, gate);

  const worker = await assessTradingPaperWorkerWakePreflightInTransaction(tx, owner, ledgerId, now);
  if (worker.status !== "ready") {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "worker_preflight_denied",
      workerReason: worker.reason,
    };
  }
  if (worker.gateRevision !== gate.gateRevision || worker.policyRevision !== gate.policyRevision) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_gate_worker_changed",
      currentGateRevision: worker.gateRevision,
    };
  }
  if (!sameScope(gate.scope, research.scope)) {
    return {
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "resolved_research_scope_mismatch",
    };
  }
  return {
    status: "ready",
    mode: "paper_only",
    ledgerId,
    scope: gate.scope,
    signalId: research.signal.signalId,
    policyRevision: gate.policyRevision,
    gateRevision: gate.gateRevision,
    researchRevision: gate.researchRevision,
    researchApprovalEffectId: gate.approvalEffectId,
    workerApprovalEffectId: worker.workerApprovalEffectId,
    paperApprovalEffectId: worker.paperApprovalEffectId,
  };
}

export async function readTradingPaperResolvedResearchPreflight(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  envelope: TradingResolvedResearchEnvelope,
  now: Date = new Date(),
): Promise<TradingPaperResolvedResearchPreflight> {
  if (!Number.isFinite(now.getTime())) {
    throw new PaperResolvedResearchGateIntegrityError("Invalid resolved research gate clock");
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx) =>
        assessTradingPaperResolvedResearchPreflightInTransaction(
          tx,
          owner,
          ledgerId,
          envelope,
          now,
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function verifyTradingPaperResolvedResearchAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  expected: TradingPaperResolvedResearchAuthority,
  envelope: TradingResolvedResearchEnvelope,
  now: Date,
): Promise<TradingPaperResolvedResearchAuthority | null> {
  const current = await assessTradingPaperResolvedResearchPreflightInTransaction(
    tx,
    owner,
    expected.ledgerId,
    envelope,
    now,
  );
  return current.status === "ready" && sameAuthority(expected, current) ? current : null;
}

type ResolvedResearchReserveUseInput = {
  reservationId: string;
  signalId: string;
  evidenceId: string;
  reserveEventSequence: number;
  actedAt: string;
};

function reserveUseDigest(value: {
  ledgerId: string;
  reservationId: string;
  spaceId: string;
  userId: string;
  signalId: string;
  researchApprovalEffectId: string;
  scope: TradingResolvedResearchApprovalScope;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  evidenceId: string;
  reserveEventSequence: number;
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
        value.researchApprovalEffectId,
        value.scope,
        value.policyRevision,
        value.gateRevision,
        value.researchRevision,
        value.evidenceId,
        value.reserveEventSequence,
        value.actedAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

function normalizeReserveUse(row: {
  ledgerId: string;
  reservationId: string;
  spaceId: string;
  userId: string;
  signalId: string;
  researchApprovalEffectId: string;
  scope: Prisma.JsonValue;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  evidenceId: string;
  reserveEventSequence: number;
  actedAt: Date;
  useSha256: string;
}) {
  let scope: TradingResolvedResearchApprovalScope;
  try {
    scope = canonicalScope(row.scope);
  } catch {
    throw new PaperResolvedResearchGateIntegrityError(
      "Stored resolved research reserve scope invalid",
    );
  }
  if (
    !row.reservationId ||
    row.reservationId.length > 128 ||
    !row.signalId ||
    row.signalId.length > 128 ||
    !row.evidenceId ||
    row.evidenceId.length > 128 ||
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    !Number.isSafeInteger(row.gateRevision) ||
    row.gateRevision < 0 ||
    !Number.isSafeInteger(row.researchRevision) ||
    row.researchRevision < 1 ||
    !Number.isSafeInteger(row.reserveEventSequence) ||
    row.reserveEventSequence < 1
  ) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research reserve provenance is invalid",
    );
  }
  const value = {
    ledgerId: row.ledgerId,
    reservationId: row.reservationId,
    spaceId: row.spaceId,
    userId: row.userId,
    signalId: row.signalId,
    researchApprovalEffectId: row.researchApprovalEffectId,
    scope,
    policyRevision: row.policyRevision,
    gateRevision: row.gateRevision,
    researchRevision: row.researchRevision,
    evidenceId: row.evidenceId,
    reserveEventSequence: row.reserveEventSequence,
    actedAt: row.actedAt.toISOString(),
  };
  if (row.useSha256 !== reserveUseDigest(value)) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research reserve provenance digest mismatch",
    );
  }
  return value;
}

export async function recordTradingPaperResolvedResearchReserveUseInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  authority: TradingPaperResolvedResearchAuthority,
  input: ResolvedResearchReserveUseInput,
): Promise<void> {
  await requireOwnedLedger(tx, owner, authority.ledgerId);
  const actedAt = new Date(input.actedAt);
  if (
    !Number.isFinite(actedAt.getTime()) ||
    input.signalId !== authority.signalId ||
    !input.reservationId ||
    input.reservationId.length > 128 ||
    !input.evidenceId ||
    input.evidenceId.length > 128 ||
    !Number.isSafeInteger(input.reserveEventSequence) ||
    input.reserveEventSequence < 1
  ) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Invalid resolved research reserve provenance scope",
    );
  }
  const value = {
    ledgerId: authority.ledgerId,
    reservationId: input.reservationId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    signalId: input.signalId,
    researchApprovalEffectId: authority.researchApprovalEffectId,
    scope: authority.scope,
    policyRevision: authority.policyRevision,
    gateRevision: authority.gateRevision,
    researchRevision: authority.researchRevision,
    evidenceId: input.evidenceId,
    reserveEventSequence: input.reserveEventSequence,
    actedAt: actedAt.toISOString(),
  };
  await tx.tradingPaperResolvedResearchReserveUse.create({
    data: {
      ...value,
      scope: asInputJson(value.scope),
      actedAt,
      useSha256: reserveUseDigest(value),
    },
  });
}

export type TradingPaperResolvedResearchScopeIdentity = {
  ledgerId: string;
  scope: TradingResolvedResearchApprovalScope;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  researchApprovalEffectId: string;
};

export async function verifyTradingPaperResolvedResearchReserveUseScopeInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  authority: TradingPaperResolvedResearchScopeIdentity,
  expected: {
    reservationId: string;
    signalId: string;
    evidenceId: string;
    reserveEventSequence: number;
  },
): Promise<boolean> {
  await requireOwnedLedger(tx, owner, authority.ledgerId);
  const row = await tx.tradingPaperResolvedResearchReserveUse.findUnique({
    where: {
      ledgerId_reservationId: {
        ledgerId: authority.ledgerId,
        reservationId: expected.reservationId,
      },
    },
  });
  if (!row) return false;
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research reserve provenance owner mismatch",
    );
  }
  const use = normalizeReserveUse(row);
  return (
    use.researchApprovalEffectId === authority.researchApprovalEffectId &&
    sameScope(use.scope, authority.scope) &&
    use.policyRevision === authority.policyRevision &&
    use.gateRevision === authority.gateRevision &&
    use.researchRevision === authority.researchRevision &&
    use.signalId === expected.signalId &&
    use.evidenceId === expected.evidenceId &&
    use.reserveEventSequence === expected.reserveEventSequence
  );
}

export async function verifyTradingPaperResolvedResearchReserveUseInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  authority: TradingPaperResolvedResearchAuthority,
  expected: {
    reservationId: string;
    signalId: string;
    evidenceId: string;
    reserveEventSequence: number;
  },
): Promise<boolean> {
  await requireOwnedLedger(tx, owner, authority.ledgerId);
  const row = await tx.tradingPaperResolvedResearchReserveUse.findUnique({
    where: {
      ledgerId_reservationId: {
        ledgerId: authority.ledgerId,
        reservationId: expected.reservationId,
      },
    },
  });
  if (!row) return false;
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research reserve provenance owner mismatch",
    );
  }
  const use = normalizeReserveUse(row);
  return (
    use.researchApprovalEffectId === authority.researchApprovalEffectId &&
    sameScope(use.scope, authority.scope) &&
    use.policyRevision === authority.policyRevision &&
    use.gateRevision === authority.gateRevision &&
    use.researchRevision === authority.researchRevision &&
    use.signalId === expected.signalId &&
    use.evidenceId === expected.evidenceId &&
    use.reserveEventSequence === expected.reserveEventSequence
  );
}

export type HistoricalTradingPaperResolvedResearchReserveScope = {
  ledgerId: string;
  reservationId: string;
  signalId: string;
  policyRevision: number;
  evidenceId: string;
  reserveEventSequence: number;
  actedAt: string;
};

export async function verifyHistoricalTradingPaperResolvedResearchReserveApprovalInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  effectId: string,
  expected: HistoricalTradingPaperResolvedResearchReserveScope,
): Promise<boolean> {
  await requireOwnedLedger(tx, owner, expected.ledgerId);
  const row = await tx.tradingPaperResolvedResearchReserveUse.findUnique({
    where: {
      ledgerId_reservationId: {
        ledgerId: expected.ledgerId,
        reservationId: expected.reservationId,
      },
    },
  });
  if (!row) return false;
  if (row.spaceId !== owner.spaceId || row.userId !== owner.userId) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Resolved research reserve provenance owner mismatch",
    );
  }
  const use = normalizeReserveUse(row);
  if (use.researchApprovalEffectId !== effectId) return false;

  const effect = await tx.externalEffect.findUnique({
    where: { id: effectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_resolved_research_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Historical resolved research reserve lacks explicit G1 approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  const result = objectResult(effect.result);
  let resultScope: TradingResolvedResearchApprovalScope | null = null;
  try {
    resultScope = result?.scope ? canonicalScope(result.scope) : null;
  } catch {
    throw new PaperResolvedResearchGateIntegrityError(
      "Historical resolved research approval result scope invalid",
    );
  }
  if (
    request.action !== "enable" ||
    request.ledgerId !== use.ledgerId ||
    request.expectedGateRevision !== use.gateRevision ||
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
    result.researchRevision !== use.researchRevision
  ) {
    throw new PaperResolvedResearchGateIntegrityError(
      "Historical resolved research approval disagrees with reserve provenance",
    );
  }
  return (
    expected.ledgerId === use.ledgerId &&
    expected.reservationId === use.reservationId &&
    expected.signalId === use.signalId &&
    expected.policyRevision === use.policyRevision &&
    expected.evidenceId === use.evidenceId &&
    expected.reserveEventSequence === use.reserveEventSequence &&
    expected.actedAt === use.actedAt
  );
}

export async function applyApprovedTradingPaperResolvedResearchControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperResolvedResearchControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperResolvedResearchControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_resolved_research_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperResolvedResearchGateIntegrityError(
            "Resolved research control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await requireOwnedLedger(tx, owner, request.ledgerId);
        const previous = await tx.tradingPaperResolvedResearchGate.findUnique({
          where: { ledgerId: request.ledgerId },
        });
        if (previous) {
          if (previous.spaceId !== owner.spaceId || previous.userId !== owner.userId) {
            throw new PaperResolvedResearchGateIntegrityError(
              "Resolved research gate owner mismatch",
            );
          }
          normalize(previous);
        }

        const complete = async (result: PaperResolvedResearchControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperResolvedResearchGateIntegrityError(
              "Resolved research effect completion CAS failed",
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
          previous &&
          Number.isSafeInteger(previous.researchRevision) &&
          previous.researchRevision >= 1
            ? previous.researchRevision
            : 0;
        const scope = request.action === "enable" ? request.scope : null;
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          enabled: request.action === "enable",
          scope,
          policyRevision,
          gateRevision,
          researchRevision: priorRevision + 1,
          approvalEffectId: effectId,
        };
        await tx.tradingPaperResolvedResearchGate.upsert({
          where: { ledgerId: request.ledgerId },
          create: {
            ...next,
            scope: scope ? asInputJson(scope) : Prisma.JsonNull,
            gateSha256: digest(next),
          },
          update: {
            ...next,
            scope: scope ? asInputJson(scope) : Prisma.JsonNull,
            gateSha256: digest(next),
          },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          enabled: next.enabled,
          scope,
          policyRevision: next.policyRevision,
          gateRevision: next.gateRevision,
          researchRevision: next.researchRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
