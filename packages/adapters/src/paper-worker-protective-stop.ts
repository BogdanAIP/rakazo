import { createHash } from "node:crypto";
import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import {
  closeTradingPaperPositionOnStop,
  type PrismaClient,
  readTradingPaperWorkerWakePreflight,
  readVerifiedTradingPaperWorkerAutomaticStopCandidates,
  type TradingPaperWorkerAutomaticStopCandidate,
} from "@rakazo/db";
import {
  capturePublicPaperSpotEvidence,
  type PublicPaperSpotTarget,
} from "./trading-paper-public-capture.js";

type ReadWake = typeof readTradingPaperWorkerWakePreflight;
type ReadCandidates = typeof readVerifiedTradingPaperWorkerAutomaticStopCandidates;
type CaptureEvidence = typeof capturePublicPaperSpotEvidence;
type ClosePosition = typeof closeTradingPaperPositionOnStop;
type WakePreflight = Awaited<ReturnType<ReadWake>>;
type ReadyWake = Extract<WakePreflight, { status: "ready" }>;
type CloseResult = Awaited<ReturnType<ClosePosition>>;

export type PaperWorkerAutomaticStopHandlingResult =
  | {
      status: "continue";
      ledgerId: string;
      checkedPositions: number;
    }
  | {
      status: "stop";
      ledgerId: string;
      reason:
        | "worker_gate_denied"
        | "queued_gate_revision_stale"
        | "worker_scope_changed"
        | "candidate_scope_changed"
        | "close_denied";
      checkedPositions: number;
      positionId?: string;
      workerReason?: string;
      closeReason?: string;
    }
  | {
      status: "close_result";
      ledgerId: string;
      checkedPositions: number;
      positionId: string;
      evidenceId: string;
      close: Exclude<CloseResult, { status: "deny" }>;
    };

function sameWake(left: ReadyWake, right: ReadyWake): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.cadenceMinutes === right.cadenceMinutes &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId
  );
}

function sameCandidate(
  left: TradingPaperWorkerAutomaticStopCandidate,
  right: TradingPaperWorkerAutomaticStopCandidate,
): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.positionId === right.positionId &&
    left.signalId === right.signalId &&
    left.venue === right.venue &&
    left.symbol === right.symbol &&
    left.quantityBase === right.quantityBase &&
    left.stopPriceQuote === right.stopPriceQuote &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.signalRevision === right.signalRevision &&
    left.fillRevision === right.fillRevision &&
    left.targetRevision === right.targetRevision &&
    left.fillApprovalEffectId === right.fillApprovalEffectId &&
    left.targetApprovalEffectId === right.targetApprovalEffectId &&
    left.fillEventSequence === right.fillEventSequence
  );
}

function stopEvidenceId(
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  candidate: TradingPaperWorkerAutomaticStopCandidate,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "paper-worker-stop-v1",
        payload.ledgerId,
        payload.scheduledFor,
        payload.gateRevision,
        candidate.positionId,
        candidate.fillEventSequence,
        candidate.targetRevision,
        candidate.targetApprovalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
  return `paper-worker:${digest}`;
}

/** P11F-5 PAPER-only automatic protective-stop bridge.
 *
 * This handles only open positions proven by F4 to originate from an F3
 * automatic fill. Before each synthetic close attempt it requires a current D2
 * worker authority, captures fresh keyless public evidence for the position's
 * own historical venue/symbol, then rechecks both D2 and F4 scope. The existing
 * C2 close transaction remains the money boundary and independently requires an
 * enabled PAPER policy with the kill switch unlatched.
 *
 * At most one position is closed per scheduled wake. A non-triggered stop is
 * harmless and scanning continues; any other C2 denial halts new trading work
 * for that wake. No private exchange API, credential, broker dispatcher or live
 * order exists in this path.
 */
export async function handleVerifiedPaperWorkerAutomaticStops(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date = new Date(),
  readWake: ReadWake = readTradingPaperWorkerWakePreflight,
  readCandidates: ReadCandidates = readVerifiedTradingPaperWorkerAutomaticStopCandidates,
  capture: CaptureEvidence = capturePublicPaperSpotEvidence,
  closePosition: ClosePosition = closeTradingPaperPositionOnStop,
): Promise<PaperWorkerAutomaticStopHandlingResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid automatic PAPER stop handler clock");
  }

  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const wake = await readWake(prisma, owner, payload.ledgerId, now);
  if (wake.status !== "ready") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "worker_gate_denied",
      workerReason: wake.reason,
      checkedPositions: 0,
    };
  }
  if (wake.gateRevision !== payload.gateRevision) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "queued_gate_revision_stale",
      checkedPositions: 0,
    };
  }

  const candidates = await readCandidates(prisma, owner, payload.ledgerId, now);
  let checkedPositions = 0;

  for (const candidate of candidates.positions) {
    checkedPositions += 1;
    const evidenceId = stopEvidenceId(payload, candidate);
    const target: PublicPaperSpotTarget = {
      venue: candidate.venue,
      symbol: candidate.symbol,
    };
    await capture(prisma, owner, payload.ledgerId, target, evidenceId);

    const [confirmedWake, confirmedCandidates] = await Promise.all([
      readWake(prisma, owner, payload.ledgerId, now),
      readCandidates(prisma, owner, payload.ledgerId, now),
    ]);
    if (
      confirmedWake.status !== "ready" ||
      confirmedWake.gateRevision !== payload.gateRevision ||
      !sameWake(wake, confirmedWake)
    ) {
      return {
        status: "stop",
        ledgerId: payload.ledgerId,
        reason: "worker_scope_changed",
        checkedPositions,
        positionId: candidate.positionId,
        ...(confirmedWake.status === "deny" ? { workerReason: confirmedWake.reason } : {}),
      };
    }

    const confirmedCandidate = confirmedCandidates.positions.find(
      (entry) => entry.positionId === candidate.positionId,
    );
    if (!confirmedCandidate || !sameCandidate(candidate, confirmedCandidate)) {
      return {
        status: "stop",
        ledgerId: payload.ledgerId,
        reason: "candidate_scope_changed",
        checkedPositions,
        positionId: candidate.positionId,
      };
    }

    const close = await closePosition(
      prisma,
      owner,
      payload.ledgerId,
      candidate.positionId,
      evidenceId,
    );
    if (close.status === "deny") {
      if (close.reason === "stop_not_triggered") continue;
      return {
        status: "stop",
        ledgerId: payload.ledgerId,
        reason: "close_denied",
        checkedPositions,
        positionId: candidate.positionId,
        closeReason: close.reason,
      };
    }
    return {
      status: "close_result",
      ledgerId: payload.ledgerId,
      checkedPositions,
      positionId: candidate.positionId,
      evidenceId,
      close,
    };
  }

  return {
    status: "continue",
    ledgerId: payload.ledgerId,
    checkedPositions,
  };
}
