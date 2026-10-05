import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handlePaperWorkerPreflightWithSuccessor } from "./paper-worker-recurring-handler.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-05T12:00:00.000Z",
};

const deps = {
  prisma: {} as PrismaClient,
  jobs: { enqueue: vi.fn(async () => undefined) } as Pick<JobPublisher, "enqueue">,
};

describe("handlePaperWorkerPreflightWithSuccessor", () => {
  it("stops before recurrence when D2 denies", async () => {
    const handle = vi.fn(async () => ({ status: "deny" as const, reason: "worker_gate_disabled" }));
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        handle,
        enqueue,
      ),
    ).resolves.toEqual({
      status: "stop",
      preflight: { status: "deny", reason: "worker_gate_disabled" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops before recurrence when D2 sees a stale gate revision", async () => {
    const handle = vi.fn(async () => ({ status: "stale_gate_revision" as const }));
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        handle,
        enqueue,
      ),
    ).resolves.toEqual({
      status: "stop",
      preflight: { status: "stale_gate_revision" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("calls D9 exactly once only after a ready D2 preflight", async () => {
    const handle = vi.fn(async () => ({
      status: "ready" as const,
      gateRevision: 7,
      cadenceMinutes: 15,
    }));
    const enqueue = vi.fn(async () => ({
      status: "enqueued" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    }));
    const now = new Date("2026-10-05T12:01:00.000Z");

    await expect(
      handlePaperWorkerPreflightWithSuccessor(deps, payload, now, handle, enqueue),
    ).resolves.toEqual({
      status: "ready",
      preflight: { status: "ready", gateRevision: 7, cadenceMinutes: 15 },
      successor: {
        status: "enqueued",
        ledgerId: "paper-1",
        gateRevision: 7,
        scheduledFor: "2026-10-05T12:15:00.000Z",
      },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(deps, payload, now);
  });

  it("keeps a recurrence denial inert after a ready D2 preflight", async () => {
    const handle = vi.fn(async () => ({
      status: "ready" as const,
      gateRevision: 7,
      cadenceMinutes: 15,
    }));
    const enqueue = vi.fn(async () => ({
      status: "stop" as const,
      ledgerId: "paper-1",
      reason: "recurrence_denied" as const,
    }));

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        handle,
        enqueue,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      successor: { status: "stop", reason: "recurrence_denied" },
    });
  });

  it("propagates queue uncertainty from D9", async () => {
    const handle = vi.fn(async () => ({
      status: "ready" as const,
      gateRevision: 7,
      cadenceMinutes: 15,
    }));
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        new Date("2026-10-05T12:01:00.000Z"),
        handle,
        enqueue,
      ),
    ).rejects.toThrow("queue unavailable");
  });

  it("rejects an invalid trusted clock before D2", async () => {
    const handle = vi.fn();
    const enqueue = vi.fn();
    await expect(
      handlePaperWorkerPreflightWithSuccessor(deps, payload, new Date("invalid"), handle, enqueue),
    ).rejects.toThrow("Invalid recurring paper worker handler clock");
    expect(handle).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
