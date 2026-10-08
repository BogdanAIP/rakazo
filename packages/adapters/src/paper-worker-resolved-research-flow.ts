import { createHash } from "node:crypto";
import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingInstrument, TradingResolvedResearchEnvelope } from "@rakazo/contracts";
import {
  fillApprovedResolvedTradingPaperReservation,
  type PrismaClient,
  readTradingPaperResolvedResearchFillPreflight,
  readTradingPaperResolvedResearchPreflight,
  reserveApprovedResolvedTradingPaperSignal,
  type TradingPaperFillResult,
  type TradingPaperReserveResult,
} from "@rakazo/db";

type Owner = { spaceId: string; userId: string };
type ReadResearchPreflight = typeof readTradingPaperResolvedResearchPreflight;
type ReserveResolvedSignal = typeof reserveApprovedResolvedTradingPaperSignal;
type ReadFillPreflight = typeof readTradingPaperResolvedResearchFillPreflight;
type FillResolvedReservation = typeof fillApprovedResolvedTradingPaperReservation;

export type PaperWorkerResolvedResearchProvider = (
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  now: Date,
) => Promise<TradingResolvedResearchEnvelope>;

export type PaperWorkerResolvedResearchEvidenceCapture = (
  prisma: PrismaClient,
  owner: Owner,
  ledgerId: string,
  market: TradingInstrument,
  evidenceId: string,
) => Promise<{ id: string; source: "public_adapter_observation" }>;

export type PaperWorkerResolvedResearchFlowResult =
  | {
      status: "no_trade";
      ledgerId: string;
      signalId: string;
    }
  | {
      status: "stop";
      ledgerId: string;
      stage: "research_gate" | "reserve" | "fill_gate" | "fill";
      reason: string;
      signalId?: string;
      reservationId?: string;
    }
  | {
      status: "reserved";
      ledgerId: string;
      signalId: string;
      reservation: Extract<TradingPaperReserveResult, { status: "reserved" | "duplicate" }>;
    }
  | {
      status: "filled";
      ledgerId: string;
      signalId: string;
      reservation: Extract<TradingPaperReserveResult, { status: "reserved" | "duplicate" }>;
      fill: Extract<TradingPaperFillResult, { status: "filled" | "duplicate" }>;
    };

function evidenceId(
  kind: "reserve" | "fill",
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  envelope: TradingResolvedResearchEnvelope,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "paper-resolved-research-v1",
        kind,
        payload.ledgerId,
        payload.scheduledFor,
        payload.gateRevision,
        envelope.provenance.resolverKey,
        envelope.provenance.resolverDigest,
        envelope.provenance.implementation.reference,
        envelope.provenance.skill?.sourceDigest ?? null,
        envelope.signal.signalId,
      ]),
      "utf8",
    )
    .digest("hex");
  return `paper-resolver:${digest}`;
}

/**
 * G6 generic PAPER worker composition for one already prepared Resolver/Skill
 * research envelope.
 *
 * The provider is research-only and carries no execution authority. G1 is
 * checked before any trusted quote capture; G2 rechecks G1 in the same
 * serializable reserve transaction. A G2 reserve is returned as-is unless the
 * independently owner-approved G3 fill gate is ready. Only then is a second,
 * fresh trusted public quote captured and G4 invoked.
 *
 * This function contains no exchange/private credential route and deliberately
 * has no default provider or generic market-data implementation. A future
 * Market integration must inject those read-only pieces explicitly.
 */
export async function handlePreparedPaperWorkerResolvedResearch(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  provider: PaperWorkerResolvedResearchProvider,
  captureEvidence: PaperWorkerResolvedResearchEvidenceCapture,
  now: Date = new Date(),
  services: {
    readResearchPreflight?: ReadResearchPreflight;
    reserveResolvedSignal?: ReserveResolvedSignal;
    readFillPreflight?: ReadFillPreflight;
    fillResolvedReservation?: FillResolvedReservation;
  } = {},
): Promise<PaperWorkerResolvedResearchFlowResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid resolved research worker clock");
  }

  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const envelope = await provider(payload, now);
  if (envelope.signal.kind === "no_trade") {
    return {
      status: "no_trade",
      ledgerId: payload.ledgerId,
      signalId: envelope.signal.signalId,
    };
  }

  const researchAuthority = await (
    services.readResearchPreflight ?? readTradingPaperResolvedResearchPreflight
  )(prisma, owner, payload.ledgerId, envelope, now);
  if (researchAuthority.status !== "ready") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      stage: "research_gate",
      reason: researchAuthority.reason,
      signalId: envelope.signal.signalId,
    };
  }

  const reserveEvidenceId = evidenceId("reserve", payload, envelope);
  const reserveEvidence = await captureEvidence(
    prisma,
    owner,
    payload.ledgerId,
    envelope.signal.market,
    reserveEvidenceId,
  );
  if (reserveEvidence.id !== reserveEvidenceId) {
    throw new Error("Resolved research reserve evidence id changed during capture");
  }

  const reservation = await (
    services.reserveResolvedSignal ?? reserveApprovedResolvedTradingPaperSignal
  )(prisma, owner, payload.ledgerId, envelope, reserveEvidenceId, researchAuthority);
  if (reservation.status === "deny") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      stage: "reserve",
      reason: reservation.reason,
      signalId: envelope.signal.signalId,
    };
  }

  const fillAuthority = await (
    services.readFillPreflight ?? readTradingPaperResolvedResearchFillPreflight
  )(prisma, owner, payload.ledgerId, now);
  if (fillAuthority.status !== "ready") {
    if (fillAuthority.reason === "resolved_fill_gate_disabled") {
      return {
        status: "reserved",
        ledgerId: payload.ledgerId,
        signalId: envelope.signal.signalId,
        reservation,
      };
    }
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      stage: "fill_gate",
      reason: fillAuthority.reason,
      signalId: envelope.signal.signalId,
      reservationId: reservation.reservationId,
    };
  }

  const fillEvidenceId = evidenceId("fill", payload, envelope);
  const fillEvidence = await captureEvidence(
    prisma,
    owner,
    payload.ledgerId,
    envelope.signal.market,
    fillEvidenceId,
  );
  if (fillEvidence.id !== fillEvidenceId) {
    throw new Error("Resolved research fill evidence id changed during capture");
  }

  const fill = await (
    services.fillResolvedReservation ?? fillApprovedResolvedTradingPaperReservation
  )(prisma, owner, payload.ledgerId, reservation.reservationId, fillEvidenceId, fillAuthority);
  if (fill.status === "deny") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      stage: "fill",
      reason: fill.reason,
      signalId: envelope.signal.signalId,
      reservationId: reservation.reservationId,
    };
  }
  return {
    status: "filled",
    ledgerId: payload.ledgerId,
    signalId: envelope.signal.signalId,
    reservation,
    fill,
  };
}
