import { createHash } from "node:crypto";
import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import {
  closeTradingPaperPositionOnStop,
  type PrismaClient,
  readTradingPaperWorkerWakePreflight,
  readVerifiedTradingPaperResolvedResearchAutomaticStopCandidates,
  readVerifiedTradingPaperWorkerAutomaticStopCandidates,
  type TradingPaperResolvedResearchAutomaticStopCandidate,
  type TradingPaperWorkerAutomaticStopCandidate,
} from "@rakazo/db";
import {
  capturePublicPaperSpotEvidence,
  type PublicPaperSpotTarget,
} from "./trading-paper-public-capture.js";

type ReadWake = typeof readTradingPaperWorkerWakePreflight;
type ReadCandidates = typeof readVerifiedTradingPaperWorkerAutomaticStopCandidates;
type ReadResolvedCandidates =
  typeof readVerifiedTradingPaperResolvedResearchAutomaticStopCandidates;
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
        | "unsupported_candidate_market"
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

function sameResolvedCandidate(
  left: TradingPaperResolvedResearchAutomaticStopCandidate,
  right: TradingPaperResolvedResearchAutomaticStopCandidate,
): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.positionId === right.positionId &&
    left.signalId === right.signalId &&
    left.venue === right.venue &&
    left.symbol === right.symbol &&
    left.quantityBase === right.quantityBase &&
    left.stopPriceQuote === right.stopPriceQuote &&
    JSON.stringify(left.scope) === JSON.stringify(right.scope) &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.researchRevision === right.researchRevision &&
    left.fillRevision === right.fillRevision &&
    left.fillApprovalEffectId === right.fillApprovalEffectId &&
    left.researchApprovalEffectId === right.researchApprovalEffectId &&
    left.fillEventSequence === right.fillEventSequence
  );
}

function resolvedStopEvidenceId(
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  candidate: TradingPaperResolvedResearchAutomaticStopCandidate,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "paper-resolved-stop-v1",
        payload.ledgerId,
        payload.scheduledFor,
        payload.gateRevision,
        candidate.positionId,
        candidate.fillEventSequence,
        candidate.researchRevision,
        candidate.fillRevision,
        candidate.fillApprovalEffectId,
        candidate.researchApprovalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
  return `paper-worker:${digest}`;
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
 * This handles open positions proven by F4/G5 to originate from either an F3
 * worker fill or a G4 Resolver/Skill fill. Before each synthetic close attempt
 * it requires a current D2 worker authority, captures fresh keyless public
 * evidence for the position's own historical venue/symbol, then rechecks D2
 * and the exact fill provenance. The existing
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
  readResolvedCandidates: ReadResolvedCandidates = readVerifiedTradingPaperResolvedResearchAutomaticStopCandidates,
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

  const [workerCandidates, resolvedCandidates] = await Promise.all([
    readCandidates(prisma, owner, payload.ledgerId, now),
    readResolvedCandidates(prisma, owner, payload.ledgerId, now),
  ]);
  const candidates = [
    ...workerCandidates.positions.map((candidate) => ({
      provenance: "worker_f3" as const,
      candidate,
    })),
    ...resolvedCandidates.positions.map((candidate) => ({
      provenance: "resolved_g4" as const,
      candidate,
    })),
  ].sort((left, right) => left.candidate.fillEventSequence - right.candidate.fillEventSequence);

  const positionIds = new Set<string>();
  for (const entry of candidates) {
    if (positionIds.has(entry.candidate.positionId)) {
      throw new Error("Automatic PAPER stop candidate has conflicting fill provenance");
    }
    positionIds.add(entry.candidate.positionId);
  }

  let checkedPositions = 0;

  for (const entry of candidates) {
    checkedPositions += 1;
    const { candidate } = entry;
    if (candidate.venue !== "okx" && candidate.venue !== "bingx") {
      return {
        status: "stop",
        ledgerId: payload.ledgerId,
        reason: "unsupported_candidate_market",
        checkedPositions,
        positionId: candidate.positionId,
      };
    }
    const evidenceId =
      entry.provenance === "worker_f3"
        ? stopEvidenceId(payload, candidate)
        : resolvedStopEvidenceId(payload, candidate);
    const target: PublicPaperSpotTarget = {
      venue: candidate.venue,
      symbol: candidate.symbol,
    };
    await capture(prisma, owner, payload.ledgerId, target, evidenceId);

    const [confirmedWake, confirmedWorkerCandidates, confirmedResolvedCandidates] =
      await Promise.all([
        readWake(prisma, owner, payload.ledgerId, now),
        readCandidates(prisma, owner, payload.ledgerId, now),
        readResolvedCandidates(prisma, owner, payload.ledgerId, now),
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

    const candidateMatches =
      entry.provenance === "worker_f3"
        ? (() => {
            const confirmed = confirmedWorkerCandidates.positions.find(
              (item) => item.positionId === candidate.positionId,
            );
            return confirmed ? sameCandidate(candidate, confirmed) : false;
          })()
        : (() => {
            const confirmed = confirmedResolvedCandidates.positions.find(
              (item) => item.positionId === candidate.positionId,
            );
            return confirmed ? sameResolvedCandidate(candidate, confirmed) : false;
          })();
    if (!candidateMatches) {
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
