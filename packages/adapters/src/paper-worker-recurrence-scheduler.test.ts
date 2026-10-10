import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, TradingPaperWorkerSuccessorIntentResult } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { enqueueAuthorizedPaperWorkerSuccessor } from "./paper-worker-recurrence-scheduler.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-05T12:00:00.000Z",
};

const prepared: TradingPaperWorkerSuccessorIntentResult = {
  status: "prepared",
  mode: "paper_only",
  ledgerId: "paper-1",
  gateRevision: 7,
  recurrenceRevision: 3,
  sourceScheduledFor: "2026-10-05T12:00:00.000Z",
  successorScheduledFor: "2026-10-05T12:15:00.000Z",
  recurrenceApprovalEffectId: "recurrence-effect",
  workerApprovalEffectId: "worker-effect",
  paperApprovalEffectId: "paper-effect",
};

describe("enqueueAuthorizedPaperWorkerSuccessor", () => {
  it("persists D11 intent before enqueueing the exact stored successor", async () => {
    const enqueue = vi.fn(async (_job: unknown) => undefined);
    const prepareIntent = vi.fn(async () => prepared);
    const deps = {
      prisma: {} as PrismaClient,
      jobs: { enqueue } as Pick<JobPublisher, "enqueue">,
    };
    const now = new Date("2026-10-05T12:01:00.000Z");

    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(deps, payload, now, prepareIntent),
    ).resolves.toEqual({
      status: "enqueued",
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    });
    expect(prepareIntent).toHaveBeenCalledWith(
      deps.prisma,
      { spaceId: "space-1", userId: "user-1" },
      {
        ledgerId: "paper-1",
        sourceScheduledFor: "2026-10-05T12:00:00.000Z",
        gateRevision: 7,
        now,
      },
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "paper.worker-preflight",
        payload: expect.objectContaining({
          ledgerId: "paper-1",
          gateRevision: 7,
          scheduledFor: "2026-10-05T12:15:00.000Z",
        }),
        availableAt: new Date("2026-10-05T12:15:00.000Z"),
        replaceKey: "paper.worker-preflight:paper-1",
      }),
    );
  });

  it("propagates the original finite-session revision into D11 and the successor job", async () => {
    const enqueue = vi.fn(async (_job: unknown) => undefined);
    const prepareIntent = vi.fn(async () => prepared);
    const deps = {
      prisma: {} as PrismaClient,
      jobs: { enqueue } as Pick<JobPublisher, "enqueue">,
    };
    const now = new Date("2026-10-05T12:01:00.000Z");
    const boundPayload = { ...payload, sessionRevision: 42 };

    await enqueueAuthorizedPaperWorkerSuccessor(deps, boundPayload, now, prepareIntent);
    expect(prepareIntent).toHaveBeenCalledWith(
      deps.prisma,
      { spaceId: "space-1", userId: "user-1" },
      {
        ledgerId: "paper-1",
        sourceScheduledFor: payload.scheduledFor,
        gateRevision: 7,
        sessionRevision: 42,
        now,
      },
    );
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      payload: { ledgerId: "paper-1", sessionRevision: 42 },
    });
  });

  it("re-enqueues the same stored schedule on an idempotent D11 replay", async () => {
    const enqueue = vi.fn(async (_job: unknown) => undefined);
    const prepareIntent = vi.fn(async () => ({ ...prepared, status: "duplicate" as const }));
    const deps = {
      prisma: {} as PrismaClient,
      jobs: { enqueue } as Pick<JobPublisher, "enqueue">,
    };

    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        deps,
        payload,
        new Date("2026-10-05T12:14:59.000Z"),
        prepareIntent,
      ),
    ).resolves.toMatchObject({
      status: "enqueued",
      scheduledFor: "2026-10-05T12:15:00.000Z",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      payload: { scheduledFor: "2026-10-05T12:15:00.000Z" },
    });
  });

  it("does not enqueue when durable intent preparation denies recurrence", async () => {
    const enqueue = vi.fn();
    const stopped: TradingPaperWorkerSuccessorIntentResult = {
      status: "stop",
      mode: "paper_only",
      ledgerId: "paper-1",
      reason: "recurrence_denied",
      recurrenceReason: "recurrence_disabled",
    };

    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue } as unknown as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        vi.fn(async () => stopped),
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "recurrence_denied",
      recurrenceReason: "recurrence_disabled",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when the authorized recurrence scope changed", async () => {
    const enqueue = vi.fn();
    const stopped: TradingPaperWorkerSuccessorIntentResult = {
      status: "stop",
      mode: "paper_only",
      ledgerId: "paper-1",
      reason: "recurrence_scope_changed",
      currentGateRevision: 8,
    };

    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue } as unknown as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        vi.fn(async () => stopped),
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "recurrence_scope_changed",
      currentGateRevision: 8,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates queue uncertainty after the durable intent exists", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const prepareIntent = vi.fn(async () => prepared);

    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue } as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        prepareIntent,
      ),
    ).rejects.toThrow("queue unavailable");
    expect(prepareIntent).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid trusted clock before persisting intent", async () => {
    const prepareIntent = vi.fn();
    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue: vi.fn() } as unknown as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("invalid"),
        prepareIntent,
      ),
    ).rejects.toThrow("Invalid authorized paper worker successor clock");
    expect(prepareIntent).not.toHaveBeenCalled();
  });
});
