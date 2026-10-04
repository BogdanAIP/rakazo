import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  PaperFillIntegrityError,
  verifyTradingPaperOpenFillInTransaction,
} from "./trading-paper-fill.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyCurrentTradingPaperEnableAuditInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import {
  appendTradingPaperLedgerEventInTransaction,
  recoverTradingPaperLedgerInTransaction,
} from "./trading-paper-store.js";
import { assertTradingPaperCallerInTransaction, type PaperBotCaller } from "./trading-paper-bot.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
const SCALE = 100_000_000n;
const BPS_SCALE = 100_000_000n;

export class PaperCloseConflictError extends Error {
  constructor(message = "Synthetic paper close idempotency conflict") {
    super(message);
    this.name = "PaperCloseConflictError";
  }
}
export class PaperCloseIntegrityError extends Error {
  constructor(message = "Synthetic paper close integrity mismatch") {
    super(message);
    this.name = "PaperCloseIntegrityError";
  }
}

type TradingPaperCloseSuccess = {
  mode: "paper_only";
  positionId: string;
  signalId: string;
  closeEventId: string;
  closeEventSequence: number;
  policyRevision: number;
  quantityBase: string;
  executedPriceQuote: string;
  feeQuote: string;
  stopPriceQuote: string;
  closedAt: string;
};
type TradingPaperCloseCreated = TradingPaperCloseSuccess & { status: "closed" };
type TradingPaperCloseDuplicate = TradingPaperCloseSuccess & { status: "duplicate" };
export type TradingPaperCloseResult =
  | {
      status: "deny";
      mode: "paper_only";
      reason:
        | "policy_disabled"
        | "kill_switch_active"
        | "position_unverified"
        | "position_unavailable"
        | "paper_capability_unapproved"
        | "trusted_market_snapshot_unavailable"
        | "market_snapshot_stale"
        | "market_snapshot_mismatch"
        | "market_spread_exceeded"
        | "stop_not_triggered"
        | "close_price_unrepresentable"
        | "risk_state_unavailable";
    }
  | TradingPaperCloseCreated
  | TradingPaperCloseDuplicate;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function units(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new PaperCloseIntegrityError("Unrepresentable exact close amount");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
function decimal(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}
function bpsScaled(value: number): bigint | null {
  const raw = String(value);
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}
function requestDigest(owner: Owner, ledgerId: string, positionId: string, evidenceId: string) {
  return sha256([
    "paper_stop_close_v1",
    owner.spaceId,
    owner.userId,
    ledgerId,
    positionId,
    evidenceId,
  ]);
}
type CloseDigestInput = {
  ledgerId: string;
  positionId: string;
  requestSha256: string;
  evidenceId: string;
  policyApprovalEffectId: string;
  policyRevision: number;
  buyFillEventSequence: number;
  closeEventSequence: number;
  closeEventId: string;
  quantityBase: string;
  executedPriceQuote: string;
  feeQuote: string;
  stopPriceQuote: string;
  closedAt: string;
};
function decisionDigest(value: CloseDigestInput): string {
  return sha256([
    value.ledgerId,
    value.positionId,
    value.requestSha256,
    value.evidenceId,
    value.policyApprovalEffectId,
    value.policyRevision,
    value.buyFillEventSequence,
    value.closeEventSequence,
    value.closeEventId,
    value.quantityBase,
    value.executedPriceQuote,
    value.feeQuote,
    value.stopPriceQuote,
    value.closedAt,
  ]);
}
async function readExistingClose(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  positionId: string,
  evidenceId: string,
): Promise<TradingPaperCloseDuplicate | null> {
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const row = await tx.tradingPaperCloseDecision.findUnique({
    where: { ledgerId_positionId: { ledgerId, positionId } },
  });
  if (!row) return null;
  if (row.requestSha256 !== requestDigest(owner, ledgerId, positionId, evidenceId)) {
    throw new PaperCloseConflictError("Closed position retried with different evidence");
  }
  const normalized: CloseDigestInput = {
    ledgerId: row.ledgerId,
    positionId: row.positionId,
    requestSha256: row.requestSha256,
    evidenceId: row.evidenceId,
    policyApprovalEffectId: row.policyApprovalEffectId,
    policyRevision: row.policyRevision,
    buyFillEventSequence: row.buyFillEventSequence,
    closeEventSequence: row.closeEventSequence,
    closeEventId: row.closeEventId,
    quantityBase: row.quantityBase,
    executedPriceQuote: row.executedPriceQuote,
    feeQuote: row.feeQuote,
    stopPriceQuote: row.stopPriceQuote,
    closedAt: row.closedAt.toISOString(),
  };
  if (row.decisionSha256 !== decisionDigest(normalized)) throw new PaperCloseIntegrityError();
  const event = recovered.events.find((entry) => entry.eventId === row.closeEventId);
  if (
    event?.kind !== "fill_sell" ||
    event.sequence !== row.closeEventSequence ||
    event.positionId !== positionId ||
    event.quantityBase !== row.quantityBase ||
    event.executedPriceQuote !== row.executedPriceQuote ||
    event.feeQuote !== row.feeQuote ||
    event.recordedAt !== row.closedAt.toISOString() ||
    recovered.state.positions.some((entry) => entry.positionId === positionId)
  ) {
    throw new PaperCloseIntegrityError("Stored close decision disagrees with ledger");
  }
  if ((await tx.tradingPaperStopGuard.count({ where: { ledgerId, positionId } })) !== 0) {
    throw new PaperCloseIntegrityError("Closed position retained a stop guard");
  }
  const fill = await tx.tradingPaperFillDecision.findUnique({
    where: { ledgerId_reservationId: { ledgerId, reservationId: positionId } },
  });
  if (!fill || fill.fillEventSequence !== row.buyFillEventSequence) {
    throw new PaperCloseIntegrityError("Close decision lacks matching buy fill");
  }
  const positionSignal = recovered.events.find(
    (entry) => entry.kind === "reserve" && entry.reservationId === positionId,
  );
  if (positionSignal?.kind !== "reserve") {
    throw new PaperCloseIntegrityError("Close decision lacks matching reserve");
  }
  return {
    status: "duplicate",
    mode: "paper_only",
    positionId,
    signalId: positionSignal.signalId,
    closeEventId: row.closeEventId,
    closeEventSequence: row.closeEventSequence,
    policyRevision: row.policyRevision,
    quantityBase: row.quantityBase,
    executedPriceQuote: row.executedPriceQuote,
    feeQuote: row.feeQuote,
    stopPriceQuote: row.stopPriceQuote,
    closedAt: row.closedAt.toISOString(),
  };
}

/** INTERNAL ONLY stop-triggered synthetic close. A model cannot select exit
 * price, fee, quantity, stop, timestamp or event id. No broker I/O exists. */
export async function closeTradingPaperPositionOnStop(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  positionId: string,
  evidenceId: string,
  caller?: PaperBotCaller,
): Promise<TradingPaperCloseResult> {
  const operation = async (): Promise<TradingPaperCloseResult> =>
    prisma.$transaction(
      async (tx) => {
        await assertTradingPaperCallerInTransaction(tx, owner, ledgerId, caller, "protective");
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
        const prior = await readExistingClose(tx, owner, ledgerId, positionId, evidenceId);
        if (prior) return prior;

        const policy = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        if (!policy.policy.enabled) {
          return { status: "deny", mode: "paper_only", reason: "policy_disabled" };
        }
        if (policy.policy.killSwitch) {
          return { status: "deny", mode: "paper_only", reason: "kill_switch_active" };
        }
        const approval = await verifyCurrentTradingPaperEnableAuditInTransaction(
          tx,
          owner,
          ledgerId,
          policy.revision,
          policy.policy,
        );
        if (!approval) {
          return { status: "deny", mode: "paper_only", reason: "paper_capability_unapproved" };
        }

        const opened = await verifyTradingPaperOpenFillInTransaction(
          tx,
          owner,
          ledgerId,
          positionId,
        );
        if (!opened) {
          const closed = await tx.tradingPaperCloseDecision.findUnique({
            where: { ledgerId_positionId: { ledgerId, positionId } },
          });
          if (closed) {
            throw new PaperCloseIntegrityError(
              "Close decision became visible without idempotent read",
            );
          }
          return { status: "deny", mode: "paper_only", reason: "position_unverified" };
        }
        const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
        if (!recovered.state.positions.some((entry) => entry.positionId === positionId)) {
          return { status: "deny", mode: "paper_only", reason: "position_unavailable" };
        }

        const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
          tx,
          owner,
          ledgerId,
          evidenceId,
        );
        if (!evidence) {
          return {
            status: "deny",
            mode: "paper_only",
            reason: "trusted_market_snapshot_unavailable",
          };
        }
        if (JSON.stringify(evidence.market) !== JSON.stringify(opened.market)) {
          return { status: "deny", mode: "paper_only", reason: "market_snapshot_mismatch" };
        }
        const now = Date.now();
        const observed = Date.parse(evidence.ticker.observedAt);
        const fetched = Date.parse(evidence.ticker.fetchedAt);
        if (
          observed > fetched + 2_000 ||
          fetched > now + 2_000 ||
          observed > now + 2_000 ||
          now - observed > policy.policy.maxAgeMs ||
          now - fetched > policy.policy.maxAgeMs
        ) {
          return { status: "deny", mode: "paper_only", reason: "market_snapshot_stale" };
        }
        const bid = units(evidence.ticker.bid);
        const ask = units(evidence.ticker.ask);
        const stop = units(opened.stopPriceQuote);
        const spreadCap = bpsScaled(policy.policy.maxSpreadBps);
        const feeBps = bpsScaled(policy.policy.assumedFeeBpsPerSide);
        const slippageBps = bpsScaled(policy.policy.assumedSlippageBpsPerSide);
        if (spreadCap === null || feeBps === null || slippageBps === null) {
          return { status: "deny", mode: "paper_only", reason: "risk_state_unavailable" };
        }
        if (2n * (ask - bid) * BPS_SCALE > spreadCap * (ask + bid)) {
          return { status: "deny", mode: "paper_only", reason: "market_spread_exceeded" };
        }
        if (bid > stop) {
          return { status: "deny", mode: "paper_only", reason: "stop_not_triggered" };
        }
        const tickText = opened.market.priceIncrement;
        if (tickText === null) throw new PaperFillIntegrityError("Open position lacks price tick");
        const tick = units(tickText);
        const slippedBid = (bid * (BPS_SCALE - slippageBps)) / BPS_SCALE;
        const executed = (slippedBid / tick) * tick;
        if (executed <= 0n) {
          return { status: "deny", mode: "paper_only", reason: "close_price_unrepresentable" };
        }
        const quantity = units(opened.quantityBase);
        const proceeds = (quantity * executed) / SCALE;
        const fee = ceilDiv(proceeds * feeBps, BPS_SCALE);
        if (fee >= proceeds) {
          return { status: "deny", mode: "paper_only", reason: "close_price_unrepresentable" };
        }
        const lastAt = recovered.events.at(-1)
          ? Date.parse(recovered.events.at(-1)!.recordedAt)
          : recovered.row.openedAt.getTime();
        if (lastAt > now + 2_000) {
          throw new PaperCloseIntegrityError(
            "Paper journal is future-dated relative to close clock",
          );
        }
        const closedAt = new Date(Math.max(now, lastAt)).toISOString();
        const closeEventId = `paper-close:${randomUUID()}`;
        const closeEventSequence = recovered.state.nextSequence;
        const executedPriceQuote = decimal(executed);
        const feeQuote = decimal(fee);
        const appended = await appendTradingPaperLedgerEventInTransaction(tx, owner, {
          ledgerId,
          eventId: closeEventId,
          sequence: closeEventSequence,
          kind: "fill_sell",
          recordedAt: closedAt,
          positionId,
          quantityBase: opened.quantityBase,
          executedPriceQuote,
          feeQuote,
        }, caller);
        if (appended.status !== "appended") {
          throw new PaperCloseIntegrityError("Fresh synthetic close unexpectedly duplicated");
        }
        const removed = await tx.tradingPaperStopGuard.deleteMany({
          where: { ledgerId, positionId },
        });
        if (removed.count !== 1) {
          throw new PaperCloseIntegrityError(
            "Synthetic close did not remove exactly one stop guard",
          );
        }
        const requestSha256 = requestDigest(owner, ledgerId, positionId, evidenceId);
        const normalized: CloseDigestInput = {
          ledgerId,
          positionId,
          requestSha256,
          evidenceId,
          policyApprovalEffectId: approval.effectId,
          policyRevision: policy.revision,
          buyFillEventSequence: opened.fillEventSequence,
          closeEventSequence,
          closeEventId,
          quantityBase: opened.quantityBase,
          executedPriceQuote,
          feeQuote,
          stopPriceQuote: opened.stopPriceQuote,
          closedAt,
        };
        await tx.tradingPaperCloseDecision.create({
          data: {
            ...normalized,
            closedAt: new Date(closedAt),
            decisionSha256: decisionDigest(normalized),
          },
        });
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
        return {
          status: "closed",
          mode: "paper_only",
          positionId,
          signalId: opened.signalId,
          closeEventId,
          closeEventSequence,
          policyRevision: policy.revision,
          quantityBase: opened.quantityBase,
          executedPriceQuote,
          feeQuote,
          stopPriceQuote: opened.stopPriceQuote,
          closedAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  return withTransactionRetry(operation);
}
