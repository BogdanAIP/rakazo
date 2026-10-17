import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  readTradingPaperWorkerWakePreflight,
  readVerifiedTradingPaperEntrySession,
} from "@rakazo/db";

export type PaperWorkerPreflightJobResult =
  | { status: "ready"; gateRevision: number; cadenceMinutes: number }
  | { status: "deny"; reason: string }
  | { status: "stale_gate_revision" };

type ReadPreflight = typeof readTradingPaperWorkerWakePreflight;

/** Read-only background handler primitive. No JobPublisher, recurrence,
 * market-data adapter, model runtime or trading writer is available here. */
export async function handlePaperWorkerPreflight(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  readPreflight: ReadPreflight = readTradingPaperWorkerWakePreflight,
): Promise<PaperWorkerPreflightJobResult> {
  const preflight = await readPreflight(
    prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    payload.ledgerId,
    new Date(),
  );
  if (preflight.status !== "ready") {
    return { status: "deny", reason: preflight.reason };
  }
  if (preflight.gateRevision !== payload.gateRevision) {
    return { status: "stale_gate_revision" };
  }

  if (payload.sessionRevision !== undefined) {
    const session = await readVerifiedTradingPaperEntrySession(
      prisma,
      { spaceId: payload.spaceId, userId: payload.userId },
      payload.ledgerId,
    );
    if (
      session.status !== "active" ||
      session.revision !== payload.sessionRevision ||
      session.workerGateRevision !== payload.gateRevision
    ) {
      return { status: "deny", reason: "entry_session_inactive" };
    }
  }
  return {
    status: "ready",
    gateRevision: preflight.gateRevision,
    cadenceMinutes: preflight.cadenceMinutes,
  };
}
