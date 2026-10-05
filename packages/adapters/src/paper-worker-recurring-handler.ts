import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  handlePaperWorkerPreflight,
  type PaperWorkerPreflightJobResult,
} from "./paper-worker-background.js";
import {
  type AuthorizedPaperWorkerSuccessorScheduleResult,
  enqueueAuthorizedPaperWorkerSuccessor,
} from "./paper-worker-recurrence-scheduler.js";

type HandlePreflight = typeof handlePaperWorkerPreflight;
type EnqueueSuccessor = typeof enqueueAuthorizedPaperWorkerSuccessor;

export type PaperWorkerRecurringHandlerResult =
  | {
      status: "stop";
      preflight: Exclude<PaperWorkerPreflightJobResult, { status: "ready" }>;
    }
  | {
      status: "ready";
      preflight: Extract<PaperWorkerPreflightJobResult, { status: "ready" }>;
      successor: AuthorizedPaperWorkerSuccessorScheduleResult;
    };

/** D2 -> D9 composition only. This function is deliberately not registered
 * in the production background handler map in P11D-10. */
export async function handlePaperWorkerPreflightWithSuccessor(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  handlePreflight: HandlePreflight = handlePaperWorkerPreflight,
  enqueueSuccessor: EnqueueSuccessor = enqueueAuthorizedPaperWorkerSuccessor,
): Promise<PaperWorkerRecurringHandlerResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid recurring paper worker handler clock");
  }
  const preflight = await handlePreflight(deps.prisma, payload);
  if (preflight.status !== "ready") {
    return { status: "stop", preflight };
  }
  const successor = await enqueueSuccessor(deps, payload, now);
  return { status: "ready", preflight, successor };
}
