import { type TradingSignal, TradingSignalSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import { verifyTradingPaperRiskPolicyInTransaction } from "./trading-paper-risk-policy.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
const SCALE = 100_000_000n;
const BPS_SCALE = 100_000_000n;
function units(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Unsupported exact paper quote decimal");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
function bpsScaled(value: number): bigint | null {
  const raw = String(value);
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}
type Reason =
  | "policy_disabled"
  | "kill_switch_active"
  | "quote_currency_mismatch"
  | "no_trade"
  | "invalid_signal"
  | "unsupported_instrument"
  | "existing_risk_unreconciled"
  | "trusted_market_snapshot_unavailable"
  | "market_snapshot_stale"
  | "market_snapshot_mismatch"
  | "market_spread_exceeded"
  | "market_trigger_deviation_exceeded"
  | "signal_expired"
  | "risk_state_unavailable";

/** Inert, transaction-bound first stage of P11B. Never returns ALLOW, a
 * reservation, an eventId, an order, or an authorization token. The policy is
 * intentionally default-denied in P11A. A later audited, authenticated Worker
 * must separately provide trusted provenance and durable daily/stop exposure
 * and explicit owner permission before a reserve path can exist. The optional
 * evidenceId is only a lookup key, never model-issued authority. */
export async function preflightTradingPaperReservation(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  proposedSignal: unknown,
  evidenceId: string | null = null,
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
        // Explicit evidence ID is a locator, NOT evidence of source provenance
        // or a capability. Never take a model's evidenceIds as market authority.
        if (!evidenceId || evidenceId.length > 128) {
          return deny("trusted_market_snapshot_unavailable");
        }
        const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
          tx,
          owner,
          ledgerId,
          evidenceId,
        );
        if (!evidence) return deny("trusted_market_snapshot_unavailable");
        if (JSON.stringify(evidence.market) !== JSON.stringify(signal.market)) {
          return deny("market_snapshot_mismatch");
        }
        const now = Date.now();
        const observed = Date.parse(evidence.ticker.observedAt);
        const fetched = Date.parse(evidence.ticker.fetchedAt);
        if (
          observed > fetched + 2_000 ||
          fetched > now + 2_000 ||
          observed > now + 2_000 ||
          now - observed > policy.maxAgeMs ||
          now - fetched > policy.maxAgeMs
        )
          return deny("market_snapshot_stale");
        if (Date.parse(signal.expiresAt) <= now || Date.parse(signal.createdAt) > now + 2_000)
          return deny("signal_expired");
        const bid = units(evidence.ticker.bid);
        const ask = units(evidence.ticker.ask);
        const trigger = units(signal.entryTrigger);
        const spreadCap = bpsScaled(policy.maxSpreadBps);
        const deviationCap = bpsScaled(policy.maxTriggerDeviationBps);
        if (spreadCap === null || deviationCap === null) {
          return deny("risk_state_unavailable");
        }
        if (2n * (ask - bid) * BPS_SCALE > spreadCap * (ask + bid)) {
          return deny("market_spread_exceeded");
        }
        const deviation = trigger >= ask ? trigger - ask : ask - trigger;
        if (deviation * BPS_SCALE > deviationCap * ask) {
          return deny("market_trigger_deviation_exceeded");
        }
        // A source-labeled public GET response is not a signed exchange feed.
        // There is still no durable mark/stop exposure + daily PnL risk state,
        // authenticated policy-enable path, or independently authorized reserve.
        // Even a valid fresh observation MUST fail closed and write NOTHING.
        return deny("risk_state_unavailable");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
