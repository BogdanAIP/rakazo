import { createHash, randomUUID } from "node:crypto";
import type { TradingPaperLedgerState } from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import { verifyTradingPaperSessionSettlingAuthorityInTransaction } from "./trading-paper-entry-session.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { verifyTradingPaperSessionReservationsInTransaction } from "./trading-paper-session-reservation.js";
import {
  appendTradingPaperLedgerEventInTransaction,
  recoverTradingPaperLedgerInTransaction,
} from "./trading-paper-store.js";

type Owner = { spaceId: string; userId: string };
export type PaperReleaseReason = "expired" | "kill_switch" | "session_end";

function digest(value: {
  ledgerId: string;
  reservationId: string;
  eventSequence: number;
  eventId: string;
  reason: PaperReleaseReason;
  policyRevision: number;
  releasedQuote: string;
  releasedAt: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.reservationId,
        value.eventSequence,
        value.eventId,
        value.reason,
        value.policyRevision,
        value.releasedQuote,
        value.releasedAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

export class PaperReleaseIntegrityError extends Error {
  constructor(message = "Synthetic paper release reconciliation failed") {
    super(message);
    this.name = "PaperReleaseIntegrityError";
  }
}

/** INTERNAL ONLY. Releases virtual reservations and writes inert ledger/outbox
 * records. It never closes positions and has no exchange/broker capability. */
export async function releaseTradingPaperReservationsInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  reason: PaperReleaseReason,
  policyRevision: number,
  nowMs: number,
): Promise<{ released: number; state: TradingPaperLedgerState }> {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(policyRevision) || policyRevision < 0) {
    throw new PaperReleaseIntegrityError("Invalid trusted release clock or policy revision");
  }
  let sessionReservationIds: Set<string> | null = null;
  if (reason === "session_end") {
    const permitted = await verifyTradingPaperSessionSettlingAuthorityInTransaction(
      tx,
      owner,
      ledgerId,
    );
    const links = await verifyTradingPaperSessionReservationsInTransaction(tx, owner, ledgerId);
    sessionReservationIds = new Set(
      links
        .filter((row) => row.sessionStartedAt.toISOString() === permitted.sessionStartedAt)
        .map((row) => row.reservationId),
    );
    if (Math.abs(permitted.checkedAt.getTime() - nowMs) > 2_000) {
      throw new PaperReleaseIntegrityError("Normal session release requires the trusted DB clock");
    }
  }
  await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date(nowMs));
  const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const lastEvent = recovered.events.at(-1);
  const lastAt = lastEvent ? Date.parse(lastEvent.recordedAt) : recovered.row.openedAt.getTime();
  if (lastAt > nowMs + 2_000) {
    throw new PaperReleaseIntegrityError("Paper journal is future-dated relative to release clock");
  }
  const candidates = recovered.state.reservations
    .filter((reservation) =>
      reason === "session_end"
        ? sessionReservationIds!.has(reservation.reservationId)
        : reason === "kill_switch" || Date.parse(reservation.expiresAt) <= nowMs,
    )
    .sort((a, b) => a.reservationId.localeCompare(b.reservationId));
  let state = recovered.state;
  let released = 0;
  const releasedAt = new Date(Math.max(nowMs, lastAt)).toISOString();

  for (const reservation of candidates) {
    const eventId = `paper-release:${randomUUID()}`;
    const eventSequence = state.nextSequence;
    const appended = await appendTradingPaperLedgerEventInTransaction(tx, owner, {
      ledgerId,
      eventId,
      sequence: eventSequence,
      kind: "release",
      recordedAt: releasedAt,
      reservationId: reservation.reservationId,
    });
    if (appended.status !== "appended") {
      throw new PaperReleaseIntegrityError("Fresh reconciliation event unexpectedly duplicated");
    }
    const audit = {
      ledgerId,
      reservationId: reservation.reservationId,
      eventSequence,
      eventId,
      reason,
      policyRevision,
      releasedQuote: reservation.heldQuote,
      releasedAt,
    };
    await tx.tradingPaperReleaseAudit.create({
      data: {
        ...audit,
        releasedAt: new Date(releasedAt),
        releaseSha256: digest(audit),
      },
    });
    state = appended.state;
    released += 1;
  }
  await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, new Date(nowMs));
  return { released, state };
}
