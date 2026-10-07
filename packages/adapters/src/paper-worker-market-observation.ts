import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import {
  type PrismaClient,
  readTradingPaperWorkerMarketTargetPreflight,
  type TradingPaperWorkerMarketTargetPreflight,
} from "@rakazo/db";
import {
  capturePublicPaperSpotEvidence,
  type PublicPaperSpotTarget,
} from "./trading-paper-public-capture.js";

type ReadTargetPreflight = typeof readTradingPaperWorkerMarketTargetPreflight;
type CaptureEvidence = typeof capturePublicPaperSpotEvidence;
type ReadyTarget = Extract<TradingPaperWorkerMarketTargetPreflight, { status: "ready" }>;

export type PaperWorkerMarketObservationResult =
  | {
      status: "stop";
      reason: "target_denied" | "queued_gate_revision_stale";
      targetPreflight: TradingPaperWorkerMarketTargetPreflight;
    }
  | {
      status: "observed";
      targetPreflight: ReadyTarget;
      target: PublicPaperSpotTarget;
      evidence: { id: string; source: "public_adapter_observation" };
    };

/** P11E-2 internal composition only. The public target is never supplied by a
 * caller: it must come from the E1 owner-approved target preflight, which also
 * revalidates PAPER + worker approval provenance. The queued D1 gate revision
 * is checked again before any network request. This still has no production
 * background registration, signal/model runtime or trading writer. */
export async function observeConfiguredPaperWorkerSpotMarket(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  readTargetPreflight: ReadTargetPreflight = readTradingPaperWorkerMarketTargetPreflight,
  captureEvidence: CaptureEvidence = capturePublicPaperSpotEvidence,
): Promise<PaperWorkerMarketObservationResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid paper market observation clock");
  }

  const targetPreflight = await readTargetPreflight(
    prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    payload.ledgerId,
    now,
  );
  if (targetPreflight.status !== "ready") {
    return { status: "stop", reason: "target_denied", targetPreflight };
  }
  if (targetPreflight.gateRevision !== payload.gateRevision) {
    return { status: "stop", reason: "queued_gate_revision_stale", targetPreflight };
  }

  const target: PublicPaperSpotTarget = {
    venue: targetPreflight.venue,
    symbol: targetPreflight.symbol,
  };
  const evidence = await captureEvidence(
    prisma,
    { spaceId: payload.spaceId, userId: payload.userId },
    payload.ledgerId,
    target,
  );
  return { status: "observed", targetPreflight, target, evidence };
}
