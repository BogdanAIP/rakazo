import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PaperProtectionSuccessorIntentResult, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { enqueueAuthorizedPaperProtectionSuccessor } from "./paper-protection-only-scheduler.js";

const payload = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  leaseRevision: 3,
  scheduledFor: "2026-10-10T12:00:00.000Z",
};
const planned: Extract<PaperProtectionSuccessorIntentResult, { status: "prepared" | "duplicate" }> =
  {
    status: "prepared",
    mode: "paper_only",
    ...payload,
    sourceScheduledFor: payload.scheduledFor,
    successorScheduledFor: "2026-10-10T12:15:00.000Z",
    approvalEffectId: "owner-approved-protection",
  };

describe("H2b2 protection successor scheduler", () => {
  it("persists owner-scoped protection-only intent before separately keyed queue publication", async () => {
    const order: string[] = [];
    const prepare = vi.fn(async () => {
      order.push("intent");
      return planned;
    });
    const enqueue = vi.fn(async () => {
      order.push("enqueue");
    });
    const db = {} as PrismaClient;
    const result = await enqueueAuthorizedPaperProtectionSuccessor(
      { prisma: db, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
      payload,
      prepare,
    );
    expect(order).toEqual(["intent", "enqueue"]);
    expect(prepare).toHaveBeenCalledWith(
      db,
      { spaceId: "space-1", userId: "user-1" },
      {
        ledgerId: payload.ledgerId,
        leaseRevision: 3,
        gateRevision: 7,
        sourceScheduledFor: payload.scheduledFor,
      },
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "paper.protection-check",
        payload: expect.objectContaining({ leaseRevision: 3, gateRevision: 7 }),
      }),
    );
    expect(result).toMatchObject({ status: "enqueued", leaseRevision: 3 });
  });

  it("does not enqueue when the owner lease ended, there are no positions, or the deadline arrives", async () => {
    for (const reason of ["lease_denied", "no_open_positions", "next_after_expiry"] as const) {
      const enqueue = vi.fn();
      const prepare = vi.fn(async () => ({
        status: "stop" as const,
        mode: "paper_only" as const,
        ledgerId: "paper-1",
        reason,
      }));
      const result = await enqueueAuthorizedPaperProtectionSuccessor(
        { prisma: {} as PrismaClient, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
        payload,
        prepare,
      );
      expect(result).toEqual({ status: "stop", ledgerId: "paper-1", reason });
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it("propagates enqueue failure so the current durable worker job may retry the stored intent", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    await expect(
      enqueueAuthorizedPaperProtectionSuccessor(
        { prisma: {} as PrismaClient, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> },
        payload,
        async () => planned,
      ),
    ).rejects.toThrow("queue unavailable");
  });
});
