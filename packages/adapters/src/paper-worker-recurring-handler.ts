import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  handlePaperWorkerPreflight,
  type PaperWorkerPreflightJobResult,
} from "./paper-worker-background.js";
import {
  observeConfiguredPaperWorkerSpotMarket,
  type PaperWorkerMarketObservationResult,
} from "./paper-worker-market-observation.js";
import {
  type AuthorizedPaperWorkerSuccessorScheduleResult,
  enqueueAuthorizedPaperWorkerSuccessor,
} from "./paper-worker-recurrence-scheduler.js";
import {
  type PaperWorkerResearchResult,
  researchObservedPaperWorkerMarket,
} from "./paper-worker-research.js";

type HandlePreflight = typeof handlePaperWorkerPreflight;
type EnqueueSuccessor = typeof enqueueAuthorizedPaperWorkerSuccessor;
type ObserveMarket = typeof observeConfiguredPaperWorkerSpotMarket;
type ResearchMarket = typeof researchObservedPaperWorkerMarket;
type ReadyPreflight = Extract<PaperWorkerPreflightJobResult, { status: "ready" }>;
type StoppedObservation = Extract<PaperWorkerMarketObservationResult, { status: "stop" }>;
type CompletedObservation = Extract<PaperWorkerMarketObservationResult, { status: "observed" }>;

export type PaperWorkerRecurringHandlerResult =
  | {
      status: "stop";
      stage: "preflight";
      preflight: Exclude<PaperWorkerPreflightJobResult, { status: "ready" }>;
    }
  | {
      status: "stop";
      stage: "observation";
      preflight: ReadyPreflight;
      observation: StoppedObservation;
    }
  | {
      status: "ready";
      preflight: ReadyPreflight;
      observation: CompletedObservation;
      research: PaperWorkerResearchResult;
      successor: AuthorizedPaperWorkerSuccessorScheduleResult;
    };

/** P11E-5 production PAPER wake composition. D2 revalidates the worker gate,
 * E1/E3 persist at most one approved public quote, E5 replays or derives a
 * research-only result, then D11/D12 may schedule the successor. BingX remains
 * observation-only until its own closed-history adapter exists. No model
 * runtime, private exchange API, paper reservation/fill or live order exists. */
export async function handlePaperWorkerPreflightWithSuccessor(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  handlePreflight: HandlePreflight = handlePaperWorkerPreflight,
  enqueueSuccessor: EnqueueSuccessor = enqueueAuthorizedPaperWorkerSuccessor,
  observeMarket: ObserveMarket = observeConfiguredPaperWorkerSpotMarket,
  researchMarket: ResearchMarket = researchObservedPaperWorkerMarket,
): Promise<PaperWorkerRecurringHandlerResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid recurring paper worker handler clock");
  }
  const preflight = await handlePreflight(deps.prisma, payload);
  if (preflight.status !== "ready") {
    return { status: "stop", stage: "preflight", preflight };
  }

  const observation = await observeMarket(deps.prisma, payload, now);
  if (observation.status !== "observed") {
    return { status: "stop", stage: "observation", preflight, observation };
  }

  const research = await researchMarket(deps.prisma, payload, observation, now);
  const successor = await enqueueSuccessor(deps, payload, now);
  return { status: "ready", preflight, observation, research, successor };
}
