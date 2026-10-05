import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import { verifyTradingPaperStopGuardsInTransaction } from "./trading-paper-stop-guard.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
const AUTHORITY_TTL_MS = 60_000;
const ACTION = "authorize_protective_stop_exit" as const;

export class PaperProtectiveExitAuthorityIntegrityError extends Error {
  constructor(message = "Protective paper exit authority unavailable or invalid") {
    super(message);
    this.name = "PaperProtectiveExitAuthorityIntegrityError";
  }
}

type Request = {
  action: typeof ACTION;
  ledgerId: string;
  positionId: string;
  expectedPolicyRevision: number;
};

export type PaperProtectiveExitControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: typeof ACTION;
      ledgerId: string;
      positionId: string;
      policyRevision: number;
      enabled: false;
      killSwitch: true;
      authorityEffectId: string;
      authorizedAt: string;
      expiresAt: string;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: typeof ACTION;
      ledgerId: string;
      positionId: string;
      error:
        | "stale_policy_revision"
        | "policy_must_remain_disabled"
        | "reconciliation_required"
        | "position_unavailable"
        | "authority_already_active";
      currentPolicyRevision: number;
    };

function parseRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperProtectiveExitAuthorityIntegrityError(
      "Invalid protective exit approval payload",
    );
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(["action", "expected_policy_revision", "ledger_id", "position_id"])
  ) {
    throw new PaperProtectiveExitAuthorityIntegrityError(
      "Unexpected protective exit approval fields",
    );
  }
  const action = row.action;
  const ledgerId = row.ledger_id;
  const positionId = row.position_id;
  const revision = row.expected_policy_revision;
  if (
    action !== ACTION ||
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    typeof positionId !== "string" ||
    positionId.length < 1 ||
    positionId.length > 128 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new PaperProtectiveExitAuthorityIntegrityError(
      "Invalid protective exit approval payload",
    );
  }
  return { action, ledgerId, positionId, expectedPolicyRevision: revision as number };
}

