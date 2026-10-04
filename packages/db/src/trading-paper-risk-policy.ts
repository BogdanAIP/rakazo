import { createHash } from "node:crypto";
import { type TradingPaperPolicy, TradingPaperPolicySchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  requireTradingBotPaperBindingInTransaction,
  TradingBotPaperBindingError,
} from "./trading-paper-bot.js";
import {
  auditTradingPaperLifecycleInTransaction,
  PaperLifecycleAuditError,
} from "./trading-paper-lifecycle-audit.js";
import { releaseTradingPaperReservationsInTransaction } from "./trading-paper-release.js";
import { PaperStopGuardIntegrityError } from "./trading-paper-stop-guard.js";
import { PaperLedgerIntegrityError } from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type PolicyDb = Pick<PrismaClient, "$transaction">;
type Owner = { spaceId: string; userId: string };
type InitialPaperPolicy = Omit<TradingPaperPolicy, "mode" | "enabled" | "killSwitch">;

export class PaperRiskPolicyIntegrityError extends Error {
  constructor(message = "Paper risk policy unavailable or unverified") {
    super(message);
    this.name = "PaperRiskPolicyIntegrityError";
  }
}
function parsePolicy(value: unknown): TradingPaperPolicy {
  try {
    return TradingPaperPolicySchema.parse(value);
  } catch {
    throw new PaperRiskPolicyIntegrityError();
  }
}
function digest(value: TradingPaperPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(parsePolicy(value)), "utf8")
    .digest("hex");
}
async function requireOwnedLedger(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<void> {
  const member = await tx.spaceMember.findFirst({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true },
  });
  if (!member) throw new PaperRiskPolicyIntegrityError();
  const ledger = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { id: true },
  });
  if (!ledger) throw new PaperRiskPolicyIntegrityError();
}

/** DB-only trusted service. Ignores any attempted enabled/killSwitch injection,
 * stores a version-zero DISABLED/KILLED paper-only policy. Never expose to AI/RPC.
 * There is intentionally no enable/update method in P11A. */
export async function createDisabledTradingPaperRiskPolicy(
  prisma: PolicyDb,
  owner: Owner,
  ledgerId: string,
  limits: InitialPaperPolicy,
): Promise<TradingPaperPolicy> {
  const policy = parsePolicy({
    ...limits,
    mode: "paper_only",
    enabled: false,
    killSwitch: true,
  });
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwnedLedger(tx, owner, ledgerId);
        await tx.tradingPaperRiskPolicy.create({
          data: {
            ledgerId,
            revision: 0,
            policy: JSON.parse(JSON.stringify(policy)) as Prisma.InputJsonValue,
            policySha256: digest(policy),
          },
        });
        return policy;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Owner-scoped policy read and canonical digest verification. A verified policy
 * alone NEVER authorizes a reserve; P11B must check it with P10 replay in one tx. */
export async function readVerifiedTradingPaperRiskPolicy(
  prisma: PolicyDb,
  owner: Owner,
  ledgerId: string,
): Promise<{ revision: number; policy: TradingPaperPolicy }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        return verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Internal-only: checks owner/membership, validates stored JSON and digest inside
 * the *caller's* serializable transaction, preventing policy/ledger TOCTOU. */
export async function verifyTradingPaperRiskPolicyInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<{ revision: number; policy: TradingPaperPolicy }> {
  await requireOwnedLedger(tx, owner, ledgerId);
  const row = await tx.tradingPaperRiskPolicy.findUnique({ where: { ledgerId } });
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new PaperRiskPolicyIntegrityError();
  }
  const policy = parsePolicy(row.policy);
  if (digest(policy) !== row.policySha256) throw new PaperRiskPolicyIntegrityError();
  return { revision: row.revision, policy };
}

type PaperTradingControlRequest = {
  action: "enable" | "disable";
  ledgerId: string;
  expectedPolicyRevision: number;
};
export type PaperTradingControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      policyRevision: number;
      enabled: boolean;
      killSwitch: boolean;
      reconciliationRequired?: boolean;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      error:
        | "stale_policy_revision"
        | "already_enabled"
        | "already_disabled"
        | "reconciliation_required";
      currentPolicyRevision: number;
    };

