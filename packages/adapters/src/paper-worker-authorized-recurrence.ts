import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingPaperWorkerRecurrencePreflight } from "@rakazo/db";
import {
  type PaperWorkerSuccessorPlan,
  planPaperWorkerPreflightSuccessor,
} from "./paper-worker-recurrence.js";

export type AuthorizedPaperWorkerSuccessorPlan =
  | PaperWorkerSuccessorPlan
  | {
      status: "stop";
      ledgerId: string;
      reason: "recurrence_denied" | "recurrence_scope_changed";
    };

/** Pure D7 -> D5 composition. No DB read and no queue side effect occurs here. */
export function planAuthorizedPaperWorkerPreflightSuccessor(
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  recurrence: TradingPaperWorkerRecurrencePreflight,
  now: Date,
): AuthorizedPaperWorkerSuccessorPlan {
  if (recurrence.status !== "ready") {
    return { status: "stop", ledgerId: payload.ledgerId, reason: "recurrence_denied" };
  }
  if (
    recurrence.ledgerId !== payload.ledgerId ||
    recurrence.gateRevision !== payload.gateRevision
  ) {
    return {
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "recurrence_scope_changed",
    };
  }
  return planPaperWorkerPreflightSuccessor(
    payload,
    {
      status: "ready",
      gateRevision: recurrence.gateRevision,
      cadenceMinutes: recurrence.cadenceMinutes,
    },
    now,
  );
}