function hash(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function authorityDigest(value: {
  effectId: string;
  ledgerId: string;
  spaceId: string;
  userId: string;
  runId: string;
  positionId: string;
  policyRevision: number;
  buyFillEventSequence: number;
  stopPriceQuote: string;
  authorizedAt: string;
  expiresAt: string;
}): string {
  return hash([
    value.effectId,
    value.ledgerId,
    value.spaceId,
    value.userId,
    value.runId,
    value.positionId,
    value.policyRevision,
    value.buyFillEventSequence,
    value.stopPriceQuote,
    value.authorizedAt,
    value.expiresAt,
  ]);
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function verifyTradingPaperProtectiveExitAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  effectId: string,
) {
  const row = await tx.tradingPaperProtectiveExitAuthority.findUnique({ where: { effectId } });
  if (!row) return null;
  await recoverTradingPaperLedgerInTransaction(tx, owner, row.ledgerId);
  const normalized = {
    effectId: row.effectId,
    ledgerId: row.ledgerId,
    spaceId: row.spaceId,
    userId: row.userId,
    runId: row.runId,
    positionId: row.positionId,
    policyRevision: row.policyRevision,
    buyFillEventSequence: row.buyFillEventSequence,
    stopPriceQuote: row.stopPriceQuote,
    authorizedAt: row.authorizedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
  if (
    row.spaceId !== owner.spaceId ||
    row.userId !== owner.userId ||
    !Number.isSafeInteger(row.policyRevision) ||
    row.policyRevision < 0 ||
    row.expiresAt.getTime() - row.authorizedAt.getTime() !== AUTHORITY_TTL_MS ||
    row.authoritySha256 !== authorityDigest(normalized)
  ) {
    throw new PaperProtectiveExitAuthorityIntegrityError();
  }
  return { ...normalized, authoritySha256: row.authoritySha256 };
}

export async function readVerifiedTradingPaperProtectiveExitAuthority(
  prisma: Db,
  owner: Owner,
  effectId: string,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx) => verifyTradingPaperProtectiveExitAuthorityInTransaction(tx, owner, effectId),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export type PaperProtectiveExitAuthorityUseStatus =
  | {
      status: "usable";
      mode: "paper_only";
      effectId: string;
      ledgerId: string;
      positionId: string;
      policyRevision: number;
      buyFillEventSequence: number;
      stopPriceQuote: string;
      authorizedAt: string;
      expiresAt: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      effectId: string;
      reason:
        | "authority_unavailable"
        | "authority_expired"
        | "policy_revision_changed"
        | "kill_switch_not_latched"
        | "reconciliation_required"
        | "position_unavailable"
        | "authority_scope_changed";
      currentPolicyRevision?: number;
    };

function completedEffectResult(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** INTERNAL READ-ONLY verifier for a future protective close writer.
 * This never consumes authority and never mutates policy, ledger, outbox or guards. */
export async function assessTradingPaperProtectiveExitAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  effectId: string,
  now: Date,
): Promise<PaperProtectiveExitAuthorityUseStatus> {
  if (!Number.isFinite(now.getTime())) {
    throw new PaperProtectiveExitAuthorityIntegrityError("Invalid protective exit authority clock");
  }
  const authority = await verifyTradingPaperProtectiveExitAuthorityInTransaction(
    tx,
    owner,
    effectId,
  );
  if (!authority) {
    return { status: "deny", mode: "paper_only", effectId, reason: "authority_unavailable" };
  }

  const effect = await tx.externalEffect.findUnique({
    where: { id: effectId },
    include: { run: { select: { id: true, spaceId: true, userId: true } } },
  });
  if (
    !effect ||
    effect.status !== "completed" ||
    effect.kind !== "paper_position_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.id !== authority.runId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperProtectiveExitAuthorityIntegrityError(
      "Protective exit authority lacks completed explicit approval provenance",
    );
  }
  const request = parseRequest(effect.request);
  if (
    request.ledgerId !== authority.ledgerId ||
    request.positionId !== authority.positionId ||
    request.expectedPolicyRevision !== authority.policyRevision
  ) {
    throw new PaperProtectiveExitAuthorityIntegrityError(
      "Protective exit approval request disagrees with authority",
    );
  }
  const result = completedEffectResult(effect.result);
  if (
    result?.ok !== true ||
    result.mode !== "paper_only" ||
    result.action !== ACTION ||
    result.ledgerId !== authority.ledgerId ||
    result.positionId !== authority.positionId ||
    result.policyRevision !== authority.policyRevision ||
    result.enabled !== false ||
    result.killSwitch !== true ||
    result.authorityEffectId !== effectId ||
    result.authorizedAt !== authority.authorizedAt ||
    result.expiresAt !== authority.expiresAt
  ) {
    throw new PaperProtectiveExitAuthorityIntegrityError(
      "Protective exit approval result disagrees with authority",
    );
  }

  const nowMs = now.getTime();
  if (
    nowMs < Date.parse(authority.authorizedAt) ||
    nowMs >= Date.parse(authority.expiresAt)
  ) {
    return { status: "deny", mode: "paper_only", effectId, reason: "authority_expired" };
  }

  const policy = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, authority.ledgerId);
  if (policy.revision !== authority.policyRevision) {
    return {
      status: "deny",
      mode: "paper_only",
      effectId,
      reason: "policy_revision_changed",
      currentPolicyRevision: policy.revision,
    };
  }
  if (policy.policy.enabled || !policy.policy.killSwitch) {
    return {
      status: "deny",
      mode: "paper_only",
      effectId,
      reason: "kill_switch_not_latched",
      currentPolicyRevision: policy.revision,
    };
  }

  const lifecycle = await auditTradingPaperLifecycleInTransaction(
    tx,
    owner,
    authority.ledgerId,
    now,
  );
  if (lifecycle.openReservations > 0) {
    return {
      status: "deny",
      mode: "paper_only",
      effectId,
      reason: "reconciliation_required",
      currentPolicyRevision: policy.revision,
    };
  }
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, authority.ledgerId);
  const position = recovered.state.positions.find(
    (entry) => entry.positionId === authority.positionId,
  );
  if (!position) {
    return {
      status: "deny",
      mode: "paper_only",
      effectId,
      reason: "position_unavailable",
      currentPolicyRevision: policy.revision,
    };
  }
  const guards = await verifyTradingPaperStopGuardsInTransaction(
    tx,
    authority.ledgerId,
    recovered.events,
    recovered.state,
  );
  const guard = guards?.find((entry) => entry.positionId === authority.positionId);
  if (
    !guard ||
    guard.openedSequence !== authority.buyFillEventSequence ||
    guard.stopPriceQuote !== authority.stopPriceQuote
  ) {
    return {
      status: "deny",
      mode: "paper_only",
      effectId,
      reason: "authority_scope_changed",
      currentPolicyRevision: policy.revision,
    };
  }
  return {
    status: "usable",
    mode: "paper_only",
    effectId,
    ledgerId: authority.ledgerId,
    positionId: authority.positionId,
    policyRevision: authority.policyRevision,
    buyFillEventSequence: authority.buyFillEventSequence,
    stopPriceQuote: authority.stopPriceQuote,
    authorizedAt: authority.authorizedAt,
    expiresAt: authority.expiresAt,
  };
}

