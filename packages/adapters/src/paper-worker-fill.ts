import { createHash } from "node:crypto";
import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import {
  fillApprovedTradingPaperReservation,
  type PrismaClient,
  readTradingPaperWorkerFillPreflight,
  readTradingPaperWorkerMarketTargetPreflight,
  type TradingPaperWorkerFillPreflight,
  type TradingPaperWorkerMarketTargetPreflight,
} from "@rakazo/db";
import type { PaperWorkerSignalReservationResult } from "./paper-worker-signal-reservation.js";
import {
  capturePublicPaperSpotEvidence,
  type PublicPaperSpotTarget,
} from "./trading-paper-public-capture.js";

type ReadFillPreflight = typeof readTradingPaperWorkerFillPreflight;
type ReadTargetPreflight = typeof readTradingPaperWorkerMarketTargetPreflight;
type CaptureEvidence = typeof capturePublicPaperSpotEvidence;
type FillReservation = typeof fillApprovedTradingPaperReservation;
type FillResult = Awaited<ReturnType<FillReservation>>;
type ReadyFill = Extract<TradingPaperWorkerFillPreflight, { status: "ready" }>;
type ReadyTarget = Extract<TradingPaperWorkerMarketTargetPreflight, { status: "ready" }>;

export type PaperWorkerFillAttemptResult =
  | {
      status: "stop";
      ledgerId: string;
      reason:
        | "reservation_unavailable"
        | "fill_gate_denied"
        | "fill_scope_changed"
        | "target_denied"
        | "target_scope_changed";
      reservationId?: string;
      fillReason?: string;
      targetReason?: string;
    }
  | {
      status: "fill_result";
      ledgerId: string;
      reservationId: string;
      evidenceId: string;
      fill: FillResult;
    };

function sameFillAuthority(left: ReadyFill, right: ReadyFill): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.strategyId === right.strategyId &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.signalRevision === right.signalRevision &&
    left.fillRevision === right.fillRevision &&
    left.fillApprovalEffectId === right.fillApprovalEffectId &&
    left.signalApprovalEffectId === right.signalApprovalEffectId &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId
  );
}

function sameTarget(left: ReadyTarget, right: ReadyTarget): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.venue === right.venue &&
    left.symbol === right.symbol &&
    left.gateRevision === right.gateRevision &&
    left.targetRevision === right.targetRevision &&
    left.targetApprovalEffectId === right.targetApprovalEffectId &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId
  );
}

function fillEvidenceId(
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  reservationId: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "paper-worker-fill-v1",
        payload.ledgerId,
        payload.scheduledFor,
        payload.gateRevision,
        reservationId,
      ]),
      "utf8",
    )
    .digest("hex");
  return `paper-worker:${digest}`;
}

/** P11F-3 PAPER-only bridge from an existing B7 reservation to C1.
 *
 * The reservation must have come from the F1 result for this exact worker wake.
 * F2 and the approved public market target are checked before the fresh quote
 * fetch and rechecked immediately afterwards. C1 receives the exact verified
 * F2 and market-target authorities and revalidates both again inside its own
 * serializable money transaction. The quote id is deterministic for the logical
 * scheduled-wake + reservation attempt, so a crash/retry cannot turn an
 * uncertain successful fill into a second fill with different evidence.
 */
export async function fillReservedPaperWorkerProposal(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  signal: PaperWorkerSignalReservationResult,
  now: Date = new Date(),
  readFill: ReadFillPreflight = readTradingPaperWorkerFillPreflight,
  readTarget: ReadTargetPreflight = readTradingPaperWorkerMarketTargetPreflight,
  capture: CaptureEvidence = capturePublicPaperSpotEvidence,
  fillReservation: FillReservation = fillApprovedTradingPaperReservation,
): Promise<PaperWorkerFillAttemptResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid paper worker fill clock");
  }
  if (
    signal.status !== "reserve_result" ||
    (signal.reserve.status !== "reserved" && signal.reserve.status !== "duplicate")
  ) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "reservation_unavailable",
    };
  }
  const reservationId = signal.reserve.reservationId;
  const owner = { spaceId: payload.spaceId, userId: payload.userId };

  const fill = await readFill(prisma, owner, payload.ledgerId, now);
  if (fill.status !== "ready") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reservationId,
      reason: "fill_gate_denied",
      fillReason: fill.reason,
    };
  }
  if (fill.gateRevision !== payload.gateRevision) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reservationId,
      reason: "fill_scope_changed",
    };
  }

  const target = await readTarget(prisma, owner, payload.ledgerId, now);
  if (target.status !== "ready") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reservationId,
      reason: "target_denied",
      targetReason: target.reason,
    };
  }
  if (target.gateRevision !== payload.gateRevision) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reservationId,
      reason: "target_scope_changed",
    };
  }

  const evidenceId = fillEvidenceId(payload, reservationId);
  const publicTarget: PublicPaperSpotTarget = {
    venue: target.venue,
    symbol: target.symbol,
  };
  await capture(prisma, owner, payload.ledgerId, publicTarget, evidenceId);

  const [confirmedFill, confirmedTarget] = await Promise.all([
    readFill(prisma, owner, payload.ledgerId, now),
    readTarget(prisma, owner, payload.ledgerId, now),
  ]);
  if (
    confirmedFill.status !== "ready" ||
    confirmedFill.gateRevision !== payload.gateRevision ||
    !sameFillAuthority(fill, confirmedFill)
  ) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reservationId,
      reason: "fill_scope_changed",
      ...(confirmedFill.status === "deny" ? { fillReason: confirmedFill.reason } : {}),
    };
  }
  if (
    confirmedTarget.status !== "ready" ||
    confirmedTarget.gateRevision !== payload.gateRevision ||
    !sameTarget(target, confirmedTarget)
  ) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reservationId,
      reason: "target_scope_changed",
      ...(confirmedTarget.status === "deny" ? { targetReason: confirmedTarget.reason } : {}),
    };
  }

  const result = await fillReservation(
    prisma,
    owner,
    payload.ledgerId,
    reservationId,
    evidenceId,
    confirmedFill,
    confirmedTarget,
  );
  return {
    status: "fill_result",
    ledgerId: payload.ledgerId,
    reservationId,
    evidenceId,
    fill: result,
  };
}
