import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { fillReservedPaperWorkerProposal } from "./paper-worker-fill.js";
import type { PaperWorkerSignalReservationResult } from "./paper-worker-signal-reservation.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-07T12:00:00.000Z",
};
const now = new Date("2026-10-07T12:01:00.000Z");
const prisma = {} as PrismaClient;
const signal: PaperWorkerSignalReservationResult = {
  status: "reserve_result",
  ledgerId: "paper-1",
  signalId: "signal-1",
  reserve: {
    status: "reserved",
    mode: "paper_only",
    signalId: "signal-1",
    reservationId: "paper-resv:1",
    eventId: "paper-event:1",
    eventSequence: 1,
    policyRevision: 3,
    quantityBase: "1",
    heldQuote: "101",
    worstCaseStopRiskQuote: "5",
    stopPriceQuote: "95",
    expiresAt: "2026-10-07T12:02:00.000Z",
  },
};
const readyFill = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  strategyId: "breakout_20_1h_v1" as const,
  policyRevision: 3,
  gateRevision: 7,
  signalRevision: 2,
  fillRevision: 4,
  fillApprovalEffectId: "fill-approval",
  signalApprovalEffectId: "signal-approval",
  workerApprovalEffectId: "worker-approval",
  paperApprovalEffectId: "paper-approval",
};
const readyTarget = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  venue: "okx" as const,
  symbol: "SOL-USDT",
  gateRevision: 7,
  targetRevision: 3,
  targetApprovalEffectId: "target-approval",
  workerApprovalEffectId: "worker-approval",
  paperApprovalEffectId: "paper-approval",
};

describe("fillReservedPaperWorkerProposal", () => {
  it("does nothing when F1 did not produce a reservation", async () => {
    const readFill = vi.fn();
    const readTarget = vi.fn();
    const capture = vi.fn();
    const fill = vi.fn();
    await expect(
      fillReservedPaperWorkerProposal(
        prisma,
        payload,
        { status: "stop", ledgerId: "paper-1", reason: "no_trade", signalId: "signal-1" },
        now,
        readFill,
        readTarget,
        capture,
        fill,
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      reason: "reservation_unavailable",
    });
    expect(readFill).not.toHaveBeenCalled();
    expect(readTarget).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it("stops before public market access when F2 denies", async () => {
    const readTarget = vi.fn();
    const capture = vi.fn();
    const fill = vi.fn();
    await expect(
      fillReservedPaperWorkerProposal(
        prisma,
        payload,
        signal,
        now,
        vi.fn(async () => ({
          status: "deny" as const,
          mode: "paper_only" as const,
          ledgerId: "paper-1",
          reason: "fill_gate_disabled" as const,
        })),
        readTarget,
        capture,
        fill,
      ),
    ).resolves.toMatchObject({
      status: "stop",
      reason: "fill_gate_denied",
      fillReason: "fill_gate_disabled",
      reservationId: "paper-resv:1",
    });
    expect(readTarget).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it("stops before fresh capture when the approved target is denied", async () => {
    const capture = vi.fn();
    const fill = vi.fn();
    await expect(
      fillReservedPaperWorkerProposal(
        prisma,
        payload,
        signal,
        now,
        vi.fn(async () => readyFill),
        vi.fn(async () => ({
          status: "deny" as const,
          mode: "paper_only" as const,
          ledgerId: "paper-1",
          reason: "target_disabled" as const,
        })),
        capture,
        fill,
      ),
    ).resolves.toMatchObject({
      status: "stop",
      reason: "target_denied",
      targetReason: "target_disabled",
    });
    expect(capture).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it("captures one deterministic fresh quote, rechecks F2/target, then calls C1", async () => {
    const readFill = vi.fn(async () => readyFill);
    const readTarget = vi.fn(async () => readyTarget);
    const capture = vi.fn(async (_prisma, _owner, _ledgerId, _target, evidenceId) => ({
      id: evidenceId!,
      source: "public_adapter_observation" as const,
    }));
    const fill = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      reason: "price_beyond_reserve_cap" as const,
    }));

    const result = await fillReservedPaperWorkerProposal(
      prisma,
      payload,
      signal,
      now,
      readFill,
      readTarget,
      capture,
      fill,
    );
    expect(result).toMatchObject({
      status: "fill_result",
      ledgerId: "paper-1",
      reservationId: "paper-resv:1",
      fill: { status: "deny", reason: "price_beyond_reserve_cap" },
    });
    if (result.status !== "fill_result") throw new Error("expected fill result");
    expect(result.evidenceId).toMatch(/^paper-worker:[a-f0-9]{64}$/u);
    expect(readFill).toHaveBeenCalledTimes(2);
    expect(readTarget).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      { venue: "okx", symbol: "SOL-USDT" },
      result.evidenceId,
    );
    expect(fill).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      "paper-resv:1",
      result.evidenceId,
      readyFill,
    );
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(fill.mock.invocationCallOrder[0]!);
  });

  it("does not call C1 if F2 changes while the fresh quote is being obtained", async () => {
    const readFill = vi
      .fn()
      .mockResolvedValueOnce(readyFill)
      .mockResolvedValueOnce({ ...readyFill, fillRevision: 5, fillApprovalEffectId: "fill-new" });
    const fill = vi.fn();
    await expect(
      fillReservedPaperWorkerProposal(
        prisma,
        payload,
        signal,
        now,
        readFill,
        vi.fn(async () => readyTarget),
        vi.fn(async (_prisma, _owner, _ledgerId, _target, evidenceId) => ({
          id: evidenceId!,
          source: "public_adapter_observation" as const,
        })),
        fill,
      ),
    ).resolves.toMatchObject({ status: "stop", reason: "fill_scope_changed" });
    expect(fill).not.toHaveBeenCalled();
  });

  it("does not call C1 if the market target changes after capture", async () => {
    const readTarget = vi
      .fn()
      .mockResolvedValueOnce(readyTarget)
      .mockResolvedValueOnce({
        ...readyTarget,
        symbol: "BTC-USDT",
        targetRevision: 4,
        targetApprovalEffectId: "target-new",
      });
    const fill = vi.fn();
    await expect(
      fillReservedPaperWorkerProposal(
        prisma,
        payload,
        signal,
        now,
        vi.fn(async () => readyFill),
        readTarget,
        vi.fn(async (_prisma, _owner, _ledgerId, _target, evidenceId) => ({
          id: evidenceId!,
          source: "public_adapter_observation" as const,
        })),
        fill,
      ),
    ).resolves.toMatchObject({ status: "stop", reason: "target_scope_changed" });
    expect(fill).not.toHaveBeenCalled();
  });

  it("rejects an invalid trusted clock before any reader or public request", async () => {
    const readFill = vi.fn();
    await expect(
      fillReservedPaperWorkerProposal(prisma, payload, signal, new Date("invalid"), readFill),
    ).rejects.toThrow("Invalid paper worker fill clock");
    expect(readFill).not.toHaveBeenCalled();
  });
});
