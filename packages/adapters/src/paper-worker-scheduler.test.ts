import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { enqueuePaperWorkerPreflightOnce } from "./paper-worker-scheduler.js";

describe("enqueuePaperWorkerPreflightOnce", () => {
  it("enqueues one delayed read-only preflight for the exact gate revision", async () => {
    const enqueue = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      cadenceMinutes: 15,
      policyRevision: 2,
      gateRevision: 7,
      workerApprovalEffectId: "worker-effect",
      paperApprovalEffectId: "paper-effect",
    }));
    const prisma = {} as PrismaClient;
    const now = new Date("2026-10-05T12:00:00.000Z");
    await expect(
      enqueuePaperWorkerPreflightOnce(
        { prisma, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
        {
          spaceId: "space-1",
          userId: "user-1",
          ledgerId: "paper-1",
          expectedGateRevision: 7,
          now,
        },
        read,
      ),
    ).resolves.toEqual({
      status: "enqueued",
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    });
    expect(read).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      now,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
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
    });
  });

  it("does not enqueue when current preflight denies", async () => {
    const enqueue = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "worker_gate_disabled" as const,
    }));
    await expect(
      enqueuePaperWorkerPreflightOnce(
        { prisma: {} as PrismaClient, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
        {
          spaceId: "space-1",
          userId: "user-1",
          ledgerId: "paper-1",
          expectedGateRevision: 7,
          now: new Date("2026-10-05T12:00:00.000Z"),
        },
        read,
      ),
    ).resolves.toEqual({ status: "deny", ledgerId: "paper-1", reason: "worker_gate_disabled" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when the caller gate revision is stale", async () => {
    const enqueue = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      cadenceMinutes: 15,
      policyRevision: 2,
      gateRevision: 8,
      workerApprovalEffectId: "worker-effect-2",
      paperApprovalEffectId: "paper-effect",
    }));
    await expect(
      enqueuePaperWorkerPreflightOnce(
        { prisma: {} as PrismaClient, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
        {
          spaceId: "space-1",
          userId: "user-1",
          ledgerId: "paper-1",
          expectedGateRevision: 7,
          now: new Date("2026-10-05T12:00:00.000Z"),
        },
        read,
      ),
    ).resolves.toEqual({
      status: "stale_gate_revision",
      ledgerId: "paper-1",
      expectedGateRevision: 7,
      currentGateRevision: 8,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates queue failure and never creates recurrence", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const read = vi.fn(async () => ({
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      cadenceMinutes: 5,
      policyRevision: 2,
      gateRevision: 7,
      workerApprovalEffectId: "worker-effect",
      paperApprovalEffectId: "paper-effect",
    }));
    await expect(
      enqueuePaperWorkerPreflightOnce(
        { prisma: {} as PrismaClient, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
        {
          spaceId: "space-1",
          userId: "user-1",
          ledgerId: "paper-1",
          expectedGateRevision: 7,
          now: new Date("2026-10-05T12:00:00.000Z"),
        },
        read,
      ),
    ).rejects.toThrow("queue unavailable");
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
