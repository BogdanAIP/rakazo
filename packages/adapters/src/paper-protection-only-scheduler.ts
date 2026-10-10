import {
  type BackgroundJobPayloads,
  type JobPublisher,
  paperProtectionCheckJob,
} from "@rakazo/adapter-kit";
import type { PaperProtectionSuccessorIntentResult, PrismaClient } from "@rakazo/db";
import { prepareTradingPaperProtectionSuccessorIntent } from "@rakazo/db";

type Prepare = typeof prepareTradingPaperProtectionSuccessorIntent;

export type PaperProtectionSuccessorScheduleResult =
  | {
      status: "enqueued";
      ledgerId: string;
      leaseRevision: number;
      scheduledFor: string;
    }
  | {
      status: "stop";
      ledgerId: string;
      reason: Extract<PaperProtectionSuccessorIntentResult, { status: "stop" }>["reason"];
    };

/**
 * H2b2 independent protection-only successor: persist a DB-verified intent
 * BEFORE publishing any job. Retry/replay is deterministic, the replaceKey
 * is distinct from the entry worker, and expiry/no positions stops recurrence.
 * No trading research, purchase, reserve or new-entry operations here.
 */
export async function enqueueAuthorizedPaperProtectionSuccessor(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["paper.protection-check"],
  prepare: Prepare = prepareTradingPaperProtectionSuccessorIntent,
): Promise<PaperProtectionSuccessorScheduleResult> {
  const intent = await prepare(
    deps.prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    {
      ledgerId: payload.ledgerId,
      leaseRevision: payload.leaseRevision,
      gateRevision: payload.gateRevision,
      sourceScheduledFor: payload.scheduledFor,
    },
  );
  if (intent.status === "stop") {
    return { status: "stop", ledgerId: intent.ledgerId, reason: intent.reason };
  }
  const scheduledFor = new Date(intent.successorScheduledFor);
  if (!Number.isFinite(scheduledFor.getTime())) {
    throw new Error("Invalid persisted protection successor schedule");
  }
  await deps.jobs.enqueue(
    paperProtectionCheckJob({
      ledgerId: intent.ledgerId,
      spaceId: payload.spaceId,
      userId: payload.userId,
      gateRevision: intent.gateRevision,
      leaseRevision: intent.leaseRevision,
      scheduledFor,
    }),
  );
  return {
    status: "enqueued",
    ledgerId: intent.ledgerId,
    leaseRevision: intent.leaseRevision,
    scheduledFor: intent.successorScheduledFor,
  };
}
