import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  handlePaperWorkerPreflight,
  type PaperWorkerPreflightJobResult,
} from "./paper-worker-background.js";
import {
  fillReservedPaperWorkerProposal,
  type PaperWorkerFillAttemptResult,
} from "./paper-worker-fill.js";
import {
  observeConfiguredPaperWorkerSpotMarket,
  type PaperWorkerMarketObservationResult,
} from "./paper-worker-market-observation.js";
import {
  handleVerifiedPaperWorkerAutomaticStops,
  type PaperWorkerAutomaticStopHandlingResult,
} from "./paper-worker-protective-stop.js";
import type { PaperWorkerResolvedResearchFlowResult } from "./paper-worker-resolved-research-flow.js";
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
type FillSignal = typeof fillReservedPaperWorkerProposal;
type HandleAutomaticStops = typeof handleVerifiedPaperWorkerAutomaticStops;
type HandleResolvedResearch = (
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date,
) => Promise<PaperWorkerResolvedResearchFlowResult>;
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
      stage: "protective_stop";
      preflight: ReadyPreflight;
      protectiveStop: Exclude<PaperWorkerAutomaticStopHandlingResult, { status: "continue" }>;
      successor: AuthorizedPaperWorkerSuccessorScheduleResult;
    }
  | {
      status: "stop";
      stage: "observation";
      preflight: ReadyPreflight;
      observation: StoppedObservation;
    }
  | {
      status: "resolved";
      preflight: ReadyPreflight;
      resolvedResearch: PaperWorkerResolvedResearchFlowResult;
      successor: AuthorizedPaperWorkerSuccessorScheduleResult;
    }
  | {
      status: "ready";
      preflight: ReadyPreflight;
      observation: CompletedObservation;
      research: PaperWorkerResearchResult;
      signal: PaperWorkerSignalReservationResult;
      fill: PaperWorkerFillAttemptResult;
      successor: AuthorizedPaperWorkerSuccessorScheduleResult;
    };

/** PAPER wake composition. D2 revalidates the worker gate, then F4/G5
 * service at most one verified automatic protective stop before any new
 * exposure. When a G6 resolved-research runner is explicitly injected, it
 * replaces the legacy E1/E3 -> E5/E6 -> F0/F1 -> F2/F3 research path for that
 * wake and uses the generic G1-G4 PAPER boundaries instead. Without that
 * injection the legacy deterministic path remains unchanged. C2 remains the
 * synthetic close money boundary. D11/D12 schedule the successor. No private
 * exchange API, broker dispatcher or live order exists in either path. */
export async function handlePaperWorkerPreflightWithSuccessor(
  deps: {
    prisma: PrismaClient;
    jobs: Pick<JobPublisher, "enqueue">;
    handleAutomaticStops?: HandleAutomaticStops;
    handleResolvedResearch?: HandleResolvedResearch;
  },
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  handlePreflight: HandlePreflight = handlePaperWorkerPreflight,
  enqueueSuccessor: EnqueueSuccessor = enqueueAuthorizedPaperWorkerSuccessor,
  observeMarket: ObserveMarket = observeConfiguredPaperWorkerSpotMarket,
  researchMarket: ResearchMarket = researchObservedPaperWorkerMarket,
  reserveSignal: ReserveSignal = reservePersistedPaperWorkerProposal,
  fillSignal: FillSignal = fillReservedPaperWorkerProposal,
): Promise<PaperWorkerRecurringHandlerResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid recurring paper worker handler clock");
  }
  const preflight = await handlePreflight(deps.prisma, payload);
  if (preflight.status !== "ready") {
    return { status: "stop", stage: "preflight", preflight };
  }

  const protectiveStop = await (
    deps.handleAutomaticStops ?? handleVerifiedPaperWorkerAutomaticStops
  )(deps.prisma, payload, now);
  if (protectiveStop.status !== "continue") {
    const successor = await enqueueSuccessor(deps, payload, now);
    return {
      status: "stop",
      stage: "protective_stop",
      preflight,
      protectiveStop,
      successor,
    };
  }

  if (deps.handleResolvedResearch) {
    const resolvedResearch = await deps.handleResolvedResearch(deps.prisma, payload, now);
    const successor = await enqueueSuccessor(deps, payload, now);
    return {
      status: "resolved",
      preflight,
      resolvedResearch,
      successor,
    };
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
  const fill = await fillSignal(deps.prisma, payload, signal, now);
  const successor = await enqueueSuccessor(deps, payload, now);
  return { status: "ready", preflight, observation, research, signal, fill, successor };
}
