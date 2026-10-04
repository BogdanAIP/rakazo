import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  auditTradingPaperLifecycleInTransaction,
  PaperLifecycleAuditError,
} from "./trading-paper-lifecycle-audit.js";
import { verifyTradingPaperRiskPolicyInTransaction } from "./trading-paper-risk-policy.js";
import { PaperStopGuardIntegrityError } from "./trading-paper-stop-guard.js";
import {
  PaperLedgerIntegrityError,
  recoverTradingPaperLedgerInTransaction,
} from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export type PaperRecoveryStatus =
  | {
      mode: "paper_only";
      status: "integrity_blocked";
      policyRevision: number;
      enabled: boolean;
      killSwitch: boolean;
      nextAction: "inspect_and_restore_independently";
      // No unverified money, position or PnL values are returned.
    }
  | {
      mode: "paper_only";
      status: "verified";
      policyRevision: number;
      enabled: boolean;
      killSwitch: boolean;
      nextAction: "none" | "internal_reconcile_holds" | "separate_owner_approval_to_enable";
      openReservations: number;
      openPositions: number;
      acceptedEvents: number;
      availableQuote: string;
      reservedQuote: string;
      realizedPnlQuote: string;
      realizedLossTodayQuote: string;
      dayStartUtc: string;
    };

/** INTERNAL READ-ONLY owner-scoped recovery snapshot. This is not a repair,
 * reconciliation, capability, order, background worker or model tool.
 * Never return unverified financial values from a damaged managed journal. */
export async function readTradingPaperRecoveryStatus(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<PaperRecoveryStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperRecoveryStatus> => {
        // This owner/membership gate MUST complete before classifying
        // integrity failures, so unauthorized callers never gain an oracle.
        const verified = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        const { revision: policyRevision, policy } = verified;
        try {
          const report = await auditTradingPaperLifecycleInTransaction(
            tx,
            owner,
            ledgerId,
            now,
          );
          const { state } = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
          const nextAction =
            !policy.enabled && report.openReservations > 0
              ? "internal_reconcile_holds"
              : !policy.enabled
                ? "separate_owner_approval_to_enable"
                : "none";
          return {
            mode: "paper_only",
            status: "verified",
            policyRevision,
            enabled: policy.enabled,
            killSwitch: policy.killSwitch,
            nextAction,
            openReservations: report.openReservations,
            openPositions: report.openPositions,
            acceptedEvents: report.acceptedEvents,
            availableQuote: state.availableQuote,
            reservedQuote: state.reservedQuote,
            realizedPnlQuote: report.realizedPnlQuote,
            realizedLossTodayQuote: report.realizedLossTodayQuote,
            dayStartUtc: report.dayStartUtc,
          };
        } catch (error) {
          if (
            error instanceof PaperLifecycleAuditError ||
            error instanceof PaperLedgerIntegrityError ||
            error instanceof PaperStopGuardIntegrityError
          ) {
            return {
              mode: "paper_only",
              status: "integrity_blocked",
              policyRevision,
              enabled: policy.enabled,
              killSwitch: policy.killSwitch,
              nextAction: "inspect_and_restore_independently",
            };
          }
          throw error;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
