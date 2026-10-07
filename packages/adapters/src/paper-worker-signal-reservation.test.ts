import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { TradingResearchOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  PaperWorkerSignalReservationIntegrityError,
  reservePersistedPaperWorkerProposal,
} from "./paper-worker-signal-reservation.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-07T12:00:00.000Z",
};
const now = new Date("2026-10-07T12:01:00.000Z");
const prisma = {} as PrismaClient;
const market = {
  venue: "okx" as const,
  kind: "spot" as const,
  symbol: "SOL-USDT",
  base: "SOL",
  quote: "USDT",
  status: "active" as const,
  priceIncrement: "0.01",
  quantityIncrement: "0.01",
  minNotional: "5",
  expiryAt: null,
};
const readyGate = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: payload.ledgerId,
  strategyId: "breakout_20_1h_v1" as const,
  policyRevision: 3,
  gateRevision: 7,
  signalRevision: 1,
  signalApprovalEffectId: "signal-approval",
  workerApprovalEffectId: "worker-approval",
  paperApprovalEffectId: "paper-approval",
};

function proposal(expiresAt = "2026-10-07T12:10:00.000Z", strategyId = "breakout_20_1h_v1") {
  return TradingResearchOutputSchema.parse({
    algorithm: "breakout_20_1h_v1",
    venue: "okx",
    market,
    fetchedAt: "2026-10-07T12:00:30.000Z",
    candleCount: 21,
    latestClosedAt: "2026-10-07T11:00:00.000Z",
    signal: {
      kind: "proposal",
      signalId: "signal-1",
      strategyId,
      strategyVersion: "1",
      createdAt: "2026-10-07T12:00:30.000Z",
      expiresAt,
      evidenceIds: ["okx:SOL-USDT:1H:breakout"],
      executionStatus: "research_only",
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "98",
      takeProfit: ["104"],
      invalidation: "Close below breakout support.",
      rationale: "Closed-hour breakout baseline.",
      riskBudgetQuote: null,
      maxSlippageBps: null,
    },
  });
}

function noTrade() {
  return TradingResearchOutputSchema.parse({
    algorithm: "breakout_20_1h_v1",
    venue: "okx",
    market,
    fetchedAt: "2026-10-07T12:00:30.000Z",
    candleCount: 21,
    latestClosedAt: "2026-10-07T11:00:00.000Z",
    signal: {
      kind: "no_trade",
      signalId: "signal-no-trade",
      strategyId: "breakout_20_1h_v1",
      strategyVersion: "1",
      createdAt: "2026-10-07T12:00:30.000Z",
      expiresAt: "2026-10-07T12:10:00.000Z",
      evidenceIds: ["okx:SOL-USDT:1H:no-trade"],
      reason: "Breakout conditions are not met.",
    },
  });
}

function research(output = proposal()) {
  return {
    record: {
      status: "duplicate" as const,
      ledgerId: payload.ledgerId,
      sourceScheduledFor: payload.scheduledFor,
      gateRevision: payload.gateRevision,
      targetRevision: 2,
      quoteEvidenceId: `paper-worker:${"a".repeat(64)}`,
      algorithm: output.algorithm,
      signalId: output.signal.signalId,
      signalKind: output.signal.kind,
    },
    output,
  };
}

