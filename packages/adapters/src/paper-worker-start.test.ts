import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { startPaperWorkerPreflightOnce } from "./paper-worker-start.js";

describe("startPaperWorkerPreflightOnce", () => {
  it("forwards only owner scope, ledger and exact gate revision to the one-shot scheduler", async () => {
    const schedule = vi.fn(async () => ({
      status: "enqueued" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    }));
    const deps = {
      prisma: {} as PrismaClient,
      jobs: { enqueue: vi.fn(async () => undefined) } as Pick<JobPublisher, "enqueue">,
    };

    await expect(
      startPaperWorkerPreflightOnce(
        deps,
        { spaceId: "space-1", userId: "user-1" },
        { ledger_id: "paper-1", expected_gate_revision: 7 },
        schedule,
      ),
    ).resolves.toMatchObject({ status: "enqueued", gateRevision: 7 });
    expect(schedule).toHaveBeenCalledWith(deps, {
      spaceId: "space-1",
      userId: "user-1",
      ledgerId: "paper-1",
      expectedGateRevision: 7,
    });
  });

  it("rejects caller-supplied cadence or recurrence fields", async () => {
    const schedule = vi.fn();
    await expect(
      startPaperWorkerPreflightOnce(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue: vi.fn() } as unknown as Pick<JobPublisher, "enqueue">,
        },
        { spaceId: "space-1", userId: "user-1" },
        { ledger_id: "paper-1", expected_gate_revision: 7, cadence_minutes: 1 },
        schedule,
      ),
    ).rejects.toThrow("Unexpected paper worker start fields");
    expect(schedule).not.toHaveBeenCalled();
  });

  it("rejects invalid gate revisions before any queue primitive is reached", async () => {
    const schedule = vi.fn();
    await expect(
      startPaperWorkerPreflightOnce(
        {
          prisma: {} as PrismaClient,
          jobs: { enqueue: vi.fn() } as unknown as Pick<JobPublisher, "enqueue">,
        },
        { spaceId: "space-1", userId: "user-1" },
        { ledger_id: "paper-1", expected_gate_revision: -1 },
        schedule,
      ),
    ).rejects.toThrow("Invalid paper worker start payload");
    expect(schedule).not.toHaveBeenCalled();
  });
});
