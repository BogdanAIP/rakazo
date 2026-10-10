import { type JobPublisher, paperWorkerPreflightJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  readTradingPaperWorkerWakePreflight,
  readVerifiedTradingPaperEntrySession,
} from "@rakazo/db";

type ReadPreflight = typeof readTradingPaperWorkerWakePreflight;

export type PaperWorkerOneShotScheduleResult =
  | { status: "enqueued"; ledgerId: string; gateRevision: number; scheduledFor: string }
  | { status: "deny"; ledgerId: string; reason: string }
  | {
      status: "stale_gate_revision";
      ledgerId: string;
      expectedGateRevision: number;
      currentGateRevision: number;
    };

/** Internal one-shot queue primitive for the read-only PAPER preflight.
 * There is deliberately no production caller or recurrence wiring in P11D-3. */
export async function enqueuePaperWorkerPreflightOnce(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  input: {
    spaceId: string;
    userId: string;
    ledgerId: string;
    expectedGateRevision: number;
    expectedSessionRevision?: number;
    now?: Date;
  },
  readPreflight: ReadPreflight = readTradingPaperWorkerWakePreflight,
): Promise<PaperWorkerOneShotScheduleResult> {
  if (!Number.isSafeInteger(input.expectedGateRevision) || input.expectedGateRevision < 0) {
    throw new Error("Invalid expected paper worker gate revision");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid paper worker scheduling clock");

  const preflight = await readPreflight(
    deps.prisma,
    { spaceId: input.spaceId, userId: input.userId },
    input.ledgerId,
    now,
  );
  if (preflight.status !== "ready") {
    return { status: "deny", ledgerId: input.ledgerId, reason: preflight.reason };
  }
  if (preflight.gateRevision !== input.expectedGateRevision) {
    return {
      status: "stale_gate_revision",
      ledgerId: input.ledgerId,
      expectedGateRevision: input.expectedGateRevision,
      currentGateRevision: preflight.gateRevision,
    };
  }

  const scheduledFor = new Date(now.getTime() + preflight.cadenceMinutes * 60_000);
  if (input.expectedSessionRevision !== undefined) {
    const session = await readVerifiedTradingPaperEntrySession(
      deps.prisma,
      { spaceId: input.spaceId, userId: input.userId },
      input.ledgerId,
    );
    if (
      session.status !== "active" ||
      session.revision !== input.expectedSessionRevision ||
      session.workerGateRevision !== input.expectedGateRevision ||
      scheduledFor.getTime() >= Date.parse(session.expiresAt)
    ) {
      return { status: "deny", ledgerId: input.ledgerId, reason: "entry_session_inactive" };
    }
  }
  await deps.jobs.enqueue(
    paperWorkerPreflightJob({
      ledgerId: input.ledgerId,
      spaceId: input.spaceId,
      userId: input.userId,
      gateRevision: preflight.gateRevision,
      ...(input.expectedSessionRevision ? { sessionRevision: input.expectedSessionRevision } : {}),
      scheduledFor,
    }),
  );
  return {
    status: "enqueued",
    ledgerId: input.ledgerId,
    gateRevision: preflight.gateRevision,
    scheduledFor: scheduledFor.toISOString(),
  };
}
