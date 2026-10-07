import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handleVerifiedPaperWorkerAutomaticStops } from "./paper-worker-protective-stop.js";
import type { capturePublicPaperSpotEvidence } from "./trading-paper-public-capture.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-07T12:00:00.000Z",
};
const now = new Date("2026-10-07T12:01:00.000Z");
const prisma = {} as PrismaClient;
const owner = { spaceId: "space-1", userId: "user-1" };
const readyWake = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  cadenceMinutes: 15,
  policyRevision: 3,
  gateRevision: 7,
  workerApprovalEffectId: "worker-approval",
  paperApprovalEffectId: "paper-approval",
};
const candidate = {
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  positionId: "position-1",
  signalId: "signal-1",
  venue: "okx" as const,
  symbol: "SOL-USDT",
  quantityBase: "1",
  stopPriceQuote: "95",
  policyRevision: 3,
  gateRevision: 7,
  signalRevision: 2,
  fillRevision: 4,
  targetRevision: 5,
  fillApprovalEffectId: "fill-approval",
  targetApprovalEffectId: "target-approval",
  fillEventSequence: 8,
};
const candidatePreflight = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  positions: [candidate],
};

describe("handleVerifiedPaperWorkerAutomaticStops", () => {
  it("rejects an invalid trusted clock before any authority or market read", async () => {
    const readWake = vi.fn();
    const readCandidates = vi.fn();
    const capture = vi.fn();
    const close = vi.fn();

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        new Date("invalid"),
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).rejects.toThrow("Invalid automatic PAPER stop handler clock");
    expect(readWake).not.toHaveBeenCalled();
    expect(readCandidates).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("fails closed before F4 or public evidence when the current D2 worker gate denies", async () => {
    const readWake = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "worker_gate_disabled" as const,
    }));
    const readCandidates = vi.fn();
    const capture = vi.fn();
    const close = vi.fn();

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        now,
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "worker_gate_denied",
      workerReason: "worker_gate_disabled",
      checkedPositions: 0,
    });
    expect(readWake).toHaveBeenCalledWith(prisma, owner, "paper-1", now);
    expect(readCandidates).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("continues without network access when F4 has no automatic positions", async () => {
    const readWake = vi.fn(async () => readyWake);
    const readCandidates = vi.fn(async () => ({
      ...candidatePreflight,
      positions: [],
    }));
    const capture = vi.fn();
    const close = vi.fn();

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        now,
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).resolves.toEqual({
      status: "continue",
      ledgerId: "paper-1",
      checkedPositions: 0,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("uses the F3 position's own venue and symbol and continues when its stop is not triggered", async () => {
    const readWake = vi.fn().mockResolvedValueOnce(readyWake).mockResolvedValueOnce(readyWake);
    const readCandidates = vi
      .fn()
      .mockResolvedValueOnce(candidatePreflight)
      .mockResolvedValueOnce(candidatePreflight);
    const capture = vi.fn(async (..._args: Parameters<typeof capturePublicPaperSpotEvidence>) => ({
      id: `paper-worker:${"a".repeat(64)}`,
      source: "public_adapter_observation" as const,
    }));
    const close = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      reason: "stop_not_triggered" as const,
    }));

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        now,
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).resolves.toEqual({
      status: "continue",
      ledgerId: "paper-1",
      checkedPositions: 1,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const evidenceId = capture.mock.calls[0]?.[4];
    expect(capture).toHaveBeenCalledWith(
      prisma,
      owner,
      "paper-1",
      { venue: "okx", symbol: "SOL-USDT" },
      evidenceId,
    );
    expect(evidenceId).toMatch(/^paper-worker:[0-9a-f]{64}$/u);
    expect(close).toHaveBeenCalledWith(prisma, owner, "paper-1", "position-1", evidenceId);
  });

  it("returns the bounded C2 close and never attempts a second automatic close in the same wake", async () => {
    const secondCandidate = {
      ...candidate,
      positionId: "position-2",
      signalId: "signal-2",
      fillEventSequence: 10,
    };
    const candidates = {
      ...candidatePreflight,
      positions: [candidate, secondCandidate],
    };
    const readWake = vi.fn().mockResolvedValueOnce(readyWake).mockResolvedValueOnce(readyWake);
    const readCandidates = vi
      .fn()
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce(candidates);
    const capture = vi.fn(async () => ({
      id: `paper-worker:${"b".repeat(64)}`,
      source: "public_adapter_observation" as const,
    }));
    const closeResult = {
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
      closedAt: "2026-10-07T12:01:01.000Z",
    };
    const close = vi.fn(async () => closeResult);

    const result = await handleVerifiedPaperWorkerAutomaticStops(
      prisma,
      payload,
      now,
      readWake,
      readCandidates,
      capture,
      close,
    );
    expect(result).toMatchObject({
      status: "close_result",
      ledgerId: "paper-1",
      checkedPositions: 1,
      positionId: "position-1",
      close: closeResult,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not close after a worker authority change during the public capture", async () => {
    const changedWake = { ...readyWake, gateRevision: 8, workerApprovalEffectId: "worker-new" };
    const readWake = vi.fn().mockResolvedValueOnce(readyWake).mockResolvedValueOnce(changedWake);
    const readCandidates = vi
      .fn()
      .mockResolvedValueOnce(candidatePreflight)
      .mockResolvedValueOnce(candidatePreflight);
    const capture = vi.fn(async () => ({
      id: `paper-worker:${"c".repeat(64)}`,
      source: "public_adapter_observation" as const,
    }));
    const close = vi.fn();

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        now,
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "worker_scope_changed",
      checkedPositions: 1,
      positionId: "position-1",
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("does not close after the verified F3 position changes during public capture", async () => {
    const readWake = vi.fn().mockResolvedValueOnce(readyWake).mockResolvedValueOnce(readyWake);
    const readCandidates = vi
      .fn()
      .mockResolvedValueOnce(candidatePreflight)
      .mockResolvedValueOnce({
        ...candidatePreflight,
        positions: [{ ...candidate, stopPriceQuote: "94" }],
      });
    const capture = vi.fn(async () => ({
      id: `paper-worker:${"d".repeat(64)}`,
      source: "public_adapter_observation" as const,
    }));
    const close = vi.fn();

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        now,
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "candidate_scope_changed",
      checkedPositions: 1,
      positionId: "position-1",
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("halts new work on any C2 denial other than a harmless non-triggered stop", async () => {
    const readWake = vi.fn().mockResolvedValueOnce(readyWake).mockResolvedValueOnce(readyWake);
    const readCandidates = vi
      .fn()
      .mockResolvedValueOnce(candidatePreflight)
      .mockResolvedValueOnce(candidatePreflight);
    const capture = vi.fn(async () => ({
      id: `paper-worker:${"e".repeat(64)}`,
      source: "public_adapter_observation" as const,
    }));
    const close = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      reason: "market_spread_exceeded" as const,
    }));

    await expect(
      handleVerifiedPaperWorkerAutomaticStops(
        prisma,
        payload,
        now,
        readWake,
        readCandidates,
        capture,
        close,
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "close_denied",
      checkedPositions: 1,
      positionId: "position-1",
      closeReason: "market_spread_exceeded",
    });
  });
});
