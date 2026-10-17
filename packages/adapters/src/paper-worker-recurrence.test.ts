import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { planPaperWorkerPreflightSuccessor } from "./paper-worker-recurrence.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-05T12:00:00.000Z",
};

describe("planPaperWorkerPreflightSuccessor", () => {
  it("plans the next typed preflight without enqueueing", () => {
    expect(
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "ready", gateRevision: 7, cadenceMinutes: 15 },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({
      status: "planned",
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
      job: {
        name: "paper.worker-preflight",
        payload: {
          ledgerId: "paper-1",
          spaceId: "space-1",
          userId: "user-1",
          gateRevision: 7,
          scheduledFor: "2026-10-05T12:15:00.000Z",
        },
        availableAt: new Date("2026-10-05T12:15:00.000Z"),
        replaceKey: "paper.worker-preflight:paper-1",
        maxAttempts: 3,
      },
    });
  });

  it("skips missed intervals instead of burst replay", () => {
    expect(
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "ready", gateRevision: 7, cadenceMinutes: 15 },
        new Date("2026-10-05T12:46:00.000Z"),
      ),
    ).toMatchObject({
      status: "planned",
      scheduledFor: "2026-10-05T13:00:00.000Z",
    });
  });

  it("plans nothing for deny, stale result, or changed revision", () => {
    expect(
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "deny", reason: "worker_gate_disabled" },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({ status: "stop", ledgerId: "paper-1", reason: "preflight_denied" });
    expect(
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "stale_gate_revision" },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({ status: "stop", ledgerId: "paper-1", reason: "stale_gate_revision" });
    expect(
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "ready", gateRevision: 8, cadenceMinutes: 15 },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toEqual({ status: "stop", ledgerId: "paper-1", reason: "stale_gate_revision" });
  });

  it("rejects invalid clock or verified cadence", () => {
    expect(() =>
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "ready", gateRevision: 7, cadenceMinutes: 4 },
        new Date("2026-10-05T12:01:00.000Z"),
      ),
    ).toThrow("Invalid verified paper worker cadence");
    expect(() =>
      planPaperWorkerPreflightSuccessor(
        payload,
        { status: "ready", gateRevision: 7, cadenceMinutes: 15 },
        new Date("invalid"),
      ),
    ).toThrow("Invalid paper worker recurrence clock");
  });
});
