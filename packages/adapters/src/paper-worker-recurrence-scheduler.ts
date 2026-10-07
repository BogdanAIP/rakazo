import {
  type BackgroundJobPayloads,
  type JobPublisher,
  paperWorkerPreflightJob,
} from "@rakazo/adapter-kit";
import type { PrismaClient, TradingPaperWorkerSuccessorIntentResult } from "@rakazo/db";
import { prepareTradingPaperWorkerSuccessorIntent } from "@rakazo/db";

type PrepareSuccessorIntent = typeof prepareTradingPaperWorkerSuccessorIntent;
type SuccessorIntentStop = Extract<TradingPaperWorkerSuccessorIntentResult, { status: "stop" }>;

export type AuthorizedPaperWorkerSuccessorScheduleResult =
  | {
      status: "enqueued";
      ledgerId: string;
      gateRevision: number;
      scheduledFor: string;
    }
  | {
      status: "stop";
      ledgerId: string;
      reason: SuccessorIntentStop["reason"];
      recurrenceReason?: string;
      currentGateRevision?: number;
    };

/** Internal durable-intent -> queue primitive. D11 persists and verifies the
 * exact successor schedule before any queue side effect. No production caller
 * is registered in P11D-12. */
export async function enqueueAuthorizedPaperWorkerSuccessor(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  prepareIntent: PrepareSuccessorIntent = prepareTradingPaperWorkerSuccessorIntent,
): Promise<AuthorizedPaperWorkerSuccessorScheduleResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid authorized paper worker successor clock");
  }

  const intent = await prepareIntent(
    deps.prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    {
      ledgerId: payload.ledgerId,
      sourceScheduledFor: payload.scheduledFor,
      gateRevision: payload.gateRevision,
      now,
    },
  );
  if (intent.status === "stop") {
    return {
      status: "stop",
      ledgerId: intent.ledgerId,
      reason: intent.reason,
      ...(intent.recurrenceReason ? { recurrenceReason: intent.recurrenceReason } : {}),
      ...(intent.currentGateRevision !== undefined
        ? { currentGateRevision: intent.currentGateRevision }
        : {}),
    };
  }

  const scheduledFor = new Date(intent.successorScheduledFor);
  if (!Number.isFinite(scheduledFor.getTime())) {
    throw new Error("Invalid persisted paper worker successor schedule");
  }

  await deps.jobs.enqueue(
    paperWorkerPreflightJob({
      ledgerId: intent.ledgerId,
      spaceId: payload.spaceId,
      userId: payload.userId,
      gateRevision: intent.gateRevision,
      scheduledFor,
    }),
  );
  return {
    status: "enqueued",
    ledgerId: intent.ledgerId,
    gateRevision: intent.gateRevision,
    scheduledFor: intent.successorScheduledFor,
  };
}
