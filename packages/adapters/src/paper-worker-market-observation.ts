import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  handlePaperWorkerPreflight,
  type PaperWorkerPreflightJobResult,
} from "./paper-worker-background.js";
import {
  capturePublicPaperSpotEvidence,
  type PublicPaperSpotTarget,
} from "./trading-paper-public-capture.js";

type HandlePreflight = typeof handlePaperWorkerPreflight;
type CaptureEvidence = typeof capturePublicPaperSpotEvidence;

export type PaperWorkerMarketObservationResult =
  | {
      status: "stop";
      preflight: Exclude<PaperWorkerPreflightJobResult, { status: "ready" }>;
    }
  | {
      status: "observed";
      preflight: Extract<PaperWorkerPreflightJobResult, { status: "ready" }>;
      target: PublicPaperSpotTarget;
      evidence: { id: string; source: "public_adapter_observation" };
    };

/** P11E-0 internal composition only. It may persist one verified public quote
 * observation after the existing D2 worker preflight is ready, but it has no
 * production caller, recurrence wiring, trading writer, signal generator,
 * model runtime, exchange credential or private endpoint. */
export async function observeAuthorizedPaperWorkerSpotMarket(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  target: PublicPaperSpotTarget,
  handlePreflight: HandlePreflight = handlePaperWorkerPreflight,
  captureEvidence: CaptureEvidence = capturePublicPaperSpotEvidence,
): Promise<PaperWorkerMarketObservationResult> {
  const preflight = await handlePreflight(prisma, payload);
  if (preflight.status !== "ready") {
    return { status: "stop", preflight };
  }

  const evidence = await captureEvidence(
    prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    payload.ledgerId,
    target,
  );
  return { status: "observed", preflight, target, evidence };
}
