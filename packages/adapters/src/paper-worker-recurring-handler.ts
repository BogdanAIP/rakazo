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
import {
  type PaperWorkerSignalReservationResult,
  reservePersistedPaperWorkerProposal,
} from "./paper-worker-signal-reservation.js";

type HandlePreflight = typeof handlePaperWorkerPreflight;
type EnqueueSuccessor = typeof enqueueAuthorizedPaperWorkerSuccessor;
type ObserveMarket = typeof observeConfiguredPaperWorkerSpotMarket;
type ResearchMarket = typeof researchObservedPaperWorkerMarket;
type ReserveSignal = typeof reservePersistedPaperWorkerProposal;
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
      signal: PaperWorkerSignalReservationResult;
      successor: AuthorizedPaperWorkerSuccessorScheduleResult;
    };

/** P11F-1 production PAPER wake composition. D2 revalidates the worker gate,
 * E1/E3 persist one approved public quote, E5/E6 replay or derive the durable
 * deterministic research result, then F0/F1 may pass only a verified persisted
 * proposal into the independent B7 synthetic reserve writer. D11/D12 schedule
 * the successor afterwards. NO_TRADE and signal-gate denial remain read-only.
 * Fill is still absent from this chain. */
export async function handlePaperWorkerPreflightWithSuccessor(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  handlePreflight: HandlePreflight = handlePaperWorkerPreflight,
  enqueueSuccessor: EnqueueSuccessor = enqueueAuthorizedPaperWorkerSuccessor,
  observeMarket: ObserveMarket = observeConfiguredPaperWorkerSpotMarket,
  researchMarket: ResearchMarket = researchObservedPaperWorkerMarket,
  reserveSignal: ReserveSignal = reservePersistedPaperWorkerProposal,
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
  const signal = await reserveSignal(
    deps.prisma,
    payload,
    observation.targetPreflight.targetRevision,
    now,
  );
  const successor = await enqueueSuccessor(deps, payload, now);
  return { status: "ready", preflight, observation, research, signal, successor };
}
