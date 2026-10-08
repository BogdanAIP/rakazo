import { createHash } from "node:crypto";
import {
  type TradingResolvedResearchApprovalScope,
  TradingResolvedResearchApprovalScopeSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  assessTradingPaperResolvedResearchScopeAuthorityInTransaction,
  type TradingPaperResolvedResearchScopeAuthority,
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

type ReadyResearchScopeAuthority = Extract<
  TradingPaperResolvedResearchScopeAuthority,
  { status: "ready" }
>;

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
      ? [
          "action",
          "expected_gate_revision",
          "expected_research_revision",
          "ledger_id",
          "scope",
        ]
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
        let researchRevision =
          previous?.researchRevision ?? request.expectedResearchRevision;
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