describe("reservePersistedPaperWorkerProposal", () => {
  it("passes only the verified persisted proposal and persisted quote id into B7", async () => {
    const readSignal = vi.fn(async () => readyGate);
    const stored = research();
    const readResearch = vi.fn(async () => stored);
    const reserve = vi.fn(async () => ({
      status: "deny" as const,
      reason: "capacity_no_capacity" as const,
      ledgerRevision: 0,
      policyRevision: 3,
    }));

    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        readSignal,
        readResearch,
        reserve,
      ),
    ).resolves.toEqual({
      status: "reserve_result",
      ledgerId: payload.ledgerId,
      signalId: stored.output.signal.signalId,
      reserve: {
        status: "deny",
        reason: "capacity_no_capacity",
        ledgerRevision: 0,
        policyRevision: 3,
      },
    });

    expect(readResearch).toHaveBeenCalledWith(
      prisma,
      { spaceId: payload.spaceId, userId: payload.userId },
      payload.ledgerId,
      {
        sourceScheduledFor: payload.scheduledFor,
        gateRevision: payload.gateRevision,
        targetRevision: 2,
      },
    );
    expect(readSignal).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      prisma,
      { spaceId: payload.spaceId, userId: payload.userId },
      payload.ledgerId,
      stored.output.signal,
      stored.record.quoteEvidenceId,
    );
  });

  it("stops before research or B7 when the F0 signal gate denies", async () => {
    const readResearch = vi.fn();
    const reserve = vi.fn();
    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        vi.fn(async () => ({
          status: "deny" as const,
          mode: "paper_only" as const,
          ledgerId: payload.ledgerId,
          reason: "signal_gate_disabled" as const,
        })),
        readResearch,
        reserve,
      ),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: payload.ledgerId,
      reason: "signal_gate_denied",
      signalGateReason: "signal_gate_disabled",
    });
    expect(readResearch).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("stops a stale queued worker revision before reading research or reserving", async () => {
    const readResearch = vi.fn();
    const reserve = vi.fn();
    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        vi.fn(async () => ({ ...readyGate, gateRevision: 8 })),
        readResearch,
        reserve,
      ),
    ).resolves.toMatchObject({ status: "stop", reason: "signal_scope_changed" });
    expect(readResearch).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("keeps missing durable research and NO_TRADE completely away from B7", async () => {
    const reserve = vi.fn();
    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        vi.fn(async () => readyGate),
        vi.fn(async () => null),
        reserve,
      ),
    ).resolves.toMatchObject({ status: "stop", reason: "research_unavailable" });
    expect(reserve).not.toHaveBeenCalled();

    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        vi.fn(async () => readyGate),
        vi.fn(async () => research(noTrade())),
        reserve,
      ),
    ).resolves.toMatchObject({
      status: "stop",
      reason: "no_trade",
      signalId: "signal-no-trade",
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("keeps an expired or near-expiry persisted proposal away from B7", async () => {
    const reserve = vi.fn();
    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        vi.fn(async () => readyGate),
        vi.fn(async () => research(proposal("2026-10-07T12:01:00.500Z"))),
        reserve,
      ),
    ).resolves.toMatchObject({
      status: "stop",
      reason: "signal_expired",
      signalId: "signal-1",
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("fails closed on strategy/market integrity mismatch before B7", async () => {
    const reserve = vi.fn();
    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        vi.fn(async () => readyGate),
        vi.fn(async () => research(proposal(undefined, "other-strategy"))),
        reserve,
      ),
    ).rejects.toBeInstanceOf(PaperWorkerSignalReservationIntegrityError);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rechecks F0 immediately before B7 and stops when authority changes", async () => {
    const reserve = vi.fn();
    const readSignal = vi
      .fn()
      .mockResolvedValueOnce(readyGate)
      .mockResolvedValueOnce({
        ...readyGate,
        signalRevision: 2,
        signalApprovalEffectId: "signal-approval-2",
      });

    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        now,
        readSignal,
        vi.fn(async () => research()),
        reserve,
      ),
    ).resolves.toMatchObject({
      status: "stop",
      reason: "signal_scope_changed",
      signalId: "signal-1",
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects an invalid trusted clock or target revision without touching DB readers", async () => {
    const readSignal = vi.fn();
    await expect(
      reservePersistedPaperWorkerProposal(
        prisma,
        payload,
        2,
        new Date("invalid"),
        readSignal,
      ),
    ).rejects.toBeInstanceOf(PaperWorkerSignalReservationIntegrityError);
    await expect(
      reservePersistedPaperWorkerProposal(prisma, payload, 0, now, readSignal),
    ).rejects.toBeInstanceOf(PaperWorkerSignalReservationIntegrityError);
    expect(readSignal).not.toHaveBeenCalled();
  });
});
