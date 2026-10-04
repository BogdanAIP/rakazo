import { type TradingSignal, TradingSignalSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyTradingPaperRiskPolicyInTransaction } from "./trading-paper-risk-policy.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
type Reason =
  | "policy_disabled"
  | "kill_switch_active"
  | "quote_currency_mismatch"
  | "no_trade"
  | "invalid_signal"
  | "unsupported_instrument"
  | "existing_risk_unreconciled"
  | "trusted_market_snapshot_unavailable";

/** Inert, transaction-bound first stage of P11B. Never returns ALLOW, a
 * reservation, an eventId, an order, or an authorization token. The policy is
 * intentionally default-denied in P11A. A later audited, authenticated Worker
 * must separately provide a persisted, source-verified public quote and risk
 * inputs before a reserve path can exist. */
export async function preflightTradingPaperReservation(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  proposedSignal: unknown,
): Promise<{
  status: "deny";
  reason: Reason;
  ledgerRevision: number;
  policyRevision: number;
}> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Verify BOTH sources inside one serializable snapshot. An invalid
        // policy or tampered ledger is an integrity error, never an AI approval.
        const { row, state } = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
        const verified = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        const { policy } = verified;
        const deny = (reason: Reason) => ({
          status: "deny" as const,
          reason,
          ledgerRevision: row.version,
          policyRevision: verified.revision,
        });
        if (!policy.enabled) return deny("policy_disabled");
        if (policy.killSwitch) return deny("kill_switch_active");
        if (state.quoteCurrency !== policy.quoteCurrency) return deny("quote_currency_mismatch");
        const parsed = TradingSignalSchema.safeParse(proposedSignal);
        if (!parsed.success) return deny("invalid_signal");
        const signal: TradingSignal = parsed.data;
        if (signal.kind === "no_trade") return deny("no_trade");
        if (
          signal.executionStatus !== "research_only" ||
          signal.market.kind !== "spot" ||
          signal.action !== "spot_buy" ||
          signal.market.status !== "active" ||
          signal.market.quote !== state.quoteCurrency ||
          !policy.allowedVenues.includes(signal.market.venue)
        )
          return deny("unsupported_instrument");
        // P9 book-cost is not an attested mark/stop risk source. No optimistic
        // zero exposure assumptions may be fabricated from an AI proposal.
        if (state.positions.length > 0 || state.reservations.length > 0) {
          return deny("existing_risk_unreconciled");
        }
        // P11A has no policy-enable API or trusted quote persistence, therefore
        // preflight explicitly fails closed even if an administrator changes
        // the database policy directly. This is NOT a reserve implementation.
        return deny("trusted_market_snapshot_unavailable");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
