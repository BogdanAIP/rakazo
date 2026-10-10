import { describe, expect, it, vi } from "vitest";
import {
  dispatchBackgroundJob,
  HISTORY_COMPACT_MAX_ATTEMPTS,
  historyCompactJob,
  historyCompactJobKey,
  messagingDeliverJob,
  PAPER_PROTECTION_MAX_ATTEMPTS,
  paperProtectionCheckJob,
  paperProtectionCheckJobKey,
  PAPER_WORKER_PREFLIGHT_MAX_ATTEMPTS,
  paperWorkerPreflightJob,
  paperWorkerPreflightJobKey,
  parseBackgroundJob,
} from "./background-jobs.js";
import type { BackgroundJobHandlers } from "./types.js";

function handlers(): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "paper.protection-check": vi.fn(async () => undefined),
    "paper.worker-preflight": vi.fn(async () => undefined),
  };
}

describe("background job contracts", () => {
  it("validates and dispatches messaging.deliver", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "messaging.deliver", { runId: "run-1" });
    expect(target["messaging.deliver"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(messagingDeliverJob("run-1")).toEqual({
      name: "messaging.deliver",
      payload: { runId: "run-1" },
      replaceKey: "messaging.deliver:run-1",
    });
    expect(messagingDeliverJob()).toEqual({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("validates and dispatches a typed job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.wakeup", {
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
    expect(target["routine.wakeup"]).toHaveBeenCalledWith({
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
  });

  it("rejects unknown names and malformed deliveries", () => {
    expect(() => parseBackgroundJob("unknown", {})).toThrow("Unknown background job");
    expect(() =>
      parseBackgroundJob("routine.wakeup", {
        routineId: "routine-1",
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
    expect(() => parseBackgroundJob("run.continue", { runId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob("computer.control-expire", {
        computerId: "computer-1",
        leaseId: "",
      }),
    ).toThrow();
  });

  it("validates and dispatches a control-expiry job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "computer.control-expire", {
      computerId: "computer-1",
      leaseId: "lease-1",
    });
    expect(target["computer.control-expire"]).toHaveBeenCalledWith({
      computerId: "computer-1",
      leaseId: "lease-1",
    });
  });
});

describe("H2b2 PAPER protection-only job contract", () => {
  it("builds a separate finite protection wake and validates required owner revisions", async () => {
    const scheduledFor = new Date("2026-10-10T12:00:00.000Z");
    const job = paperProtectionCheckJob({
      ledgerId: "paper-1",
      spaceId: "space-1",
      userId: "user-1",
      gateRevision: 7,
      leaseRevision: 12,
      scheduledFor,
    });
    expect(job.name).toBe("paper.protection-check");
    expect(job.payload).toMatchObject({ gateRevision: 7, leaseRevision: 12 });
    expect(job.replaceKey).toBe(paperProtectionCheckJobKey("paper-1"));
    expect(job.replaceKey).not.toBe(paperWorkerPreflightJobKey("paper-1"));
    expect(job.maxAttempts).toBe(PAPER_PROTECTION_MAX_ATTEMPTS);
    const target = handlers();
    await dispatchBackgroundJob(target, job.name, job.payload);
    expect(target["paper.protection-check"]).toHaveBeenCalledWith(job.payload);
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseBackgroundJob(job.name, { ...job.payload, leaseRevision: revision }),
      ).toThrow();
    }
  });
});

describe("paperWorkerPreflightJob", () => {
  it("builds and dispatches a typed read-only job without a recurrence contract", async () => {
    const scheduledFor = new Date("2026-10-05T12:00:00.000Z");
    const job = paperWorkerPreflightJob({
      ledgerId: "paper-1",
      spaceId: "space-1",
      userId: "user-1",
      gateRevision: 7,
      scheduledFor,
    });
    expect(job).toEqual({
      name: "paper.worker-preflight",
      payload: {
        ledgerId: "paper-1",
        spaceId: "space-1",
        userId: "user-1",
        gateRevision: 7,
        scheduledFor: scheduledFor.toISOString(),
      },
      availableAt: scheduledFor,
      replaceKey: paperWorkerPreflightJobKey("paper-1"),
      maxAttempts: PAPER_WORKER_PREFLIGHT_MAX_ATTEMPTS,
    });
    expect(PAPER_WORKER_PREFLIGHT_MAX_ATTEMPTS).toBeLessThan(25);

    const target = handlers();
    await dispatchBackgroundJob(target, job.name, job.payload);
    expect(target["paper.worker-preflight"]).toHaveBeenCalledWith(job.payload);
  });

  it("pins an explicitly started PAPER session revision to each queued wake", () => {
    const scheduledFor = new Date("2026-10-08T19:15:00.000Z");
    const job = paperWorkerPreflightJob({
      ledgerId: "paper-1",
      spaceId: "space-1",
      userId: "user-1",
      gateRevision: 7,
      sessionRevision: 12,
      scheduledFor,
    });
    const verified = parseBackgroundJob(job.name, job.payload);
    expect(verified.payload).toMatchObject({
      ledgerId: "paper-1",
      gateRevision: 7,
      sessionRevision: 12,
    });
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseBackgroundJob("paper.worker-preflight", {
          ...job.payload,
          sessionRevision: invalid,
        }),
      ).toThrow();
    }
  });

  it("rejects malformed worker scope before dispatch", () => {
    expect(() =>
      parseBackgroundJob("paper.worker-preflight", {
        ledgerId: "paper-1",
        spaceId: "space-1",
        userId: "user-1",
        gateRevision: -1,
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
  });
});

describe("historyCompactJob", () => {
  it("builds a job with a replace key scoped to the thread", () => {
    expect(historyCompactJob("thread-1")).toEqual({
      name: "history.compact",
      payload: { threadId: "thread-1" },
      replaceKey: historyCompactJobKey("thread-1"),
      maxAttempts: HISTORY_COMPACT_MAX_ATTEMPTS,
    });
  });

  it("caps attempts below the queue default so a stuck thread cannot storm", () => {
    expect(HISTORY_COMPACT_MAX_ATTEMPTS).toBeLessThan(25);
  });

  it("keys different threads differently", () => {
    expect(historyCompactJobKey("thread-1")).not.toBe(historyCompactJobKey("thread-2"));
  });
});
