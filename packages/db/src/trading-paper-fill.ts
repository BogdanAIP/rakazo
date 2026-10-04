import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import { releaseTradingPaperReservationsInTransaction } from "./trading-paper-release.js";
import {
  PaperReservationDecisionIntegrityError,
  verifyTradingPaperReservationDecisionInTransaction,
} from "./trading-paper-reserve.js";
import {
  lockTradingPaperRiskPolicyInTransaction,
  verifyCurrentTradingPaperEnableAuditInTransaction,
  verifyTradingPaperRiskPolicyInTransaction,
} from "./trading-paper-risk-policy.js";
import {
  recordTradingPaperStopGuardForOpenPositionInTransaction,
  verifyTradingPaperStopGuardsInTransaction,
} from "./trading-paper-stop-guard.js";
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

export class PaperFillConflictError extends Error {
  constructor(message = "Synthetic paper fill idempotency conflict") {
    super(message);
    this.name = "PaperFillConflictError";
  }
}
export class PaperFillIntegrityError extends Error {
  constructor(message = "Synthetic paper fill integrity mismatch") {
    super(message);
    this.name = "PaperFillIntegrityError";
  }
}

type TradingPaperFillSuccess = {
  mode: "paper_only";
  reservationId: string;
  signalId: string;
  fillEventId: string;
  fillEventSequence: number;
  policyRevision: number;
  quantityBase: string;
  executedPriceQuote: string;
  feeQuote: string;
  stopPriceQuote: string;
  filledAt: string;
};
type TradingPaperFillCreated = TradingPaperFillSuccess & { status: "filled" };
type TradingPaperFillDuplicate = TradingPaperFillSuccess & { status: "duplicate" };
export type TradingPaperFillResult =
  | {
      status: "deny";
      mode: "paper_only";
      reason:
        | "policy_disabled"
        | "kill_switch_active"
        | "reservation_unverified"
        | "reservation_unavailable"
        | "reservation_expired"
        | "policy_revision_changed"
        | "paper_capability_unapproved"
        | "trusted_market_snapshot_unavailable"
        | "market_snapshot_stale"
        | "market_snapshot_mismatch"
        | "market_spread_exceeded"
        | "price_beyond_reserve_cap"
        | "invalid_stop_for_fill"
        | "held_quote_exceeded"
        | "risk_state_unavailable";
    }
  | TradingPaperFillCreated
  | TradingPaperFillDuplicate;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function units(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new PaperFillIntegrityError("Unrepresentable exact paper amount");
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
function requestDigest(owner: Owner, ledgerId: string, reservationId: string, evidenceId: string) {
  return sha256([
    "paper_fill_buy_v1",
    owner.spaceId,
    owner.userId,
    ledgerId,
    reservationId,
    evidenceId,
  ]);
}
type FillDigestInput = {
  ledgerId: string;
  reservationId: string;
  requestSha256: string;
  evidenceId: string;
  policyApprovalEffectId: string;
  policyRevision: number;
  reserveEventSequence: number;
  fillEventSequence: number;
  fillEventId: string;
  quantityBase: string;
  executedPriceQuote: string;
  feeQuote: string;
  stopPriceQuote: string;
  filledAt: string;
};
function decisionDigest(value: FillDigestInput): string {
  return sha256([
    value.ledgerId,
    value.reservationId,
    value.requestSha256,
    value.evidenceId,
    value.policyApprovalEffectId,
    value.policyRevision,
    value.reserveEventSequence,
    value.fillEventSequence,
    value.fillEventId,
    value.quantityBase,
    value.executedPriceQuote,
    value.feeQuote,
    value.stopPriceQuote,
    value.filledAt,
  ]);
}

async function readExistingFill(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  reservationId: string,
  evidenceId: string,
): Promise<TradingPaperFillDuplicate | null> {
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const row = await tx.tradingPaperFillDecision.findUnique({
    where: { ledgerId_reservationId: { ledgerId, reservationId } },
  });
  if (!row) return null;
  const expectedRequest = requestDigest(owner, ledgerId, reservationId, evidenceId);
  if (row.requestSha256 !== expectedRequest) {
    throw new PaperFillConflictError("Reservation fill retried with different evidence");
  }
  const normalized: FillDigestInput = {
    ledgerId: row.ledgerId,
    reservationId: row.reservationId,
    requestSha256: row.requestSha256,
    evidenceId: row.evidenceId,
    policyApprovalEffectId: row.policyApprovalEffectId,
    policyRevision: row.policyRevision,
    reserveEventSequence: row.reserveEventSequence,
    fillEventSequence: row.fillEventSequence,
    fillEventId: row.fillEventId,
    quantityBase: row.quantityBase,
    executedPriceQuote: row.executedPriceQuote,
    feeQuote: row.feeQuote,
    stopPriceQuote: row.stopPriceQuote,
    filledAt: row.filledAt.toISOString(),
  };
  if (row.decisionSha256 !== decisionDigest(normalized)) throw new PaperFillIntegrityError();
  const fillEvent = recovered.events.find((event) => event.eventId === row.fillEventId);
  const reserveEvent = recovered.events.find(
    (event) => event.kind === "reserve" && event.reservationId === reservationId,
  );
  const position = recovered.state.positions.find(
    (entry) => entry.positionId === row.reservationId,
  );
  if (
    reserveEvent?.kind !== "reserve" ||
    reserveEvent.sequence !== row.reserveEventSequence ||
    fillEvent?.kind !== "fill_buy" ||
    fillEvent.sequence !== row.fillEventSequence ||
    fillEvent.reservationId !== row.reservationId ||
    fillEvent.quantityBase !== row.quantityBase ||
    fillEvent.executedPriceQuote !== row.executedPriceQuote ||
    fillEvent.feeQuote !== row.feeQuote ||
    fillEvent.recordedAt !== row.filledAt.toISOString()
  ) {
    throw new PaperFillIntegrityError("Stored fill decision disagrees with historical ledger");
  }
  // This internal reader is called only after the strict C3 lifecycle audit
  // has independently verified all decision digests, outbox and full-lot
  // terminal conservation in the SAME serializable, policy-locked transaction.
  const guards = await verifyTradingPaperStopGuardsInTransaction(
    tx,
    ledgerId,
    recovered.events,
    recovered.state,
  );
  const guard = guards?.find((entry) => entry.positionId === reservationId);
  if (position) {
    if (
      position.signalId !== reserveEvent.signalId ||
      position.quantityBase !== row.quantityBase ||
      !guard ||
      guard.stopPriceQuote !== row.stopPriceQuote
    ) {
      throw new PaperFillIntegrityError("Open fill lacks its matching verified stop guard");
    }
  } else {
    // A legitimate full-lot stop close removes the position and its guard.
    // Its immutable hashed close decision + matching sell event were verified
    // by the C3 pre-audit. Do not mistake that terminal state for corruption.
    const closed = await tx.tradingPaperCloseDecision.findUnique({
      where: { ledgerId_positionId: { ledgerId, positionId: reservationId } },
    });
    const sellEvent = recovered.events.find(
      (event) => event.kind === "fill_sell" && event.positionId === reservationId,
    );
    if (
      guard ||
      !closed ||
      sellEvent?.kind !== "fill_sell" ||
      closed.buyFillEventSequence !== row.fillEventSequence ||
      closed.closeEventSequence !== sellEvent.sequence ||
      closed.closeEventId !== sellEvent.eventId ||
      closed.quantityBase !== row.quantityBase ||
      closed.stopPriceQuote !== row.stopPriceQuote
    ) {
      throw new PaperFillIntegrityError("Historical fill lacks a verified terminal stop close");
    }
  }
  return {
    status: "duplicate",
    mode: "paper_only",
    reservationId: row.reservationId,
    signalId: reserveEvent.signalId,
    fillEventId: row.fillEventId,
    fillEventSequence: row.fillEventSequence,
    policyRevision: row.policyRevision,
    quantityBase: row.quantityBase,
    executedPriceQuote: row.executedPriceQuote,
    feeQuote: row.feeQuote,
    stopPriceQuote: row.stopPriceQuote,
    filledAt: row.filledAt.toISOString(),
  };
}

export type VerifiedTradingPaperOpenFill = {
  positionId: string;
  signalId: string;
  policyRevision: number;
  quantityBase: string;
  executedPriceQuote: string;
  feeQuote: string;
  stopPriceQuote: string;
  fillEventSequence: number;
  market: Awaited<
    ReturnType<typeof verifyTradingPaperReservationDecisionInTransaction>
  > extends infer T
    ? T extends { market: infer M }
      ? M
      : never
    : never;
};

export async function verifyTradingPaperOpenFillInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  positionId: string,
): Promise<VerifiedTradingPaperOpenFill | null> {
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const row = await tx.tradingPaperFillDecision.findUnique({
    where: { ledgerId_reservationId: { ledgerId, reservationId: positionId } },
  });
  if (!row) return null;
  const normalized: FillDigestInput = {
    ledgerId: row.ledgerId,
    reservationId: row.reservationId,
    requestSha256: row.requestSha256,
    evidenceId: row.evidenceId,
    policyApprovalEffectId: row.policyApprovalEffectId,
    policyRevision: row.policyRevision,
    reserveEventSequence: row.reserveEventSequence,
    fillEventSequence: row.fillEventSequence,
    fillEventId: row.fillEventId,
    quantityBase: row.quantityBase,
    executedPriceQuote: row.executedPriceQuote,
    feeQuote: row.feeQuote,
    stopPriceQuote: row.stopPriceQuote,
    filledAt: row.filledAt.toISOString(),
  };
  if (row.decisionSha256 !== decisionDigest(normalized)) throw new PaperFillIntegrityError();
  const fillEvent = recovered.events.find((event) => event.eventId === row.fillEventId);
  const position = recovered.state.positions.find((entry) => entry.positionId === positionId);
  if (
    fillEvent?.kind !== "fill_buy" ||
    fillEvent.sequence !== row.fillEventSequence ||
    fillEvent.reservationId !== positionId ||
    fillEvent.quantityBase !== row.quantityBase ||
    fillEvent.executedPriceQuote !== row.executedPriceQuote ||
    fillEvent.feeQuote !== row.feeQuote ||
    fillEvent.recordedAt !== row.filledAt.toISOString() ||
    !position ||
    position.quantityBase !== row.quantityBase
  ) {
    throw new PaperFillIntegrityError("Open fill decision disagrees with current ledger position");
  }
  const reservation = await verifyTradingPaperReservationDecisionInTransaction(
    tx,
    owner,
    ledgerId,
    positionId,
  );
  if (
    !reservation ||
    reservation.signalId !== position.signalId ||
    reservation.quantityBase !== position.quantityBase
  ) {
    throw new PaperFillIntegrityError("Open fill lacks matching verified reserve decision");
  }
  const guards = await verifyTradingPaperStopGuardsInTransaction(
    tx,
    ledgerId,
    recovered.events,
    recovered.state,
  );
  const guard = guards?.find((entry) => entry.positionId === positionId);
  if (
    !guard ||
    guard.signalId !== position.signalId ||
    guard.quantityBase !== position.quantityBase ||
    guard.stopPriceQuote !== row.stopPriceQuote
  ) {
    throw new PaperFillIntegrityError("Open fill lacks matching verified stop guard");
  }
  return {
    positionId,
    signalId: position.signalId,
    policyRevision: row.policyRevision,
    quantityBase: row.quantityBase,
    executedPriceQuote: row.executedPriceQuote,
    feeQuote: row.feeQuote,
    stopPriceQuote: row.stopPriceQuote,
    fillEventSequence: row.fillEventSequence,
    market: reservation.market,
  };
}

