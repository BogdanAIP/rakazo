import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyTradingPaperSessionSettlingAuthorityInTransaction } from "./trading-paper-entry-session.js";
import { releaseTradingPaperReservationsInTransaction } from "./trading-paper-release.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export class PaperSessionSettlementIntegrityError extends Error {
  constructor(message = "Normal PAPER session settlement could not be verified") {
    super(message);
    this.name = "PaperSessionSettlementIntegrityError";
  }
}

export type TradingPaperSessionSettlementResult = {
  status: "settled_reservations";
  mode: "paper_only";
  ledgerId: string;
  sessionRevision: number;
  sessionStatus: "paused" | "ended" | "expired";
  releasedReservations: number;
  remainingReservations: number;
  openPositions: number;
};

/**
 * H2a — internal PAPER-only normal-stop reservation settlement.
 *
 * Serializes with both the owner-approved Start/Pause/End (ledger row FOR
 * UPDATE) and B7/C1 synthetic money writers (risk policy row FOR UPDATE).
 * Expired Start, approved Pause or approved End is required. A still-active
 * session or absent session row is never treated as implicit consent.
 *
 * Only *unfilled* virtual reservations are released with immutable
 * ledger+outbox events and the new "session_end" reason. Neither live orders
 * nor an already opened position can be closed by this function.
 *
 * Repeat execution is idempotent because only current reservations are
 * selected, and the existing full lifecycle audit verifies the ledger.
 * Not exposed as an LLM/RPC command. A separate protection-only supervisor
 * is required before declaring positions fully settled.
 */
export async function settleVerifiedTradingPaperSessionReservations(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperSessionSettlementResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<TradingPaperSessionSettlementResult> => {
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "trading_paper_ledgers"
                     WHERE "id" = ${ledgerId} AND "spaceId" = ${owner.spaceId}
                       AND "ownerUserId" = ${owner.userId} FOR UPDATE`,
        );
        if (locked.length !== 1 || locked[0]?.id !== ledgerId) {
          throw new PaperSessionSettlementIntegrityError(
            "Owner-scoped PAPER ledger lock unavailable",
          );
        }
        const authority = await verifyTradingPaperSessionSettlingAuthorityInTransaction(
          tx,
          owner,
          ledgerId,
        );
        const policy = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        const result = await releaseTradingPaperReservationsInTransaction(
          tx,
          owner,
          ledgerId,
          "session_end",
          policy.revision,
          authority.checkedAt.getTime(),
        );
        return {
          status: "settled_reservations",
          mode: "paper_only",
          ledgerId,
          sessionRevision: authority.sessionRevision,
          sessionStatus: authority.status,
          releasedReservations: result.released,
          remainingReservations: result.state.reservations.length,
          openPositions: result.state.positions.length,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
