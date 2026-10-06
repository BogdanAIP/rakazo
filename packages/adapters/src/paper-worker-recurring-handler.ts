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

/** D2 -> durable D11/D12 successor composition. P11D-13 registers this
 * handler, but every wake remains fail-closed behind the worker and recurrence
 * approval chains. */
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
