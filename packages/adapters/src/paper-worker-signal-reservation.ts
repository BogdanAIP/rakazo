import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingInstrument } from "@rakazo/contracts";
import {
  type PrismaClient,
  readTradingPaperWorkerSignalPreflight,
  readVerifiedTradingPaperWorkerResearchOutputIfPresent,
  reserveApprovedTradingPaperSignal,
} from "@rakazo/db";

type ReadSignalPreflight = typeof readTradingPaperWorkerSignalPreflight;
type ReadResearch = typeof readVerifiedTradingPaperWorkerResearchOutputIfPresent;
type ReserveSignal = typeof reserveApprovedTradingPaperSignal;
type ReserveResult = Awaited<ReturnType<ReserveSignal>>;
type ReadySignalPreflight = Extract<Awaited<ReturnType<ReadSignalPreflight>>, { status: "ready" }>;

export class PaperWorkerSignalReservationIntegrityError extends Error {
  constructor(message = "Synthetic paper worker signal reservation integrity mismatch") {
    super(message);
    this.name = "PaperWorkerSignalReservationIntegrityError";
  }
}

export type PaperWorkerSignalReservationResult =
  | {
      status: "stop";
      ledgerId: string;
      reason:
        | "signal_gate_denied"
        | "signal_scope_changed"
        | "research_unavailable"
        | "no_trade"
        | "signal_expired";
      signalGateReason?: string;
      signalId?: string;
    }
  | {
      status: "reserve_result";
      ledgerId: string;
      signalId: string;
      reserve: ReserveResult;
    };

function sameMarket(left: TradingInstrument, right: TradingInstrument): boolean {
  return (
    left.venue === right.venue &&
    left.kind === right.kind &&
    left.symbol === right.symbol &&
    left.base === right.base &&
    left.quote === right.quote &&
    left.status === right.status &&
    left.priceIncrement === right.priceIncrement &&
    left.quantityIncrement === right.quantityIncrement &&
    left.minNotional === right.minNotional &&
    left.expiryAt === right.expiryAt
  );
}

function sameSignalAuthority(left: ReadySignalPreflight, right: ReadySignalPreflight): boolean {
  return (
    left.ledgerId === right.ledgerId &&
    left.strategyId === right.strategyId &&
    left.policyRevision === right.policyRevision &&
    left.gateRevision === right.gateRevision &&
    left.signalRevision === right.signalRevision &&
    left.signalApprovalEffectId === right.signalApprovalEffectId &&
    left.workerApprovalEffectId === right.workerApprovalEffectId &&
    left.paperApprovalEffectId === right.paperApprovalEffectId
  );
}

/** P11F-1 internal PAPER-only bridge.
 *
 * It never accepts a caller-supplied signal or quote id. The candidate is
 * re-read from the durable E5/E6 research row, the F0 signal gate is checked
 * before and immediately before B7, and only an unexpired proposal from the
 * fixed authorized strategy may reach the existing synthetic reserve writer.
 * NO_TRADE, missing research, stale scope and revoked signal permission stop
 * before any paper writer is called. Fill remains a separate later gate.
 */
export async function reservePersistedPaperWorkerProposal(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  targetRevision: number,
  now: Date = new Date(),
  readSignalPreflight: ReadSignalPreflight = readTradingPaperWorkerSignalPreflight,
  readResearch: ReadResearch = readVerifiedTradingPaperWorkerResearchOutputIfPresent,
  reserveSignal: ReserveSignal = reserveApprovedTradingPaperSignal,
): Promise<PaperWorkerSignalReservationResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new PaperWorkerSignalReservationIntegrityError("Invalid paper worker signal clock");
  }
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 1) {
    throw new PaperWorkerSignalReservationIntegrityError(
      "Invalid paper worker research target revision",
    );
  }

  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const gate = await readSignalPreflight(prisma, owner, payload.ledgerId, now);
  if (gate.status !== "ready") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "signal_gate_denied",
      signalGateReason: gate.reason,
    };
  }
  if (gate.gateRevision !== payload.gateRevision) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "signal_scope_changed",
    };
  }

  const research = await readResearch(prisma, owner, payload.ledgerId, {
    sourceScheduledFor: payload.scheduledFor,
    gateRevision: payload.gateRevision,
    targetRevision,
  });
  if (!research) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "research_unavailable",
    };
  }

  if (
    research.record.gateRevision !== gate.gateRevision ||
    research.output.algorithm !== gate.strategyId ||
    research.output.signal.strategyId !== gate.strategyId
  ) {
    throw new PaperWorkerSignalReservationIntegrityError(
      "Persisted research disagrees with authorized signal scope",
    );
  }

  const signal = research.output.signal;
  if (signal.kind === "no_trade") {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "no_trade",
      signalId: signal.signalId,
    };
  }

  if (
    signal.action !== "spot_buy" ||
    research.output.venue !== signal.market.venue ||
    !sameMarket(research.output.market, signal.market)
  ) {
    throw new PaperWorkerSignalReservationIntegrityError(
      "Persisted proposal market or action is outside the worker reserve scope",
    );
  }

  const expiresAt = Date.parse(signal.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now.getTime() < 1_000) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "signal_expired",
      signalId: signal.signalId,
    };
  }

  const confirmedGate = await readSignalPreflight(prisma, owner, payload.ledgerId, now);
  if (
    confirmedGate.status !== "ready" ||
    confirmedGate.gateRevision !== payload.gateRevision ||
    !sameSignalAuthority(gate, confirmedGate)
  ) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "signal_scope_changed",
      ...(confirmedGate.status === "deny" ? { signalGateReason: confirmedGate.reason } : {}),
      signalId: signal.signalId,
    };
  }

  const reserve = await reserveSignal(
    prisma,
    owner,
    payload.ledgerId,
    signal,
    research.record.quoteEvidenceId,
    confirmedGate,
    undefined,
    payload.sessionRevision,
  );
  return {
    status: "reserve_result",
    ledgerId: payload.ledgerId,
    signalId: signal.signalId,
    reserve,
  };
}