export async function readTradingPaperProtectiveExitAuthorityUseStatus(
  prisma: Db,
  owner: Owner,
  effectId: string,
  now: Date = new Date(),
): Promise<PaperProtectiveExitAuthorityUseStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx) => assessTradingPaperProtectiveExitAuthorityInTransaction(tx, owner, effectId, now),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Applies an already claimed explicit owner approval. Authority creation only:
 * no policy toggle, ledger event, synthetic close, quote read or broker I/O. */
export async function applyApprovedTradingPaperProtectiveExitControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperProtectiveExitControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperProtectiveExitControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { id: true, spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_position_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperProtectiveExitAuthorityIntegrityError(
            "Protective exit control lacks explicit approved effect",
          );
        }
        const request = parseRequest(effect.request);
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, request.ledgerId);
        const verified = await verifyTradingPaperRiskPolicyInTransaction(
          tx,
          owner,
          request.ledgerId,
        );
        const complete = async (result: PaperProtectiveExitControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperProtectiveExitAuthorityIntegrityError(
              "Protective exit effect completion CAS failed",
            );
          }
          return result;
        };
        const fail = (error: Extract<PaperProtectiveExitControlResult, { ok: false }>["error"]) =>
          complete({
            ok: false,
            mode: "paper_only",
            action: ACTION,
            ledgerId: request.ledgerId,
            positionId: request.positionId,
            error,
            currentPolicyRevision: verified.revision,
          });

        if (verified.revision !== request.expectedPolicyRevision) {
          return fail("stale_policy_revision");
        }
        if (verified.policy.enabled || !verified.policy.killSwitch) {
          return fail("policy_must_remain_disabled");
        }
        const now = new Date();
        const lifecycle = await auditTradingPaperLifecycleInTransaction(
          tx,
          owner,
          request.ledgerId,
          now,
        );
        if (lifecycle.openReservations > 0) {
          return fail("reconciliation_required");
        }
        const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, request.ledgerId);
        const position = recovered.state.positions.find(
          (entry) => entry.positionId === request.positionId,
        );
        if (!position) return fail("position_unavailable");
        const guards = await verifyTradingPaperStopGuardsInTransaction(
          tx,
          request.ledgerId,
          recovered.events,
          recovered.state,
        );
        const guard = guards?.find((entry) => entry.positionId === request.positionId);
        if (!guard) {
          throw new PaperProtectiveExitAuthorityIntegrityError(
            "Open position lacks verified protective stop",
          );
        }
        const fill = recovered.events.find(
          (entry) => entry.kind === "fill_buy" && entry.reservationId === request.positionId,
        );
        if (fill?.kind !== "fill_buy" || fill.sequence !== guard.openedSequence) {
          throw new PaperProtectiveExitAuthorityIntegrityError(
            "Open position lacks verified buy fill",
          );
        }
        const active = await tx.tradingPaperProtectiveExitAuthority.findFirst({
          where: {
            ledgerId: request.ledgerId,
            positionId: request.positionId,
            policyRevision: verified.revision,
            expiresAt: { gt: now },
          },
          orderBy: { expiresAt: "desc" },
        });
        if (active) {
          await verifyTradingPaperProtectiveExitAuthorityInTransaction(tx, owner, active.effectId);
          return fail("authority_already_active");
        }

        const authorizedAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + AUTHORITY_TTL_MS).toISOString();
        const authority = {
          effectId,
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          runId: effect.run.id,
          positionId: request.positionId,
          policyRevision: verified.revision,
          buyFillEventSequence: fill.sequence,
          stopPriceQuote: guard.stopPriceQuote,
          authorizedAt,
          expiresAt,
        };
        await tx.tradingPaperProtectiveExitAuthority.create({
          data: {
            ...authority,
            authorizedAt: new Date(authorizedAt),
            expiresAt: new Date(expiresAt),
            authoritySha256: authorityDigest(authority),
          },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: ACTION,
          ledgerId: request.ledgerId,
          positionId: request.positionId,
          policyRevision: verified.revision,
          enabled: false,
          killSwitch: true,
          authorityEffectId: effectId,
          authorizedAt,
          expiresAt,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
