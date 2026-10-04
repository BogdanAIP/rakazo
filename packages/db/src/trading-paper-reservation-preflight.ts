import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  evaluateTradingPaperReservationInTransaction,
  type TradingPaperReservationDenyReason,
} from "./trading-paper-reservation-evaluation.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;

/** Transaction-bound diagnostic gate. It never returns ALLOW, a reservation,
 * order, event id or capability. B7 uses the shared internal evaluator directly
 * and adds explicit-capability audit, exact sizing, idempotency and atomic CAS. */
export async function preflightTradingPaperReservation(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  proposedSignal: unknown,
  evidenceId: string | null = null,
): Promise<{
  status: "deny";
  reason: TradingPaperReservationDenyReason | "reserve_authority_unavailable";
  ledgerRevision: number;
  policyRevision: number;
}> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const evaluated = await evaluateTradingPaperReservationInTransaction(
          tx,
          owner,
          ledgerId,
          proposedSignal,
          evidenceId,
        );
        if (evaluated.status === "deny") return evaluated;
        return {
          status: "deny" as const,
          reason: "reserve_authority_unavailable" as const,
          ledgerRevision: evaluated.ledgerRevision,
          policyRevision: evaluated.policyRevision,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
