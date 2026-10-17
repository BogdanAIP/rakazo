import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingPaperWorkerRecurrencePreflight } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { planAuthorizedPaperWorkerPreflightSuccessor } from "./paper-worker-authorized-recurrence.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-05T12:00:00.000Z",
};

const ready: TradingPaperWorkerRecurrencePreflight = {
  status: "ready",
  mode: "paper_only",
  ledgerId: "paper-1",
  cadenceMinutes: 15,
  gateRevision: 7,
  recurrenceRevision: 3,
  recurrenceApprovalEffectId: "recurrence-effect",
  workerApprovalEffectId: "worker-effect",
  paperApprovalEffectId: "paper-effect",
};

describe("planAuthorizedPaperWorkerPreflightSuccessor", () => {
  it("plans only from a ready recurrence preflight with the exact scope", () => {
    expect(
      planAuthorizedPaperWorkerPreflightSuccessor(
        payload,
        ready,
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toMatchObject({
      status: "planned",
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
      job: {
        name: "paper.worker-preflight",
        replaceKey: "paper.worker-preflight:paper-1",
      },
    });
  });

  it("skips missed cadence boundaries through the D5 planner", () => {
    expect(
      planAuthorizedPaperWorkerPreflightSuccessor(
        payload,
        ready,
        new Date("2026-10-05T12:46:00.000Z"),
      ),
    ).toMatchObject({
      status: "planned",
      scheduledFor: "2026-10-05T13:00:00.000Z",
    });
  });

  it("stops on recurrence denial without constructing a successor", () => {
    const denied: TradingPaperWorkerRecurrencePreflight = {
      status: "deny",
      mode: "paper_only",
      ledgerId: "paper-1",
      reason: "recurrence_disabled",
    };
    expect(
      planAuthorizedPaperWorkerPreflightSuccessor(
        payload,
        denied,
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({ status: "stop", ledgerId: "paper-1", reason: "recurrence_denied" });
  });

  it("stops if ledger or gate revision differs from the authorized recurrence scope", () => {
    expect(
      planAuthorizedPaperWorkerPreflightSuccessor(
        payload,
        { ...ready, gateRevision: 8 },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "recurrence_scope_changed",
    });
    expect(
      planAuthorizedPaperWorkerPreflightSuccessor(
        payload,
        { ...ready, ledgerId: "paper-2" },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "recurrence_scope_changed",
    });
  });
});
