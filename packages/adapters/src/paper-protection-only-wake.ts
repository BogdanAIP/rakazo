import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient, PaperProtectionWakePreflight } from "@rakazo/db";
import {
  readTradingPaperProtectionWakePreflight,
  readTradingPaperWorkerWakePreflight,
} from "@rakazo/db";
import {
  handleVerifiedPaperWorkerAutomaticStops,
  type PaperWorkerAutomaticStopHandlingResult,
} from "./paper-worker-protective-stop.js";

type ReadProtection = typeof readTradingPaperProtectionWakePreflight;
type RunStops = typeof handleVerifiedPaperWorkerAutomaticStops;
type ReadWorker = typeof readTradingPaperWorkerWakePreflight;

/** Unlike a regular PAPER wake, this payload contains no entry/research permission. */
export type PaperProtectionOnlyWake = {
  ledgerId: string;
  spaceId: string;
  userId: string;
  gateRevision: number;
  leaseRevision: number;
  scheduledFor: string;
};

export type PaperProtectionOnlyResult =
  | { status: "deny"; ledgerId: string; reason: string }
  | {
      status: "handled";
      ledgerId: string;
      leaseRevision: number;
      protectiveStop: PaperWorkerAutomaticStopHandlingResult;
    };

/** H2b-0: a PROTECTION-ONLY executor. No research, new-entry,
 * reserve/fill, entry succession, broker I/O or recurring schedule calls.
 *
 * Every F4/G5 readWake is wrapped with a fresh H2b authority check, so
 * expiration or revocation while public quote evidence is obtained fails
 * closed before the existing C2 synthetic close. The owner's original D2
 * gate, F3/G4 provenance and C2 risk policy checks are all still required.
 *
 * Deliberately not yet a registered background queue handler. A separate
 * bounded, independently authorized read-only successor schedule is needed
 * before this can safely supervise positions without explicit invocations.
 */
export async function handlePaperProtectionOnlyWake(
  prisma: PrismaClient,
  payload: PaperProtectionOnlyWake,
  now: Date = new Date(),
  readProtection: ReadProtection = readTradingPaperProtectionWakePreflight,
  runStops: RunStops = handleVerifiedPaperWorkerAutomaticStops,
  readWorker: ReadWorker = readTradingPaperWorkerWakePreflight,
): Promise<PaperProtectionOnlyResult> {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(payload.gateRevision) ||
    payload.gateRevision < 0 ||
    !Number.isSafeInteger(payload.leaseRevision) ||
    payload.leaseRevision < 1 ||
    !Number.isFinite(Date.parse(payload.scheduledFor))
  ) {
    throw new Error("Invalid protection-only PAPER wake scope");
  }
  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const check = (): Promise<PaperProtectionWakePreflight> =>
    readProtection(prisma, owner, payload.ledgerId, payload.leaseRevision, payload.gateRevision);
  const approved = await check();
  if (approved.status !== "ready") {
    return {
      status: "deny",
      ledgerId: payload.ledgerId,
      reason: approved.reason,
    };
  }
  // Reuse F4/G5; it handles only current, provenance-verified open positions
  // and calls the existing, audited PAPER C2 protective close at most once.
  const stopPayload: BackgroundJobPayloads["paper.worker-preflight"] = {
    ledgerId: payload.ledgerId,
    spaceId: payload.spaceId,
    userId: payload.userId,
    gateRevision: payload.gateRevision,
    scheduledFor: payload.scheduledFor,
  };
  const guardedReadWorker: ReadWorker = async (...args) => {
    const again = await check();
    if (again.status !== "ready") {
      // F4/G5 accepts a typed D2 deny. No C2 execution is permitted.
      return {
        status: "deny",
        mode: "paper_only",
        ledgerId: payload.ledgerId,
        reason: "worker_gate_disabled",
      };
    }
    return readWorker(...args);
  };
  const protectiveStop = await runStops(prisma, stopPayload, now, guardedReadWorker);
  return {
    status: "handled",
    ledgerId: payload.ledgerId,
    leaseRevision: payload.leaseRevision,
    protectiveStop,
  };
}
