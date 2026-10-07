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
  handleAutomaticStops: vi.fn(async () => ({
    status: "continue" as const,
    ledgerId: "paper-1",
    checkedPositions: 0,
  })),
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
const signalResult = {
  status: "stop" as const,
  ledgerId: "paper-1",
  reason: "research_unavailable" as const,
};
const fillResult = {
  status: "stop" as const,
  ledgerId: "paper-1",
  reason: "reservation_unavailable" as const,
};

describe("handlePaperWorkerPreflightWithSuccessor", () => {
  it("stops before observation, research, signal reserve and recurrence when D2 denies", async () => {
    const handle = vi.fn(async () => ({ status: "deny" as const, reason: "worker_gate_disabled" }));
    const observe = vi.fn();
    const research = vi.fn();
    const reserveSignal = vi.fn();
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
        reserveSignal,
      ),
    ).resolves.toEqual({
      status: "stop",
      stage: "preflight",
      preflight: { status: "deny", reason: "worker_gate_disabled" },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops before observation, research, signal reserve and recurrence for a stale D2 gate", async () => {
    const handle = vi.fn(async () => ({ status: "stale_gate_revision" as const }));
    const observe = vi.fn();
    const research = vi.fn();
    const reserveSignal = vi.fn();
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
        reserveSignal,
      ),
    ).resolves.toEqual({
      status: "stop",
      stage: "preflight",
      preflight: { status: "stale_gate_revision" },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("services F5 before new research and schedules the successor after a bounded automatic close", async () => {
    const handleStops = vi.fn(async () => ({
      status: "close_result" as const,
      ledgerId: "paper-1",
      checkedPositions: 1,
      positionId: "position-1",
      evidenceId: `paper-worker:${"f".repeat(64)}`,
      close: {
        status: "closed" as const,
        mode: "paper_only" as const,
        positionId: "position-1",
        signalId: "signal-1",
        closeEventId: "close-1",
        closeEventSequence: 9,
        policyRevision: 3,
        quantityBase: "1",
        executedPriceQuote: "94.9",
        feeQuote: "0.1",
        stopPriceQuote: "95",
        closedAt: "2026-10-05T12:01:01.000Z",
      },
    }));
    const localDeps = { ...deps, handleAutomaticStops: handleStops };
    const observe = vi.fn();
    const research = vi.fn();
    const reserveSignal = vi.fn();
    const fillSignal = vi.fn();
    const enqueue = vi.fn(async () => ({
      status: "enqueued" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      scheduledFor: "2026-10-05T12:15:00.000Z",
    }));

    await expect(
      handlePaperWorkerPreflightWithSuccessor(
        localDeps,
        payload,
        now,
        vi.fn(async () => readyPreflight),
        enqueue,
        observe,
        research,
        reserveSignal,
        fillSignal,
      ),
    ).resolves.toMatchObject({
      status: "stop",
      stage: "protective_stop",
      protectiveStop: {
        status: "close_result",
        positionId: "position-1",
      },
      successor: { status: "enqueued" },
    });
    expect(handleStops).toHaveBeenCalledWith(deps.prisma, payload, now);
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(fillSignal).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(localDeps, payload, now);
    expect(handleStops.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]!);
  });

  it("stops before research, signal reserve and recurrence when the approved market target is unavailable", async () => {
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
    const reserveSignal = vi.fn();
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
        reserveSignal,
      ),
    ).resolves.toEqual({
      status: "stop",
      stage: "observation",
      preflight: readyPreflight,
      observation,
    });
    expect(observe).toHaveBeenCalledWith(deps.prisma, payload, now);
    expect(research).not.toHaveBeenCalled();
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("runs research, then the F1 signal bridge, then enqueues the successor", async () => {
    const handle = vi.fn(async () => readyPreflight);
    const observe = vi.fn(async () => observed);
    const research = vi.fn(async () => researchResult);
    const reserveSignal = vi.fn(async () => signalResult);
    const fillSignal = vi.fn(async () => fillResult);
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
        reserveSignal,
        fillSignal,
      ),
    ).resolves.toEqual({
      status: "ready",
      preflight: readyPreflight,
      observation: observed,
      research: researchResult,
      signal: signalResult,
      fill: fillResult,
      successor: {
        status: "enqueued",
        ledgerId: "paper-1",
        gateRevision: 7,
        scheduledFor: "2026-10-05T12:15:00.000Z",
      },
    });
    expect(research).toHaveBeenCalledWith(deps.prisma, payload, observed, now);
    expect(reserveSignal).toHaveBeenCalledWith(deps.prisma, payload, 2, now);
    expect(fillSignal).toHaveBeenCalledWith(deps.prisma, payload, signalResult, now);
    expect(enqueue).toHaveBeenCalledWith(deps, payload, now);
    expect(research.mock.invocationCallOrder[0]).toBeLessThan(
      reserveSignal.mock.invocationCallOrder[0]!,
    );
    expect(reserveSignal.mock.invocationCallOrder[0]).toBeLessThan(
      fillSignal.mock.invocationCallOrder[0]!,
    );
    expect(fillSignal.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps BingX recurring when its public history is temporarily unavailable", async () => {
    const bingxObservation = {
      ...observed,
      targetPreflight: { ...observed.targetPreflight, venue: "bingx" as const },
      target: { venue: "bingx" as const, symbol: "SOL-USDT" },
    };
    const bingxResearch = {
      status: "history_unavailable" as const,
      venue: "bingx" as const,
      symbol: "SOL-USDT",
    };
    const reserveSignal = vi.fn(async () => signalResult);
    const fillSignal = vi.fn(async () => fillResult);
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
        reserveSignal,
        fillSignal,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      research: bingxResearch,
      signal: signalResult,
      fill: fillResult,
      successor: { status: "enqueued" },
    });
    expect(reserveSignal).toHaveBeenCalledWith(deps.prisma, payload, 2, now);
    expect(fillSignal).toHaveBeenCalledWith(deps.prisma, payload, signalResult, now);
  });

  it("keeps recurrence denial inert after research, signal and fill handling", async () => {
    const reserveSignal = vi.fn(async () => signalResult);
    const fillSignal = vi.fn(async () => fillResult);
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
        reserveSignal,
        fillSignal,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      observation: { status: "observed" },
      research: researchResult,
      signal: signalResult,
      fill: fillResult,
      successor: { status: "stop", reason: "recurrence_denied" },
    });
  });

  it("propagates public observation uncertainty before research, signal reserve and successor enqueue", async () => {
    const enqueue = vi.fn();
    const research = vi.fn();
    const reserveSignal = vi.fn();
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
        reserveSignal,
      ),
    ).rejects.toThrow("public market unavailable");
    expect(research).not.toHaveBeenCalled();
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates research integrity uncertainty before signal reserve and successor enqueue", async () => {
    const enqueue = vi.fn();
    const reserveSignal = vi.fn();
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
        reserveSignal,
      ),
    ).rejects.toThrow("research integrity mismatch");
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates signal integrity uncertainty before successor enqueue", async () => {
    const enqueue = vi.fn();
    const reserveSignal = vi.fn(async () => {
      throw new Error("signal integrity mismatch");
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
        reserveSignal,
      ),
    ).rejects.toThrow("signal integrity mismatch");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates fill integrity uncertainty before successor enqueue", async () => {
    const enqueue = vi.fn();
    const fillSignal = vi.fn(async () => {
      throw new Error("fill integrity mismatch");
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
        vi.fn(async () => signalResult),
        fillSignal,
      ),
    ).rejects.toThrow("fill integrity mismatch");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates successor queue uncertainty after durable observation, research, signal and fill handling", async () => {
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
        vi.fn(async () => signalResult),
        vi.fn(async () => fillResult),
      ),
    ).rejects.toThrow("queue unavailable");
  });

  it("rejects an invalid trusted clock before preflight, observation, research, signal reserve or recurrence", async () => {
    const handle = vi.fn();
    const observe = vi.fn();
    const research = vi.fn();
    const reserveSignal = vi.fn();
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
        reserveSignal,
      ),
    ).rejects.toThrow("Invalid recurring paper worker handler clock");
    expect(handle).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(reserveSignal).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
