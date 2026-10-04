import { createHash } from "node:crypto";
import {
  type TradingPaperPolicy,
  TradingPaperPolicySchema,
} from "@rakazo/contracts";
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
  return createHash("sha256").update(JSON.stringify(parsePolicy(value)), "utf8").digest("hex");
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
        await requireOwnedLedger(tx, owner, ledgerId);
        const row = await tx.tradingPaperRiskPolicy.findUnique({ where: { ledgerId } });
        if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
          throw new PaperRiskPolicyIntegrityError();
        }
        const policy = parsePolicy(row.policy);
        if (digest(policy) !== row.policySha256) throw new PaperRiskPolicyIntegrityError();
        return { revision: row.revision, policy };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
