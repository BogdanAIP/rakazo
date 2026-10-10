import { createHash } from "node:crypto";
import type { TradingPaperLedgerEvent } from "@rakazo/contracts";
import { deriveTradingPaperRiskState } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyHistoricalTradingPaperProtectiveExitApprovalInTransaction } from "./trading-paper-protective-exit-authority.js";
import { verifyHistoricalTradingPaperResolvedResearchFillApprovalInTransaction } from "./trading-paper-resolved-research-fill-gate.js";
import { verifyHistoricalTradingPaperResolvedResearchReserveApprovalInTransaction } from "./trading-paper-resolved-research-gate.js";
import { verifyTradingPaperSessionReservationsInTransaction } from "./trading-paper-session-reservation.js";
import { verifyTradingPaperStopGuardsInTransaction } from "./trading-paper-stop-guard.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { verifyHistoricalTradingPaperWorkerFillApprovalInTransaction } from "./trading-paper-worker-fill-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
const SCALE = 100_000_000n;
type Reserve = Extract<TradingPaperLedgerEvent, { kind: "reserve" }>;
type Buy = Extract<TradingPaperLedgerEvent, { kind: "fill_buy" }>;
type Sell = Extract<TradingPaperLedgerEvent, { kind: "fill_sell" }>;

export class PaperLifecycleAuditError extends Error {
  constructor(message = "Synthetic paper lifecycle audit failed; no repairs performed") {
    super(message);
    this.name = "PaperLifecycleAuditError";
  }
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function units(value: string): bigint {
  const negative = value.startsWith("-");
  const raw = negative ? value.slice(1) : value;
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(raw)) {
    throw new PaperLifecycleAuditError("Unrepresentable exact lifecycle amount");
  }
  const [whole, fraction = ""] = raw.split(".");
  const amount = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
  return negative ? -amount : amount;
}
function decimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const n = value < 0n ? -value : value;
  const fraction = (n % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${n / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new PaperLifecycleAuditError(reason);
}

/**
 * Strict B7+ lifecycle audit, NOT a general P9 legacy-journal migration.
 * A directly appended P9 event without the corresponding durable B7/C1/C2
 * provenance fails closed. Reads only: no healing, execution or clock trigger.
 */
export async function auditTradingPaperLifecycleInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  now: Date,
) {
  assert(Number.isFinite(now.getTime()), "Invalid audit clock");
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const { row, events, state } = recovered;
  await verifyTradingPaperSessionReservationsInTransaction(tx, owner, ledgerId);
  const [reservations, fills, releases, closes, outbox, stopRows] = await Promise.all([
    tx.tradingPaperReservationDecision.findMany({ where: { ledgerId } }),
    tx.tradingPaperFillDecision.findMany({ where: { ledgerId } }),
    tx.tradingPaperReleaseAudit.findMany({ where: { ledgerId } }),
    tx.tradingPaperCloseDecision.findMany({ where: { ledgerId } }),
    tx.tradingPaperLedgerOutbox.findMany({ where: { ledgerId } }),
    tx.tradingPaperStopGuard.findMany({ where: { ledgerId } }),
  ]);
  const reserves = events.filter((event): event is Reserve => event.kind === "reserve");
  const buys = events.filter((event): event is Buy => event.kind === "fill_buy");
  const sells = events.filter((event): event is Sell => event.kind === "fill_sell");
  const releaseEvents = events.filter((event) => event.kind === "release");
  assert(
    reservations.length === reserves.length &&
      fills.length === buys.length &&
      closes.length === sells.length &&
      releases.length === releaseEvents.length &&
      outbox.length === events.length,
    "Managed journal and lifecycle decision/outbox cardinality mismatch",
  );
  const byRes = new Map(reservations.map((entry) => [entry.reservationId, entry] as const));
  const byFill = new Map(fills.map((entry) => [entry.reservationId, entry] as const));
  const byRelease = new Map(releases.map((entry) => [entry.reservationId, entry] as const));
  const byClose = new Map(closes.map((entry) => [entry.positionId, entry] as const));
  const reserveEvents = new Map(reserves.map((event) => [event.reservationId, event] as const));
  const buyEvents = new Map(buys.map((event) => [event.reservationId, event] as const));
  const outboxSequences = new Set(outbox.map((entry) => entry.sequence));
  assert(
    outboxSequences.size === outbox.length &&
      events.every((event) => outboxSequences.has(event.sequence)) &&
      outbox.every((entry) => entry.status === "pending"),
    "Lifecycle inert outbox missing, duplicated or unexpectedly dispatched",
  );

  // Check original one-time owner approval for every synthetic reserve/fill/close.
  const approvalIds = [
    ...new Set([
      ...reservations.map((entry) => entry.policyApprovalEffectId),
      ...fills.map((entry) => entry.policyApprovalEffectId),
      ...closes.map((entry) => entry.policyApprovalEffectId),
    ]),
  ];
  const approvals = await tx.tradingPaperPolicyAudit.findMany({
    where: { ledgerId, effectId: { in: approvalIds } },
  });
  const byApproval = new Map(approvals.map((entry) => [entry.effectId, entry] as const));
  function approved(effectId: string, revision: number) {
    const entry = byApproval.get(effectId);
    assert(
      entry &&
        entry.ledgerId === ledgerId &&
        entry.spaceId === owner.spaceId &&
        entry.userId === owner.userId &&
        entry.action === "enable" &&
        entry.toRevision === revision,
      "Missing or mismatched historical owner-enable approval",
    );
  }
  async function approvedReserve(record: (typeof reservations)[number], reserve: Reserve) {
    const enable = byApproval.get(record.policyApprovalEffectId);
    if (enable) {
      approved(record.policyApprovalEffectId, record.policyRevision);
      return;
    }
    const resolved = await verifyHistoricalTradingPaperResolvedResearchReserveApprovalInTransaction(
      tx,
      owner,
      record.policyApprovalEffectId,
      {
        ledgerId: record.ledgerId,
        reservationId: record.reservationId,
        signalId: reserve.signalId,
        policyRevision: record.policyRevision,
        evidenceId: record.evidenceId,
        reserveEventSequence: record.eventSequence,
        actedAt: reserve.recordedAt,
      },
    );
    assert(resolved, "Missing or mismatched historical resolved-research reserve approval");
  }

  async function approvedFill(
    record: (typeof fills)[number],
    decision: (typeof reservations)[number],
    reserve: Reserve,
  ) {
    if (record.policyApprovalEffectId === decision.policyApprovalEffectId) {
      approved(record.policyApprovalEffectId, record.policyRevision);
      return;
    }
    const worker = await verifyHistoricalTradingPaperWorkerFillApprovalInTransaction(
      tx,
      owner,
      record.policyApprovalEffectId,
      {
        ledgerId: record.ledgerId,
        reservationId: record.reservationId,
        signalId: reserve.signalId,
        policyRevision: record.policyRevision,
        evidenceId: record.evidenceId,
        reserveEventSequence: record.reserveEventSequence,
        fillEventSequence: record.fillEventSequence,
        actedAt: record.filledAt.toISOString(),
      },
    );
    if (worker) return;
    const resolved = await verifyHistoricalTradingPaperResolvedResearchFillApprovalInTransaction(
      tx,
      owner,
      record.policyApprovalEffectId,
      {
        ledgerId: record.ledgerId,
        reservationId: record.reservationId,
        signalId: reserve.signalId,
        policyRevision: record.policyRevision,
        reserveEvidenceId: decision.evidenceId,
        evidenceId: record.evidenceId,
        reserveEventSequence: record.reserveEventSequence,
        fillEventSequence: record.fillEventSequence,
        actedAt: record.filledAt.toISOString(),
        market: reserve.market,
      },
    );
    assert(resolved, "Missing or mismatched historical automatic-fill approval");
  }

  async function approvedClose(record: (typeof closes)[number]) {
    const enable = byApproval.get(record.policyApprovalEffectId);
    if (enable) {
      approved(record.policyApprovalEffectId, record.policyRevision);
      return;
    }
    const protective = await verifyHistoricalTradingPaperProtectiveExitApprovalInTransaction(
      tx,
      owner,
      record.policyApprovalEffectId,
      {
        ledgerId: record.ledgerId,
        positionId: record.positionId,
        policyRevision: record.policyRevision,
        buyFillEventSequence: record.buyFillEventSequence,
        stopPriceQuote: record.stopPriceQuote,
        actedAt: record.closedAt.toISOString(),
      },
    );
    assert(protective, "Missing or mismatched historical protective-exit approval");
  }

  for (const event of reserves) {
    const decision = byRes.get(event.reservationId);
    assert(
      decision &&
        decision.ledgerId === ledgerId &&
        decision.signalId === event.signalId &&
        decision.eventId === event.eventId &&
        decision.eventSequence === event.sequence &&
        decision.ledgerRevisionBefore === event.sequence - 1 &&
        decision.quantityBase === event.quantityBase &&
        decision.heldQuote === event.maxSpendQuote &&
        decision.expiresAt.toISOString() === event.expiresAt,
      "Reserve event missing its matching decision",
    );
    assert(
      decision.decisionSha256 ===
        hash([
          decision.ledgerId,
          decision.signalId,
          decision.requestSha256,
          decision.evidenceId,
          decision.policyApprovalEffectId,
          decision.policyRevision,
          decision.ledgerRevisionBefore,
          decision.eventSequence,
          decision.eventId,
          decision.reservationId,
          decision.quantityBase,
          decision.heldQuote,
          decision.worstCaseStopRiskQuote,
          decision.stopPriceQuote,
          decision.conservativeEntryQuote,
          decision.conservativeStopQuote,
          decision.expiresAt.toISOString(),
        ]),
      "Reserve decision digest mismatch",
    );
    await approvedReserve(decision, event);
  }

  const costs = new Map<string, bigint>();
  for (const event of buys) {
    const record = byFill.get(event.reservationId);
    const reserve = reserveEvents.get(event.reservationId);
    const decision = byRes.get(event.reservationId);
    assert(record && reserve && decision, "Buy lacks B7 provenance");
    assert(
      record.ledgerId === ledgerId &&
        record.reserveEventSequence === reserve.sequence &&
        record.fillEventId === event.eventId &&
        record.fillEventSequence === event.sequence &&
        record.quantityBase === event.quantityBase &&
        record.quantityBase === reserve.quantityBase &&
        record.executedPriceQuote === event.executedPriceQuote &&
        record.feeQuote === event.feeQuote &&
        record.filledAt.toISOString() === event.recordedAt &&
        record.stopPriceQuote === decision.stopPriceQuote &&
        record.policyRevision === decision.policyRevision,
      "Buy event missing its matching fill decision",
    );
    assert(
      record.decisionSha256 ===
        hash([
          record.ledgerId,
          record.reservationId,
          record.requestSha256,
          record.evidenceId,
          record.policyApprovalEffectId,
          record.policyRevision,
          record.reserveEventSequence,
          record.fillEventSequence,
          record.fillEventId,
          record.quantityBase,
          record.executedPriceQuote,
          record.feeQuote,
          record.stopPriceQuote,
          record.filledAt.toISOString(),
        ]),
      "Fill decision digest mismatch",
    );
    await approvedFill(record, decision, reserve);
    costs.set(
      event.reservationId,
      (units(event.quantityBase) * units(event.executedPriceQuote) + SCALE - 1n) / SCALE +
        units(event.feeQuote),
    );
  }

  for (const event of releaseEvents) {
    if (event.kind !== "release") continue;
    const record = byRelease.get(event.reservationId);
    const reserve = reserveEvents.get(event.reservationId);
    assert(record && reserve, "Release lacks B7 provenance");
    assert(
      record.ledgerId === ledgerId &&
        record.eventSequence === event.sequence &&
        record.eventId === event.eventId &&
        record.releasedAt.toISOString() === event.recordedAt &&
        record.releasedQuote === reserve.maxSpendQuote &&
        (record.reason === "expired" ||
          record.reason === "kill_switch" ||
          record.reason === "session_end") &&
        !byFill.has(event.reservationId) &&
        !byClose.has(event.reservationId),
      "Release audit disagrees with terminal reservation state",
    );
    assert(
      record.releaseSha256 ===
        hash([
          record.ledgerId,
          record.reservationId,
          record.eventSequence,
          record.eventId,
          record.reason,
          record.policyRevision,
          record.releasedQuote,
          record.releasedAt.toISOString(),
        ]),
      "Release audit digest mismatch",
    );
  }
  for (const event of reserves) {
    const id = event.reservationId;
    assert(
      Number(byFill.has(id)) +
        Number(byRelease.has(id)) +
        Number(state.reservations.some((r) => r.reservationId === id)) ===
        1,
      "Reserve has zero or multiple terminal/current states",
    );
  }

  let realized = 0n;
  for (const event of sells) {
    const record = byClose.get(event.positionId);
    const buy = buyEvents.get(event.positionId);
    const fill = byFill.get(event.positionId);
    const cost = costs.get(event.positionId);
    assert(record && buy && fill && cost !== undefined, "Sell lacks C1 buy provenance");
    assert(
      record.ledgerId === ledgerId &&
        record.buyFillEventSequence === buy.sequence &&
        record.closeEventId === event.eventId &&
        record.closeEventSequence === event.sequence &&
        record.quantityBase === event.quantityBase &&
        record.quantityBase === buy.quantityBase &&
        record.executedPriceQuote === event.executedPriceQuote &&
        record.feeQuote === event.feeQuote &&
        record.closedAt.toISOString() === event.recordedAt &&
        record.stopPriceQuote === fill.stopPriceQuote,
      "Sell event missing its matching close decision",
    );
    assert(
      record.decisionSha256 ===
        hash([
          record.ledgerId,
          record.positionId,
          record.requestSha256,
          record.evidenceId,
          record.policyApprovalEffectId,
          record.policyRevision,
          record.buyFillEventSequence,
          record.closeEventSequence,
          record.closeEventId,
          record.quantityBase,
          record.executedPriceQuote,
          record.feeQuote,
          record.stopPriceQuote,
          record.closedAt.toISOString(),
        ]),
      "Close decision digest mismatch",
    );
    await approvedClose(record);
    const received =
      (units(event.quantityBase) * units(event.executedPriceQuote)) / SCALE - units(event.feeQuote);
    realized += received - cost;
  }
  assert(
    decimal(realized) === state.realizedPnlQuote,
    "Independent realized PnL reconciliation failed",
  );
  for (const event of buys) {
    assert(
      Number(byClose.has(event.reservationId)) +
        Number(state.positions.some((position) => position.positionId === event.reservationId)) ===
        1,
      "Buy has zero or multiple close/current states",
    );
  }

  assert(stopRows.length === state.positions.length, "Stop-guard cardinality mismatch");
  const guards = await verifyTradingPaperStopGuardsInTransaction(tx, ledgerId, events, state);
  assert(guards && guards.length === state.positions.length, "Missing verified open stop guard");
  for (const guard of guards) {
    const fill = byFill.get(guard.positionId);
    assert(
      fill && guard.stopPriceQuote === fill.stopPriceQuote,
      "Open guard differs from fill decision",
    );
  }
  const risk = deriveTradingPaperRiskState(
    {
      version: "paper_spot_full_fill_v1",
      ledgerId,
      openedAt: row.openedAt.toISOString(),
      quoteCurrency: row.quoteCurrency,
      initialBalanceQuote: row.initialBalanceQuote,
      events,
    },
    now,
  );
  assert(risk.ledgerVersion === row.version, "Daily risk replay revision mismatch");
  return {
    mode: "paper_only" as const,
    status: "verified" as const,
    ledgerId,
    version: row.version,
    acceptedEvents: events.length,
    reservationDecisions: reservations.length,
    fillDecisions: fills.length,
    releaseAudits: releases.length,
    closeDecisions: closes.length,
    openPositions: state.positions.length,
    openReservations: state.reservations.length,
    realizedPnlQuote: decimal(realized),
    dayStartUtc: risk.dayStartUtc,
    realizedPnlTodayQuote: risk.realizedPnlTodayQuote,
    realizedLossTodayQuote: risk.realizedLossTodayQuote,
  };
}

/** Read-only strict lifecycle report suitable for post-restart verification.
 * All out-of-band legacy P9 events fail strict B7+ provenance checks. */
export async function auditTradingPaperLifecycle(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
) {
  return withTransactionRetry(() =>
    prisma.$transaction((tx) => auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, now), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }),
  );
}
