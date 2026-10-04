import { createHash, randomUUID } from "node:crypto";
import { type TradingSignal, TradingSignalSchema } from "@rakazo/contracts";
import { estimateExactPaperSpotCapacity } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { auditTradingPaperLifecycleInTransaction, PaperLifecycleAuditError } from "./trading-paper-lifecycle-audit.js";
import { releaseTradingPaperReservationsInTransaction } from "./trading-paper-release.js";
import {
  evaluateTradingPaperReservationInTransaction,
  type TradingPaperReservationDeny,
  type TradingPaperReservationDenyReason,
} from "./trading-paper-reservation-evaluation.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyCurrentTradingPaperEnableAuditInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import {
  appendTradingPaperLedgerEventInTransaction,
  recoverTradingPaperLedgerInTransaction,
} from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
const SCALE = 100_000_000n;
const RESERVATION_TTL_MS = 60_000;

export class PaperReservationConflictError extends Error {
  constructor(message = "Synthetic paper reservation idempotency conflict") {
    super(message);
    this.name = "PaperReservationConflictError";
  }
}
export class PaperReservationDecisionIntegrityError extends Error {
  constructor(message = "Synthetic paper reservation decision integrity mismatch") {
    super(message);
    this.name = "PaperReservationDecisionIntegrityError";
  }
}

type ReserveDenyReason =
  | TradingPaperReservationDenyReason
  | "paper_capability_unapproved"
  | "price_not_tick_aligned"
  | "capacity_unrepresentable"
  | "capacity_no_capacity"
  | "capacity_invalid_stop"
  | "capacity_below_minimum";

