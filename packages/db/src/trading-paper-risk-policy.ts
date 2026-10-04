import { createHash } from "node:crypto";
import { type TradingPaperPolicy, TradingPaperPolicySchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
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
    }
  | {
      ok: false;
      mode: "paper_only";
      action: "enable" | "disable";
      ledgerId: string;
      error: "stale_policy_revision" | "already_enabled" | "already_disabled";
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
          include: { run: { select: { id: true, spaceId: true, userId: true } } },
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
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          policyRevision: nextRevision,
          enabled: next.enabled,
          killSwitch: next.killSwitch,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