function parseControlRequest(value: unknown): PaperTradingControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperRiskPolicyIntegrityError("Invalid paper control approval payload");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["action", "expected_policy_revision", "ledger_id"])
  ) {
    throw new PaperRiskPolicyIntegrityError("Unexpected paper control approval fields");
  }
  const action = row.action;
  const ledgerId = row.ledger_id;
  const revision = row.expected_policy_revision;
  if (
    (action !== "enable" && action !== "disable") ||
    typeof ledgerId !== "string" ||
    ledgerId.length < 1 ||
    ledgerId.length > 128 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  )
    throw new PaperRiskPolicyIntegrityError("Invalid paper control approval payload");
  return { action, ledgerId, expectedPolicyRevision: revision as number };
}
function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Applies only an already-claimed explicit approval effect. The policy CAS,
 * immutable audit and effect completion share one serializable transaction. */
export async function applyApprovedTradingPaperControl(
  prisma: PolicyDb,
  owner: Owner,
  effectId: string,
): Promise<PaperTradingControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { id: true, botId: true, spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_trading_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        )
          throw new PaperRiskPolicyIntegrityError("Paper control lacks explicit approved effect");
        const request = parseControlRequest(effect.request);
        await requireOwnedLedger(tx, owner, request.ledgerId);
        // P12: legacy P11 ledgers remain unbound. A NEW bound ledger may
        // only receive an approval from a Run of its exact native Rakazo Bot.
        // Archive bypass is exclusively for a previously approved disable.
        const binding = await tx.tradingPaperLedger.findUnique({
          where: { id: request.ledgerId },
          select: { botId: true },
        });
        if (binding?.botId) {
          try {
            await requireTradingBotPaperBindingInTransaction(
              tx,
              owner,
              binding.botId,
              request.ledgerId,
              { runId: effect.run.id, allowArchived: request.action === "disable" },
            );
          } catch (error) {
            if (error instanceof TradingBotPaperBindingError) {
              throw new PaperRiskPolicyIntegrityError("Paper control Run is not the bound Bot");
            }
            throw error;
          }
        }
        const verified = await verifyTradingPaperRiskPolicyInTransaction(
          tx,
          owner,
          request.ledgerId,
        );
        const complete = async (result: PaperTradingControlResult) => {
          const settled = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: { status: "completed", result: asInputJson(result) },
          });
          if (settled.count !== 1) {
            throw new PaperRiskPolicyIntegrityError("Paper control effect completion CAS failed");
          }
          return result;
        };
        if (verified.revision !== request.expectedPolicyRevision) {
          return complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            error: "stale_policy_revision",
            currentPolicyRevision: verified.revision,
          });
        }
        const current = verified.policy;
        if (current.enabled === current.killSwitch) {
          throw new PaperRiskPolicyIntegrityError("Paper policy enable/kill state is inconsistent");
        }
        if (request.action === "enable" && current.enabled) {
          return complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            error: "already_enabled",
            currentPolicyRevision: verified.revision,
          });
        }
        if (request.action === "disable" && !current.enabled) {
          return complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            error: "already_disabled",
            currentPolicyRevision: verified.revision,
          });
        }
        // Re-enabling is a separate approved act, never a side effect of repair.
        // Verify the whole B7+ lifecycle, then refuse an unreconciled hold
        // even when a previous kill-switch was successfully latched.
        if (request.action === "enable") {
          const lifecycle = await auditTradingPaperLifecycleInTransaction(
            tx,
            owner,
            request.ledgerId,
            new Date(),
          );
          if (lifecycle.openReservations > 0) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: request.action,
              ledgerId: request.ledgerId,
              error: "reconciliation_required",
              currentPolicyRevision: verified.revision,
            });
          }
        }
        // A damaged lifecycle blocks virtual-money mutations, but must NOT
        // prevent the one-time owner-approved kill-switch from latching.
        // Detect known audit integrity errors before any policy write. A
        // pending hold is left untouched and must be reconciled after repair.
        let releaseAuditAvailable = true;
        if (request.action === "disable") {
          try {
            await auditTradingPaperLifecycleInTransaction(tx, owner, request.ledgerId, new Date());
          } catch (error) {
            if (
              error instanceof PaperLifecycleAuditError ||
              error instanceof PaperLedgerIntegrityError ||
              error instanceof PaperStopGuardIntegrityError
            ) {
              releaseAuditAvailable = false;
            } else {
              throw error;
            }
          }
        }
        const next = parsePolicy({
          ...current,
          enabled: request.action === "enable",
          killSwitch: request.action !== "enable",
        });
        const beforeSha256 = digest(current);
        const afterSha256 = digest(next);
        const changed = await tx.tradingPaperRiskPolicy.updateMany({
          where: {
            ledgerId: request.ledgerId,
            revision: verified.revision,
            policySha256: beforeSha256,
          },
          data: {
            revision: { increment: 1 },
            policy: asInputJson(next),
            policySha256: afterSha256,
          },
        });
        if (changed.count !== 1)
          throw new PaperRiskPolicyIntegrityError("Paper policy revision CAS failed");
        const nextRevision = verified.revision + 1;
        await tx.tradingPaperPolicyAudit.create({
          data: {
            effectId,
            ledgerId: request.ledgerId,
            spaceId: owner.spaceId,
            userId: owner.userId,
            runId: effect.run.id,
            action: request.action,
            fromRevision: verified.revision,
            toRevision: nextRevision,
            beforeSha256,
            afterSha256,
          },
        });
        if (request.action === "disable" && releaseAuditAvailable) {
          await releaseTradingPaperReservationsInTransaction(
            tx,
            owner,
            request.ledgerId,
            "kill_switch",
            nextRevision,
            Date.now(),
          );
        }
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          policyRevision: nextRevision,
          enabled: next.enabled,
          killSwitch: next.killSwitch,
          ...(releaseAuditAvailable ? {} : { reconciliationRequired: true }),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Internal B7 writer barrier. Locks the owner-scoped policy row until the
 * surrounding transaction commits, so a concurrent approved disable cannot
 * interleave between risk evaluation and a synthetic reserve. */
export async function lockTradingPaperRiskPolicyInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<void> {
  await requireOwnedLedger(tx, owner, ledgerId);
  const rows = await tx.$queryRaw<Array<{ ledgerId: string }>>(
    Prisma.sql`SELECT "ledgerId" FROM "trading_paper_risk_policies"
               WHERE "ledgerId" = ${ledgerId}
               FOR UPDATE`,
  );
  if (rows.length !== 1 || rows[0]?.ledgerId !== ledgerId) {
    throw new PaperRiskPolicyIntegrityError("Paper risk policy lock unavailable");
  }
}

/** B7 requires proof that the CURRENT enabled revision came from B6 explicit
 * owner approval, not a direct/admin JSON edit. Database superusers remain
 * outside the application trust boundary; this is not a cryptographic signature. */
export async function verifyCurrentTradingPaperEnableAuditInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  revision: number,
  policy: TradingPaperPolicy,
): Promise<{ effectId: string } | null> {
  const rows = await tx.tradingPaperPolicyAudit.findMany({
    where: { ledgerId, toRevision: revision },
    take: 2,
  });
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new PaperRiskPolicyIntegrityError("Duplicate paper capability revision audit");
  }
  const row = rows[0]!;
  if (
    row.spaceId !== owner.spaceId ||
    row.userId !== owner.userId ||
    row.action !== "enable" ||
    row.afterSha256 !== digest(policy) ||
    !policy.enabled ||
    policy.killSwitch
  ) {
    throw new PaperRiskPolicyIntegrityError("Current paper enable audit does not match policy");
  }
  return { effectId: row.effectId };
}
