import {
  type BackgroundJob,
  type BackgroundJobPayloads,
  paperWorkerPreflightJob,
} from "@rakazo/adapter-kit";
import type { PaperWorkerPreflightJobResult } from "./paper-worker-background.js";

export type PaperWorkerSuccessorPlan =
  | {
      status: "planned";
      ledgerId: string;
      gateRevision: number;
      scheduledFor: string;
      job: BackgroundJob;
    }
  | {
      status: "stop";
      ledgerId: string;
      reason: "preflight_denied" | "stale_gate_revision";
    };

/** Pure recurrence planning only. It neither reads state nor enqueues work. */
export function planPaperWorkerPreflightSuccessor(
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  result: PaperWorkerPreflightJobResult,
  now: Date,
): PaperWorkerSuccessorPlan {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid paper worker recurrence clock");
  if (result.status === "deny") {
    return { status: "stop", ledgerId: payload.ledgerId, reason: "preflight_denied" };
  }
  if (result.status === "stale_gate_revision" || result.gateRevision !== payload.gateRevision) {
    return { status: "stop", ledgerId: payload.ledgerId, reason: "stale_gate_revision" };
  }
  if (
    !Number.isSafeInteger(result.cadenceMinutes) ||
    result.cadenceMinutes < 5 ||
    result.cadenceMinutes > 1440
  ) {
    throw new Error("Invalid verified paper worker cadence");
  }
  const baseMs = Date.parse(payload.scheduledFor);
  if (!Number.isFinite(baseMs)) throw new Error("Invalid paper worker scheduledFor");
  const cadenceMs = result.cadenceMinutes * 60_000;
  const nowMs = now.getTime();
  const intervals = Math.max(1, Math.floor((nowMs - baseMs) / cadenceMs) + 1);
  const scheduledFor = new Date(baseMs + intervals * cadenceMs);
  const job = paperWorkerPreflightJob({
    ledgerId: payload.ledgerId,
    spaceId: payload.spaceId,
    userId: payload.userId,
    gateRevision: payload.gateRevision,
    scheduledFor,
  });
  return {
    status: "planned",
    ledgerId: payload.ledgerId,
    gateRevision: payload.gateRevision,
    scheduledFor: scheduledFor.toISOString(),
    job,
  };
}
