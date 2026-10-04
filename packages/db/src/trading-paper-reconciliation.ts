import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { releaseTradingPaperReservationsInTransaction } from "./trading-paper-release.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;

/** INTERNAL trusted-clock reconciliation. No timer/scheduler is activated by
 * this function's existence; callers must invoke it from reviewed Rakazo code. */
export async function reconcileTradingPaperReservations(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
): Promise<{ released: number; reason: "expired" | "kill_switch" }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        const verified = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        const reason =
          !verified.policy.enabled || verified.policy.killSwitch ? "kill_switch" : "expired";
        const result = await releaseTradingPaperReservationsInTransaction(
          tx,
          owner,
          ledgerId,
          reason,
          verified.revision,
          Date.now(),
        );
        return { released: result.released, reason };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
