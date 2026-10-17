import { createHash } from "node:crypto";
import type { Prisma } from "./client.js";
import { PaperLedgerIntegrityError } from "./trading-paper-store.js";

type Owner = { spaceId: string; userId: string };
type Link = {
  ledgerId: string;
  reservationId: string;
  sessionRevision: number;
  sessionStartedAt: Date;
  approvalEffectId: string;
};
function digest(row: Link): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.ledgerId,
        row.reservationId,
        row.sessionRevision,
        row.sessionStartedAt.toISOString(),
        row.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

/** Only called by the reserve writer in the same serializable transaction.
 * Manual holds and historical reservations are never attributed retroactively. */
export async function recordTradingPaperSessionReservationInTransaction(
  tx: Prisma.TransactionClient,
  row: Link,
): Promise<void> {
  await tx.tradingPaperSessionReservation.create({
    data: { ...row, attributionSha256: digest(row) },
  });
}

/** Immutable Start-effect and reserve-event provenance, independent of the
 * mutable current session. Also used by the full lifecycle audit. */
export async function verifyTradingPaperSessionReservationsInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<Link[]> {
  const owned = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { id: true },
  });
  if (!owned) throw new PaperLedgerIntegrityError("Session reservation owner mismatch");
  const rows = await tx.tradingPaperSessionReservation.findMany({ where: { ledgerId } });
  for (const row of rows) {
    if (row.sessionRevision < 1 || row.attributionSha256 !== digest(row)) {
      throw new PaperLedgerIntegrityError("Session reservation attribution digest mismatch");
    }
    const effect = await tx.externalEffect.findUnique({
      where: { id: row.approvalEffectId },
      include: { run: { select: { spaceId: true, userId: true } } },
    });
    const request = effect?.request as Record<string, unknown> | null;
    const result = effect?.result as Record<string, unknown> | null;
    const decision = await tx.tradingPaperReservationDecision.findUnique({
      where: { ledgerId_reservationId: { ledgerId, reservationId: row.reservationId } },
    });
    const event =
      decision &&
      (await tx.tradingPaperLedgerEvent.findUnique({
        where: { ledgerId_sequence: { ledgerId, sequence: decision.eventSequence } },
      }));
    if (
      effect?.status !== "completed" ||
      effect.kind !== "paper_session_control" ||
      effect.spaceId !== owner.spaceId ||
      effect.run.spaceId !== owner.spaceId ||
      effect.run.userId !== owner.userId ||
      request?.action !== "start" ||
      request.ledger_id !== ledgerId ||
      request.expected_revision !== row.sessionRevision - 1 ||
      result?.ok !== true ||
      result.mode !== "paper_only" ||
      result.status !== "active" ||
      result.revision !== row.sessionRevision ||
      result.ledgerId !== ledgerId ||
      !Number.isSafeInteger(request.duration_minutes) ||
      !decision ||
      event?.kind !== "reserve" ||
      event.recordedAt < row.sessionStartedAt ||
      event.recordedAt.getTime() >=
        row.sessionStartedAt.getTime() + (request.duration_minutes as number) * 60_000 ||
      result.expiresAt !==
        new Date(
          row.sessionStartedAt.getTime() + (request.duration_minutes as number) * 60_000,
        ).toISOString()
    ) {
      throw new PaperLedgerIntegrityError("Session reservation approval provenance mismatch");
    }
  }
  return rows;
}
