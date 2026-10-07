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
const now = new Date("2026-10-05T12:01:00.000Z");
const deps = {
  prisma: {} as PrismaClient,
  jobs: { enqueue: vi.fn(async () => undefined) } as Pick<JobPublisher, "enqueue">,
};
const readyPreflight = {
  status: "ready" as const,
  gateRevision: 7,
  cadenceMinutes: 15,
};
const observed = {
  status: "observed" as const,
  targetPreflight: {
    status: "ready" as const,
    mode: "paper_only" as const,
    ledgerId: "paper-1",
    venue: "okx" as const,
    symbol: "SOL-USDT",
    gateRevision: 7,
    targetRevision: 2,
    targetApprovalEffectId: "target-approval",
    workerApprovalEffectId: "worker-approval",
    paperApprovalEffectId: "paper-approval",
  },
  target: { venue: "okx" as const, symbol: "SOL-USDT" },
  evidence: {
    id: `paper-worker:${"a".repeat(64)}`,
    source: "public_adapter_observation" as const,
  },
};

describe("handlePaperWorkerPreflightWithSuccessor", () => {
  it("stops before observation and recurrence when D2 denies", async () => {
    const handle = vi.fn(async () => ({ status: "deny" as const, reason: "worker_gate_disabled" }));
    const observe = vi.fn();
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(deps, payload, now, handle, enqueue, observe),
    ).resolves.toEqual({
      status: "stop",
      stage: "preflight",
      preflight: { status: "deny", reason: "worker_gate_disabled" },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops before observation and recurrence for a stale D2 gate", async () => {
    const handle = vi.fn(async () => ({ status: "stale_gate_revision" as const }));
    const observe = vi.fn();
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(deps, payload, now, handle, enqueue, observe),
    ).resolves.toEqual({
      status: "stop",
      stage: "preflight",
      preflight: { status: "stale_gate_revision" },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops recurrence when the approved market target is unavailable", async () => {
    const handle = vi.fn(async () => readyPreflight);
    const observation = {
      status: "stop" as const,
      reason: "target_denied" as const,
      targetPreflight: {
        status: "deny" as const,
        mode: "paper_only" as const,
        ledgerId: "paper-1",
        reason: "target_disabled" as const,
      },
    };
    const observe = vi.fn(async () => observation);
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(deps, payload, now, handle, enqueue, observe),
    ).resolves.toEqual({
      status: "stop",
      stage: "observation",
      preflight: readyPreflight,
      observation,
    });
    expect(observe).toHaveBeenCalledWith(deps.prisma, payload, now);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues the successor only after one successful public observation", async () => {
    const handle = vi.fn(async () => readyPreflight);
    const observe = vi.fn(async () => observed);
    const enqueue = vi.fn(async () => ({
      status: "enqueued" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    }));

    await expect(
      handlePaperWorkerPreflightWithSuccessor(deps, payload, now, handle, enqueue, observe),
    ).resolves.toEqual({
      status: "ready",
      preflight: readyPreflight,
      observation: observed,
      successor: {
        status: "enqueued",
        ledgerId: "paper-1",
        gateRevision: 7,
        scheduledFor: "2026-10-05T12:15:00.000Z",
      },
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(deps, payload, now);
  });

  it("keeps recurrence denial inert after a successful observation", async () => {
    const enqueue = vi.fn(async () => ({
      status: "stop" as const,
      ledgerId: "paper-1",
      reason: "recurrence_denied" as const,
    }));

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        vi.fn(async () => readyPreflight),
        enqueue,
        vi.fn(async () => observed),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      observation: { status: "observed" },
      successor: { status: "stop", reason: "recurrence_denied" },
    });
  });

  it("propagates public observation uncertainty before successor enqueue", async () => {
    const enqueue = vi.fn();
    const observe = vi.fn(async () => {
      throw new Error("public market unavailable");
    });
    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        vi.fn(async () => readyPreflight),
        enqueue,
        observe,
      ),
    ).rejects.toThrow("public market unavailable");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates successor queue uncertainty after durable observation", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        vi.fn(async () => readyPreflight),
        enqueue,
        vi.fn(async () => observed),
      ),
    ).rejects.toThrow("queue unavailable");
  });

  it("rejects an invalid trusted clock before preflight, observation or recurrence", async () => {
    const handle = vi.fn();
    const observe = vi.fn();
    const enqueue = vi.fn();
    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        new Date("invalid"),
        handle,
        enqueue,
        observe,
      ),
    ).rejects.toThrow("Invalid recurring paper worker handler clock");
    expect(handle).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