type TradingPaperReserveSuccess = {
  mode: "paper_only";
  signalId: string;
  reservationId: string;
  eventId: string;
  eventSequence: number;
  policyRevision: number;
  quantityBase: string;
  heldQuote: string;
  worstCaseStopRiskQuote: string;
  stopPriceQuote: string;
  expiresAt: string;
};
type TradingPaperReserveDuplicate = TradingPaperReserveSuccess & { status: "duplicate" };
type TradingPaperReserveCreated = TradingPaperReserveSuccess & { status: "reserved" };
export type TradingPaperReserveResult =
  | (Omit<TradingPaperReservationDeny, "reason"> & { reason: ReserveDenyReason })
  | TradingPaperReserveCreated
  | TradingPaperReserveDuplicate;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function units(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new PaperReservationDecisionIntegrityError("Unrepresentable exact paper amount");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
function decimal(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function remaining(cap: string, used: string): string | null {
  const left = units(cap) - units(used);
  return left > 0n ? decimal(left) : null;
}
function smaller(a: string, b: string): string {
  return units(a) <= units(b) ? a : b;
}
function requestDigest(
  owner: Owner,
  ledgerId: string,
  signal: Extract<TradingSignal, { kind: "proposal" }>,
  evidenceId: string,
): string {
  return sha256(["paper_reserve_v1", owner.spaceId, owner.userId, ledgerId, signal, evidenceId]);
}
type DecisionDigestInput = {
  ledgerId: string;
  signalId: string;
  requestSha256: string;
  evidenceId: string;
  policyApprovalEffectId: string;
  policyRevision: number;
  ledgerRevisionBefore: number;
  eventSequence: number;
  eventId: string;
  reservationId: string;
  quantityBase: string;
  heldQuote: string;
  worstCaseStopRiskQuote: string;
  stopPriceQuote: string;
  conservativeEntryQuote: string;
  conservativeStopQuote: string;
  expiresAt: string;
};
function decisionDigest(value: DecisionDigestInput): string {
  return sha256([
    value.ledgerId,
    value.signalId,
    value.requestSha256,
    value.evidenceId,
    value.policyApprovalEffectId,
    value.policyRevision,
    value.ledgerRevisionBefore,
    value.eventSequence,
    value.eventId,
    value.reservationId,
    value.quantityBase,
    value.heldQuote,
    value.worstCaseStopRiskQuote,
    value.stopPriceQuote,
    value.conservativeEntryQuote,
    value.conservativeStopQuote,
    value.expiresAt,
  ]);
}
function isUniqueConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}
function deny(
  evaluated: { ledgerRevision: number; policyRevision: number },
  reason: ReserveDenyReason,
): TradingPaperReserveResult {
  return {
    status: "deny",
    reason,
    ledgerRevision: evaluated.ledgerRevision,
    policyRevision: evaluated.policyRevision,
  };
}

async function readExistingDecision(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  signal: Extract<TradingSignal, { kind: "proposal" }>,
  evidenceId: string,
): Promise<TradingPaperReserveDuplicate | null> {
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const row = await tx.tradingPaperReservationDecision.findUnique({
    where: { ledgerId_signalId: { ledgerId, signalId: signal.signalId } },
  });
  if (!row) return null;
  const requestSha256 = requestDigest(owner, ledgerId, signal, evidenceId);
  if (row.requestSha256 !== requestSha256) {
    throw new PaperReservationConflictError("Signal id was reused with different reserve inputs");
  }
  const normalized: DecisionDigestInput = {
    ledgerId: row.ledgerId,
    signalId: row.signalId,
    requestSha256: row.requestSha256,
    evidenceId: row.evidenceId,
    policyApprovalEffectId: row.policyApprovalEffectId,
    policyRevision: row.policyRevision,
    ledgerRevisionBefore: row.ledgerRevisionBefore,
    eventSequence: row.eventSequence,
    eventId: row.eventId,
    reservationId: row.reservationId,
    quantityBase: row.quantityBase,
    heldQuote: row.heldQuote,
    worstCaseStopRiskQuote: row.worstCaseStopRiskQuote,
    stopPriceQuote: row.stopPriceQuote,
    conservativeEntryQuote: row.conservativeEntryQuote,
    conservativeStopQuote: row.conservativeStopQuote,
    expiresAt: row.expiresAt.toISOString(),
  };
  if (row.decisionSha256 !== decisionDigest(normalized)) {
    throw new PaperReservationDecisionIntegrityError();
  }
  const event = recovered.events.find((entry) => entry.eventId === row.eventId);
  if (
    event?.kind !== "reserve" ||
    event.sequence !== row.eventSequence ||
    event.reservationId !== row.reservationId ||
    event.signalId !== row.signalId ||
    event.quantityBase !== row.quantityBase ||
    event.maxSpendQuote !== row.heldQuote ||
    event.expiresAt !== row.expiresAt.toISOString() ||
    JSON.stringify(event.market) !== JSON.stringify(signal.market)
  ) {
    throw new PaperReservationDecisionIntegrityError(
      "Stored reserve decision disagrees with ledger",
    );
  }
  return {
    status: "duplicate",
    mode: "paper_only",
    signalId: row.signalId,
    reservationId: row.reservationId,
    eventId: row.eventId,
    eventSequence: row.eventSequence,
    policyRevision: row.policyRevision,
    quantityBase: row.quantityBase,
    heldQuote: row.heldQuote,
    worstCaseStopRiskQuote: row.worstCaseStopRiskQuote,
    stopPriceQuote: row.stopPriceQuote,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export type VerifiedTradingPaperReservationDecision = {
  signalId: string;
  reservationId: string;
  evidenceId: string;
  policyApprovalEffectId: string;
  policyRevision: number;
  quantityBase: string;
  heldQuote: string;
  worstCaseStopRiskQuote: string;
  stopPriceQuote: string;
  conservativeEntryQuote: string;
  conservativeStopQuote: string;
  expiresAt: string;
  reserveEventSequence: number;
  market: Extract<TradingSignal, { kind: "proposal" }>["market"];
};

export async function verifyTradingPaperReservationDecisionInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  reservationId: string,
): Promise<VerifiedTradingPaperReservationDecision | null> {
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const row = await tx.tradingPaperReservationDecision.findUnique({
    where: { ledgerId_reservationId: { ledgerId, reservationId } },
  });
  if (!row) return null;
  const normalized: DecisionDigestInput = {
    ledgerId: row.ledgerId,
    signalId: row.signalId,
    requestSha256: row.requestSha256,
    evidenceId: row.evidenceId,
    policyApprovalEffectId: row.policyApprovalEffectId,
    policyRevision: row.policyRevision,
    ledgerRevisionBefore: row.ledgerRevisionBefore,
    eventSequence: row.eventSequence,
    eventId: row.eventId,
    reservationId: row.reservationId,
    quantityBase: row.quantityBase,
    heldQuote: row.heldQuote,
    worstCaseStopRiskQuote: row.worstCaseStopRiskQuote,
    stopPriceQuote: row.stopPriceQuote,
    conservativeEntryQuote: row.conservativeEntryQuote,
    conservativeStopQuote: row.conservativeStopQuote,
    expiresAt: row.expiresAt.toISOString(),
  };
  if (row.decisionSha256 !== decisionDigest(normalized)) {
    throw new PaperReservationDecisionIntegrityError();
  }
  const event = recovered.events.find((entry) => entry.eventId === row.eventId);
  if (
    event?.kind !== "reserve" ||
    event.sequence !== row.eventSequence ||
    event.reservationId !== row.reservationId ||
    event.signalId !== row.signalId ||
    event.quantityBase !== row.quantityBase ||
    event.maxSpendQuote !== row.heldQuote ||
    event.expiresAt !== row.expiresAt.toISOString()
  ) {
    throw new PaperReservationDecisionIntegrityError(
      "Stored reserve decision disagrees with ledger",
    );
  }
  return {
    signalId: row.signalId,
    reservationId: row.reservationId,
    evidenceId: row.evidenceId,
    policyApprovalEffectId: row.policyApprovalEffectId,
    policyRevision: row.policyRevision,
    quantityBase: row.quantityBase,
    heldQuote: row.heldQuote,
    worstCaseStopRiskQuote: row.worstCaseStopRiskQuote,
    stopPriceQuote: row.stopPriceQuote,
    conservativeEntryQuote: row.conservativeEntryQuote,
    conservativeStopQuote: row.conservativeStopQuote,
    expiresAt: row.expiresAt.toISOString(),
    reserveEventSequence: row.eventSequence,
    market: event.market,
  };
}

/** INTERNAL ONLY. This creates a synthetic virtual hold, never an exchange
 * order. No URL, account, key, venue signing function or live-order payload is
 * accepted. The model cannot choose IDs, timestamps, size or max-spend. */
export async function reserveApprovedTradingPaperSignal(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  proposedSignal: unknown,
  evidenceId: string,
): Promise<TradingPaperReserveResult> {
  const parsed = TradingSignalSchema.safeParse(proposedSignal);
  const proposal = parsed.success && parsed.data.kind === "proposal" ? parsed.data : null;
  const reservationId = `paper-resv:${randomUUID()}`;
  const eventId = `paper-event:${randomUUID()}`;

  const operation = async (): Promise<TradingPaperReserveResult> =>
    prisma.$transaction(
      async (tx) => {
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
        if (proposal) {
          const existing = await readExistingDecision(tx, owner, ledgerId, proposal, evidenceId);
          if (existing) return existing;
        }
        const currentPolicy = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        await releaseTradingPaperReservationsInTransaction(
          tx,
          owner,
          ledgerId,
          !currentPolicy.policy.enabled || currentPolicy.policy.killSwitch
            ? "kill_switch"
            : "expired",
          currentPolicy.revision,
          Date.now(),
        );
        const evaluated = await evaluateTradingPaperReservationInTransaction(
          tx,
          owner,
          ledgerId,
          proposedSignal,
          evidenceId,
        );
        if (evaluated.status === "deny") return evaluated;
        const signal = evaluated.signal;
        const approval = await verifyCurrentTradingPaperEnableAuditInTransaction(
          tx,
          owner,
          ledgerId,
          evaluated.policyRevision,
          evaluated.policy,
        );
        if (!approval) return deny(evaluated, "paper_capability_unapproved");

        try {
          const tick = signal.market.priceIncrement;
          const lot = signal.market.quantityIncrement;
          if (
            tick === null ||
            lot === null ||
            units(signal.entryTrigger) % units(tick) !== 0n ||
            units(signal.stopLoss) % units(tick) !== 0n
          ) {
            return deny(evaluated, "price_not_tick_aligned");
          }
          const remainingDaily = remaining(
            evaluated.policy.maxDailyLossQuote,
            evaluated.risk.realizedLossTodayQuote,
          );
          const remainingOpen = remaining(
            evaluated.policy.maxOpenRiskQuote,
            evaluated.openStopRiskQuote,
          );
          const remainingExposure = remaining(
            evaluated.policy.maxTotalExposureQuote,
            evaluated.risk.openExposureQuote,
          );
          if (!remainingDaily || !remainingOpen || !remainingExposure) {
            return deny(evaluated, "capacity_no_capacity");
          }
          const perIdea =
            signal.riskBudgetQuote === null
              ? evaluated.policy.maxPerIdeaRiskQuote
              : smaller(evaluated.policy.maxPerIdeaRiskQuote, signal.riskBudgetQuote);
          const capacity = estimateExactPaperSpotCapacity({
            availableQuote: evaluated.state.availableQuote,
            askQuote: evaluated.evidence.ticker.ask,
            stopQuote: signal.stopLoss,
            quantityIncrement: lot,
            minNotionalQuote: signal.market.minNotional,
            maxPerIdeaRiskQuote: perIdea,
            maxDailyLossQuote: remainingDaily,
            maxOpenRiskQuote: remainingOpen,
            maxTotalExposureQuote: remainingExposure,
            assumedFeeBpsPerSide: evaluated.policy.assumedFeeBpsPerSide,
            assumedSlippageBpsPerSide: evaluated.policy.assumedSlippageBpsPerSide,
          });
          if (capacity.status === "deny") {
            return deny(evaluated, `capacity_${capacity.reason}` as ReserveDenyReason);
          }
          const signalExpiry = Date.parse(signal.expiresAt);
          const expiresAtMs = Math.min(signalExpiry, evaluated.decisionNow + RESERVATION_TTL_MS);
          if (expiresAtMs - evaluated.decisionNow < 1_000) {
            return deny(evaluated, "signal_expired");
          }
          const expiresAt = new Date(expiresAtMs).toISOString();
          const eventSequence = evaluated.ledgerRevision + 1;
          const event = {
            ledgerId,
            eventId,
            kind: "reserve" as const,
            sequence: eventSequence,
            recordedAt: new Date(evaluated.decisionNow).toISOString(),
            reservationId,
            signalId: signal.signalId,
            market: signal.market,
            quantityBase: capacity.quantityBase,
            maxSpendQuote: capacity.heldQuote,
            expiresAt,
          };
          const appended = await appendTradingPaperLedgerEventInTransaction(tx, owner, event);
          if (appended.status !== "appended") {
            throw new PaperReservationDecisionIntegrityError(
              "Fresh B7 event unexpectedly duplicated",
            );
          }
          const requestSha256 = requestDigest(owner, ledgerId, signal, evidenceId);
          const normalized: DecisionDigestInput = {
            ledgerId,
            signalId: signal.signalId,
            requestSha256,
            evidenceId,
            policyApprovalEffectId: approval.effectId,
            policyRevision: evaluated.policyRevision,
            ledgerRevisionBefore: evaluated.ledgerRevision,
            eventSequence,
            eventId,
            reservationId,
            quantityBase: capacity.quantityBase,
            heldQuote: capacity.heldQuote,
            worstCaseStopRiskQuote: capacity.worstCaseStopRiskQuote,
            stopPriceQuote: signal.stopLoss,
            conservativeEntryQuote: capacity.conservativeEntryQuote,
            conservativeStopQuote: capacity.conservativeStopQuote,
            expiresAt,
          };
          await tx.tradingPaperReservationDecision.create({
            data: {
              ...normalized,
              expiresAt: new Date(expiresAt),
              decisionSha256: decisionDigest(normalized),
            },
          });
          await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
          return {
            status: "reserved",
            mode: "paper_only",
            signalId: signal.signalId,
            reservationId,
            eventId,
            eventSequence,
            policyRevision: evaluated.policyRevision,
            quantityBase: capacity.quantityBase,
            heldQuote: capacity.heldQuote,
            worstCaseStopRiskQuote: capacity.worstCaseStopRiskQuote,
            stopPriceQuote: signal.stopLoss,
            expiresAt,
          };
        } catch (error) {
          if (
            error instanceof PaperReservationDecisionIntegrityError ||
            error instanceof PaperLifecycleAuditError
          )
            throw error;
          return deny(evaluated, "capacity_unrepresentable");
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  try {
    return await withTransactionRetry(operation);
  } catch (error) {
    if (!proposal || !isUniqueConflict(error)) throw error;
    return withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
          const existing = await readExistingDecision(tx, owner, ledgerId, proposal, evidenceId);
          if (!existing) throw error;
          return existing;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }
}
