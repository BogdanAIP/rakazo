import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingResolvedResearchEnvelope } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handlePreparedPaperWorkerResolvedResearch } from "./paper-worker-resolved-research-flow.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-08T06:00:00.000Z",
};
const now = new Date("2026-10-08T06:01:00.000Z");
const prisma = {} as PrismaClient;
const owner = { spaceId: "space-1", userId: "user-1" };

const scope = {
  schemaVersion: "trading-resolved-research-scope-v1" as const,
  semanticKey: "signal.discovery",
  resolverKey: "resolver:signal.discovery@1",
  resolverDigest: "a".repeat(64),
  implementationReference: "market:ccxt/ccxt:trading-signal",
  skillSourceDigest: "b".repeat(64),
  strategyId: "resolver_signal_v1",
  strategyVersion: "1",
  venue: "okx",
  marketKind: "spot" as const,
  action: "spot_buy" as const,
};

const proposalEnvelope: TradingResolvedResearchEnvelope = {
  schemaVersion: "trading-resolved-research-v1",
  mode: "research_only",
  executionAuthority: "none",
  provenance: {
    semanticKey: "signal.discovery",
    resolverKey: "resolver:signal.discovery@1",
    resolverDigest: "a".repeat(64),
    implementation: {
      name: "CCXT trading-signal Agent Skill",
      kind: "mcp",
      reference: "market:ccxt/ccxt:trading-signal",
      priority: 1,
      readOnly: true,
    },
    skill: {
      marketEntryId: "market-skill-1",
      marketKey: "ccxt.trading-signal",
      sourceDigest: "b".repeat(64),
      variant: "original",
    },
    resolvedAt: "2026-10-08T05:59:00.000Z",
  },
  signal: {
    kind: "proposal",
    signalId: "resolved-signal-1",
    strategyId: "resolver_signal_v1",
    strategyVersion: "1",
    createdAt: "2026-10-08T05:59:30.000Z",
    expiresAt: "2026-10-08T06:05:00.000Z",
    evidenceIds: ["research-evidence-1"],
    executionStatus: "research_only",
    market: {
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      base: "SOL",
      quote: "USDT",
      status: "active",
      priceIncrement: "0.01",
      quantityIncrement: "0.01",
      minNotional: "5",
      expiryAt: null,
    },
    action: "spot_buy",
    entryTrigger: "100",
    stopLoss: "95",
    takeProfit: ["110"],
    invalidation: "fixture",
    rationale: "resolver fixture",
    riskBudgetQuote: null,
    maxSlippageBps: null,
  },
};

const researchAuthority = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  scope,
  signalId: "resolved-signal-1",
  policyRevision: 3,
  gateRevision: 7,
  researchRevision: 2,
  researchApprovalEffectId: "research-approval",
  workerApprovalEffectId: "worker-approval",
  paperApprovalEffectId: "paper-approval",
};

const fillAuthority = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  scope,
  policyRevision: 3,
  gateRevision: 7,
  researchRevision: 2,
  fillRevision: 4,
  fillApprovalEffectId: "fill-approval",
  researchApprovalEffectId: "research-approval",
  workerApprovalEffectId: "worker-approval",
  paperApprovalEffectId: "paper-approval",
};

const reservation = {
  status: "reserved" as const,
  mode: "paper_only" as const,
  signalId: "resolved-signal-1",
  reservationId: "paper-resv:1",
  eventId: "paper-event:1",
  eventSequence: 8,
  policyRevision: 3,
  quantityBase: "1",
  heldQuote: "101",
  worstCaseStopRiskQuote: "6",
  stopPriceQuote: "95",
  expiresAt: "2026-10-08T06:02:00.000Z",
};

const fill = {
  status: "filled" as const,
  mode: "paper_only" as const,
  reservationId: "paper-resv:1",
  signalId: "resolved-signal-1",
  fillEventId: "paper-fill:1",
  fillEventSequence: 9,
  policyRevision: 3,
  quantityBase: "1",
  executedPriceQuote: "100.1",
  feeQuote: "0.1",
  stopPriceQuote: "95",
  filledAt: "2026-10-08T06:01:01.000Z",
};

