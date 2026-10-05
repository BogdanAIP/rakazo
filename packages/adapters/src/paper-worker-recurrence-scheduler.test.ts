import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, TradingPaperWorkerRecurrencePreflight } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { enqueueAuthorizedPaperWorkerSuccessor } from "./paper-worker-recurrence-scheduler.js";

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

describe("enqueueAuthorizedPaperWorkerSuccessor", () => {
  it("rechecks D7 and enqueues exactly one planned successor", async () => {
    const enqueue = vi.fn(async () => undefined);
    const read = vi.fn(async () => ready);
    const deps = {
      prisma: {} as PrismaClient,
      jobs: { enqueue } as Pick<JobPublisher, "enqueue">,
    };

    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        deps,
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        read,
      ),
    ).resolves.toEqual({
      status: "enqueued",
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    });
    expect(read).toHaveBeenCalledWith(
      deps.prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      new Date("2026-10-05T12:01:00.000Z"),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "paper.worker-preflight",
        replaceKey: "paper.worker-preflight:paper-1",
      }),
    );
  });

  it("does not enqueue when recurrence is denied", async () => {
    const enqueue = vi.fn();
    const denied: TradingPaperWorkerRecurrencePreflight = {
      status: "deny",
      mode: "paper_only",
      ledgerId: "paper-1",
      reason: "recurrence_disabled",
    };
    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue } as unknown as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        vi.fn(async () => denied),
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "recurrence_denied",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when the authorized recurrence scope changed", async () => {
    const enqueue = vi.fn();
    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue } as unknown as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        vi.fn(async () => ({ ...ready, gateRevision: 8 })),
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "recurrence_scope_changed",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates queue uncertainty instead of claiming success", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue } as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        vi.fn(async () => ready),
      ),
    ).rejects.toThrow("queue unavailable");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid trusted clock before reading state", async () => {
    const read = vi.fn();
    await expect(
      enqueueAuthorizedPaperWorkerSuccessor(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue: vi.fn() } as unknown as Pick<JobPublisher, "enqueue">,
        },
        payload,
        new Date("invalid"),
        read,
      ),
    ).rejects.toThrow("Invalid authorized paper worker successor clock");
    expect(read).not.toHaveBeenCalled();
  });
});
