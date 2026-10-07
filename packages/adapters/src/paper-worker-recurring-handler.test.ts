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
const researchResult = {
  status: "history_unavailable" as const,
  venue: "okx" as const,
  symbol: "SOL-USDT",
};

describe("handlePaperWorkerPreflightWithSuccessor", () => {
  it("stops before observation, research and recurrence when D2 denies", async () => {
    const handle = vi.fn(async () => ({ status: "deny" as const, reason: "worker_gate_disabled" }));
    const observe = vi.fn();
    const research = vi.fn();
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        handle,
        enqueue,
        observe,
        research,
      ),
    ).resolves.toEqual({
      status: "stop",
      stage: "preflight",
      preflight: { status: "deny", reason: "worker_gate_disabled" },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops before observation, research and recurrence for a stale D2 gate", async () => {
    const handle = vi.fn(async () => ({ status: "stale_gate_revision" as const }));
    const observe = vi.fn();
    const research = vi.fn();
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        handle,
        enqueue,
        observe,
        research,
      ),
    ).resolves.toEqual({
      status: "stop",
      stage: "preflight",
      preflight: { status: "stale_gate_revision" },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops before research and recurrence when the approved market target is unavailable", async () => {
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
    const research = vi.fn();
    const enqueue = vi.fn();

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        handle,
        enqueue,
        observe,
        research,
      ),
    ).resolves.toEqual({
      status: "stop",
      stage: "observation",
      preflight: readyPreflight,
      observation,
    });
    expect(observe).toHaveBeenCalledWith(deps.prisma, payload, now);
    expect(research).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("runs research before enqueuing the successor", async () => {
    const handle = vi.fn(async () => readyPreflight);
    const observe = vi.fn(async () => observed);
    const research = vi.fn(async () => researchResult);
    const enqueue = vi.fn(async () => ({
      status: "enqueued" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    }));

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        handle,
        enqueue,
        observe,
        research,
      ),
    ).resolves.toEqual({
      status: "ready",
      preflight: readyPreflight,
      observation: observed,
      research: researchResult,
      successor: {
        status: "enqueued",
        ledgerId: "paper-1",
        gateRevision: 7,
        scheduledFor: "2026-10-05T12:15:00.000Z",
      },
    });
    expect(research).toHaveBeenCalledWith(deps.prisma, payload, observed, now);
    expect(enqueue).toHaveBeenCalledWith(deps, payload, now);
    expect(research.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]!);
  });

  it("keeps an observation-only BingX target recurring without inventing research", async () => {
    const bingxObservation = {
      ...observed,
      targetPreflight: { ...observed.targetPreflight, venue: "bingx" as const },
      target: { venue: "bingx" as const, symbol: "SOL-USDT" },
    };
    const bingxResearch = {
      status: "unsupported_target" as const,
      venue: "bingx" as const,
      symbol: "SOL-USDT",
    };
    const enqueue = vi.fn(async () => ({
      status: "enqueued" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    }));

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        vi.fn(async () => readyPreflight),
        enqueue,
        vi.fn(async () => bingxObservation),
        vi.fn(async () => bingxResearch),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      research: bingxResearch,
      successor: { status: "enqueued" },
    });
  });

  it("keeps recurrence denial inert after research", async () => {
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
        vi.fn(async () => researchResult),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      observation: { status: "observed" },
      research: researchResult,
      successor: { status: "stop", reason: "recurrence_denied" },
    });
  });

  it("propagates public observation uncertainty before research and successor enqueue", async () => {
    const enqueue = vi.fn();
    const research = vi.fn();
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
        research,
      ),
    ).rejects.toThrow("public market unavailable");
    expect(research).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates research integrity uncertainty before successor enqueue", async () => {
    const enqueue = vi.fn();
    const research = vi.fn(async () => {
      throw new Error("research integrity mismatch");
    });
    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        now,
        vi.fn(async () => readyPreflight),
        enqueue,
        vi.fn(async () => observed),
        research,
      ),
    ).rejects.toThrow("research integrity mismatch");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates successor queue uncertainty after durable observation and research", async () => {
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
        vi.fn(async () => researchResult),
      ),
    ).rejects.toThrow("queue unavailable");
  });

  it("rejects an invalid trusted clock before preflight, observation, research or recurrence", async () => {
    const handle = vi.fn();
    const observe = vi.fn();
    const research = vi.fn();
    const enqueue = vi.fn();
    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        deps,
        payload,
        new Date("invalid"),
        handle,
        enqueue,
        observe,
        research,
      ),
    ).rejects.toThrow("Invalid recurring paper worker handler clock");
    expect(handle).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