describe("handlePreparedPaperWorkerResolvedResearch", () => {
  it("keeps Resolver NO_TRADE fully research-only without quote or PAPER writes", async () => {
    const provider = vi.fn(async () => ({
      ...proposalEnvelope,
      signal: {
        kind: "no_trade" as const,
        signalId: "no-trade-1",
        strategyId: "resolver_signal_v1",
        strategyVersion: "1",
        createdAt: "2026-10-08T05:59:30.000Z",
        expiresAt: "2026-10-08T06:05:00.000Z",
        evidenceIds: ["research-evidence-1"],
        reason: "No eligible setup",
      },
    }));
    const capture = vi.fn();
    const readResearchPreflight = vi.fn();
    const reserveResolvedSignal = vi.fn();

    await expect(
      handlePreparedPaperWorkerResolvedResearch(prisma, payload, provider, capture, now, {
        readResearchPreflight,
        reserveResolvedSignal,
      }),
    ).resolves.toEqual({
      status: "no_trade",
      ledgerId: "paper-1",
      signalId: "no-trade-1",
    });
    expect(capture).not.toHaveBeenCalled();
    expect(readResearchPreflight).not.toHaveBeenCalled();
    expect(reserveResolvedSignal).not.toHaveBeenCalled();
  });

  it("fails closed before quote capture when G1 does not authorize the prepared scope", async () => {
    const provider = vi.fn(async () => proposalEnvelope);
    const capture = vi.fn();
    const readResearchPreflight = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "resolved_research_scope_mismatch" as const,
    }));
    const reserveResolvedSignal = vi.fn();

    await expect(
      handlePreparedPaperWorkerResolvedResearch(prisma, payload, provider, capture, now, {
        readResearchPreflight,
        reserveResolvedSignal,
      }),
    ).resolves.toEqual({
      status: "stop",
      ledgerId: "paper-1",
      stage: "research_gate",
      reason: "resolved_research_scope_mismatch",
      signalId: "resolved-signal-1",
    });
    expect(readResearchPreflight).toHaveBeenCalledWith(
      prisma,
      owner,
      "paper-1",
      proposalEnvelope,
      now,
    );
    expect(capture).not.toHaveBeenCalled();
    expect(reserveResolvedSignal).not.toHaveBeenCalled();
  });

  it("creates only the G2 reserve when the independent G3 fill permission is disabled", async () => {
    const provider = vi.fn(async () => proposalEnvelope);
    const capture = vi.fn(
      async (
        _prisma: PrismaClient,
        _owner: typeof owner,
        _ledgerId: string,
        _market: typeof proposalEnvelope.signal extends { kind: "proposal"; market: infer M }
          ? M
          : never,
        evidenceId: string,
      ) => ({ id: evidenceId, source: "public_adapter_observation" as const }),
    );
    const readResearchPreflight = vi.fn(async () => researchAuthority);
    const reserveResolvedSignal = vi.fn(async () => reservation);
    const readFillPreflight = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "resolved_fill_gate_disabled" as const,
    }));
    const fillResolvedReservation = vi.fn();

    const result = await handlePreparedPaperWorkerResolvedResearch(
      prisma,
      payload,
      provider,
      capture,
      now,
      {
        readResearchPreflight,
        reserveResolvedSignal,
        readFillPreflight,
        fillResolvedReservation,
      },
    );
    expect(result).toEqual({
      status: "reserved",
      ledgerId: "paper-1",
      signalId: "resolved-signal-1",
      reservation,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[4]).toMatch(/^paper-resolver:[0-9a-f]{64}$/u);
    expect(fillResolvedReservation).not.toHaveBeenCalled();
  });

  it("uses separate fresh reserve/fill evidence and reaches G4 only with G3 authority", async () => {
    const provider = vi.fn(async () => proposalEnvelope);
    const capture = vi.fn(
      async (
        _prisma: PrismaClient,
        _owner: typeof owner,
        _ledgerId: string,
        _market: typeof proposalEnvelope.signal extends { kind: "proposal"; market: infer M }
          ? M
          : never,
        evidenceId: string,
      ) => ({ id: evidenceId, source: "public_adapter_observation" as const }),
    );
    const readResearchPreflight = vi.fn(async () => researchAuthority);
    const reserveResolvedSignal = vi.fn(async () => reservation);
    const readFillPreflight = vi.fn(async () => fillAuthority);
    const fillResolvedReservation = vi.fn(async () => fill);

    const result = await handlePreparedPaperWorkerResolvedResearch(
      prisma,
      payload,
      provider,
      capture,
      now,
      {
        readResearchPreflight,
        reserveResolvedSignal,
        readFillPreflight,
        fillResolvedReservation,
      },
    );
    expect(result).toEqual({
      status: "filled",
      ledgerId: "paper-1",
      signalId: "resolved-signal-1",
      reservation,
      fill,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    const reserveEvidenceId = capture.mock.calls[0]?.[4];
    const fillEvidenceId = capture.mock.calls[1]?.[4];
    expect(reserveEvidenceId).toMatch(/^paper-resolver:[0-9a-f]{64}$/u);
    expect(fillEvidenceId).toMatch(/^paper-resolver:[0-9a-f]{64}$/u);
    expect(fillEvidenceId).not.toBe(reserveEvidenceId);
    expect(reserveResolvedSignal).toHaveBeenCalledWith(
      prisma,
      owner,
      "paper-1",
      proposalEnvelope,
      reserveEvidenceId,
      researchAuthority,
    );
    expect(fillResolvedReservation).toHaveBeenCalledWith(
      prisma,
      owner,
      "paper-1",
      "paper-resv:1",
      fillEvidenceId,
      fillAuthority,
    );
  });

  it("rejects a capture adapter that does not preserve the deterministic evidence id", async () => {
    const provider = vi.fn(async () => proposalEnvelope);
    const capture = vi.fn(async () => ({
      id: "unexpected-evidence",
      source: "public_adapter_observation" as const,
    }));
    const reserveResolvedSignal = vi.fn();

    await expect(
      handlePreparedPaperWorkerResolvedResearch(prisma, payload, provider, capture, now, {
        readResearchPreflight: vi.fn(async () => researchAuthority),
        reserveResolvedSignal,
      }),
    ).rejects.toThrow("Resolved research reserve evidence id changed during capture");
    expect(reserveResolvedSignal).not.toHaveBeenCalled();
  });
});
