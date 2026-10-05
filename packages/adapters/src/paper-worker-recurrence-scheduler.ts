import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { readTradingPaperWorkerRecurrencePreflight } from "@rakazo/db";
import {
  type AuthorizedPaperWorkerSuccessorPlan,
  planAuthorizedPaperWorkerPreflightSuccessor,
} from "./paper-worker-authorized-recurrence.js";

type ReadRecurrence = typeof readTradingPaperWorkerRecurrencePreflight;
type PlanSuccessor = typeof planAuthorizedPaperWorkerPreflightSuccessor;

export type AuthorizedPaperWorkerSuccessorScheduleResult =
  | {
      status: "enqueued";
      ledgerId: string;
      gateRevision: number;
      scheduledFor: string;
    }
  | Extract<AuthorizedPaperWorkerSuccessorPlan, { status: "stop" }>;

/** Internal D7 -> D8 -> queue primitive. No production caller exists in D9. */
export async function enqueueAuthorizedPaperWorkerSuccessor(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  readRecurrence: ReadRecurrence = readTradingPaperWorkerRecurrencePreflight,
  planSuccessor: PlanSuccessor = planAuthorizedPaperWorkerPreflightSuccessor,
): Promise<AuthorizedPaperWorkerSuccessorScheduleResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid authorized paper worker successor clock");
  }
  const recurrence = await readRecurrence(
    deps.prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    payload.ledgerId,
    now,
  );
  const plan = planSuccessor(payload, recurrence, now);
  if (plan.status !== "planned") return plan;

  await deps.jobs.enqueue(plan.job);
  return {
    status: "enqueued",
    ledgerId: plan.ledgerId,
    gateRevision: plan.gateRevision,
    scheduledFor: plan.scheduledFor,
  };
}