/** INTERNAL ONLY synthetic full-fill simulator. No exchange account, private
 * endpoint, signing function or order payload exists in this path. */
export async function fillApprovedTradingPaperReservation(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  reservationId: string,
  evidenceId: string,
  caller?: PaperBotCaller,
): Promise<TradingPaperFillResult> {
  const operation = async (): Promise<TradingPaperFillResult> =>
    prisma.$transaction(
      async (tx) => {
        await assertTradingPaperCallerInTransaction(tx, owner, ledgerId, caller, "new_exposure");
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
        const prior = await readExistingFill(tx, owner, ledgerId, reservationId, evidenceId);
        if (prior) return prior;

        const policy = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
        if (!policy.policy.enabled) {
          return { status: "deny", mode: "paper_only", reason: "policy_disabled" };
        }
        if (policy.policy.killSwitch) {
          return { status: "deny", mode: "paper_only", reason: "kill_switch_active" };
        }
        const reservation = await verifyTradingPaperReservationDecisionInTransaction(
          tx,
          owner,
          ledgerId,
          reservationId,
        );
        if (!reservation) {
          return { status: "deny", mode: "paper_only", reason: "reservation_unverified" };
        }
        if (reservation.policyRevision !== policy.revision) {
          return { status: "deny", mode: "paper_only", reason: "policy_revision_changed" };
        }
        const approval = await verifyCurrentTradingPaperEnableAuditInTransaction(
          tx,
          owner,
          ledgerId,
          policy.revision,
          policy.policy,
        );
        if (!approval || approval.effectId !== reservation.policyApprovalEffectId) {
          return { status: "deny", mode: "paper_only", reason: "paper_capability_unapproved" };
        }

        const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
        const open = recovered.state.reservations.find(
          (entry) => entry.reservationId === reservationId,
        );
        if (!open) {
          const released = await tx.tradingPaperReleaseAudit.findUnique({
            where: { ledgerId_reservationId: { ledgerId, reservationId } },
          });
          if (released) {
            return { status: "deny", mode: "paper_only", reason: "reservation_unavailable" };
          }
          throw new PaperReservationDecisionIntegrityError(
            "Verified reservation decision is neither open nor released/filled",
          );
        }
        const now = Date.now();
        const lastAt = recovered.events.at(-1)
          ? Date.parse(recovered.events.at(-1)!.recordedAt)
          : recovered.row.openedAt.getTime();
        if (lastAt > now + 2_000) {
          throw new PaperFillIntegrityError("Paper journal is future-dated relative to fill clock");
        }
        if (Date.parse(open.expiresAt) <= now) {
          await releaseTradingPaperReservationsInTransaction(
            tx,
            owner,
            ledgerId,
            "expired",
            policy.revision,
            now,
            caller,
          );
          return { status: "deny", mode: "paper_only", reason: "reservation_expired" };
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
        if (JSON.stringify(evidence.market) !== JSON.stringify(reservation.market)) {
          return { status: "deny", mode: "paper_only", reason: "market_snapshot_mismatch" };
        }
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
        const spreadCap = bpsScaled(policy.policy.maxSpreadBps);
        const feeBps = bpsScaled(policy.policy.assumedFeeBpsPerSide);
        const slippageBps = bpsScaled(policy.policy.assumedSlippageBpsPerSide);
        if (spreadCap === null || feeBps === null || slippageBps === null) {
          return { status: "deny", mode: "paper_only", reason: "risk_state_unavailable" };
        }
        if (2n * (ask - bid) * BPS_SCALE > spreadCap * (ask + bid)) {
          return { status: "deny", mode: "paper_only", reason: "market_spread_exceeded" };
        }
        const tick = units(reservation.market.priceIncrement!);
        const slippedAsk = ceilDiv(ask * (BPS_SCALE + slippageBps), BPS_SCALE);
        const executed = ceilDiv(slippedAsk, tick) * tick;
        if (executed > units(reservation.conservativeEntryQuote)) {
          return { status: "deny", mode: "paper_only", reason: "price_beyond_reserve_cap" };
        }
        const stop = units(reservation.stopPriceQuote);
        if (stop >= executed) {
          return { status: "deny", mode: "paper_only", reason: "invalid_stop_for_fill" };
        }
        const quantity = units(reservation.quantityBase);
        const notional = ceilDiv(quantity * executed, SCALE);
        const fee = ceilDiv(notional * feeBps, BPS_SCALE);
        if (notional + fee > units(reservation.heldQuote)) {
          return { status: "deny", mode: "paper_only", reason: "held_quote_exceeded" };
        }
        const filledAtMs = Math.max(now, lastAt);
        if (filledAtMs >= Date.parse(open.expiresAt)) {
          await releaseTradingPaperReservationsInTransaction(
            tx,
            owner,
            ledgerId,
            "expired",
            policy.revision,
            now,
            caller,
          );
          return { status: "deny", mode: "paper_only", reason: "reservation_expired" };
        }
        const filledAt = new Date(filledAtMs).toISOString();
        const fillEventId = `paper-fill:${randomUUID()}`;
        const fillEventSequence = recovered.state.nextSequence;
        const executedPriceQuote = decimal(executed);
        const feeQuote = decimal(fee);
        const appended = await appendTradingPaperLedgerEventInTransaction(tx, owner, {
          ledgerId,
          eventId: fillEventId,
          sequence: fillEventSequence,
          kind: "fill_buy",
          recordedAt: filledAt,
          reservationId,
          quantityBase: reservation.quantityBase,
          executedPriceQuote,
          feeQuote,
        }, caller);
        if (appended.status !== "appended") {
          throw new PaperFillIntegrityError("Fresh synthetic fill unexpectedly duplicated");
        }
        await recordTradingPaperStopGuardForOpenPositionInTransaction(
          tx,
          owner,
          ledgerId,
          reservationId,
          reservation.stopPriceQuote,
        );
        const requestSha256 = requestDigest(owner, ledgerId, reservationId, evidenceId);
        const normalized: FillDigestInput = {
          ledgerId,
          reservationId,
          requestSha256,
          evidenceId,
          policyApprovalEffectId: approval.effectId,
          policyRevision: policy.revision,
          reserveEventSequence: reservation.reserveEventSequence,
          fillEventSequence,
          fillEventId,
          quantityBase: reservation.quantityBase,
          executedPriceQuote,
          feeQuote,
          stopPriceQuote: reservation.stopPriceQuote,
          filledAt,
        };
        await tx.tradingPaperFillDecision.create({
          data: {
            ...normalized,
            filledAt: new Date(filledAt),
            decisionSha256: decisionDigest(normalized),
          },
        });
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date());
        return {
          status: "filled",
          mode: "paper_only",
          reservationId,
          signalId: reservation.signalId,
          fillEventId,
          fillEventSequence,
          policyRevision: policy.revision,
          quantityBase: reservation.quantityBase,
          executedPriceQuote,
          feeQuote,
          stopPriceQuote: reservation.stopPriceQuote,
          filledAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  return withTransactionRetry(operation);
}
