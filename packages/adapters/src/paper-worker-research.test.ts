import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { TradingResearchOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { PaperWorkerMarketObservationResult } from "./paper-worker-market-observation.js";
import { researchObservedPaperWorkerMarket } from "./paper-worker-research.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-07T11:00:00.000Z",
};
const now = new Date("2026-10-07T11:00:05.000Z");
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
const okxObservation: Extract<PaperWorkerMarketObservationResult, { status: "observed" }> = {
  status: "observed",
  targetPreflight: {
    status: "ready",
    mode: "paper_only",
    ledgerId: "paper-1",
    venue: "okx",
    symbol: "SOL-USDT",
    gateRevision: 7,
    targetRevision: 4,
    targetApprovalEffectId: "target-approval",
    workerApprovalEffectId: "worker-approval",
    paperApprovalEffectId: "paper-approval",
  },
  target: { venue: "okx", symbol: "SOL-USDT" },
  evidence: {
    id: `paper-worker:${"c".repeat(64)}`,
    source: "public_adapter_observation",
  },
};

describe("researchObservedPaperWorkerMarket", () => {
  it("keeps BingX observation-only until venue-matching history exists", async () => {
    const observation = {
      ...okxObservation,
      targetPreflight: { ...okxObservation.targetPreflight, venue: "bingx" as const },
      target: { venue: "bingx" as const, symbol: "SOL-USDT" },
    };
    const read = vi.fn();
    const history = vi.fn();
    const research = vi.fn();
    const record = vi.fn();

    await expect(
      researchObservedPaperWorkerMarket(
        {} as PrismaClient,
        payload,
        observation,
        now,
        read,
        history,
        research,
        record,
      ),
    ).resolves.toEqual({
      status: "unsupported_target",
      venue: "bingx",
      symbol: "SOL-USDT",
    });
    expect(read).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("derives and persists deterministic OKX research from verified evidence", async () => {
    const at = now.toISOString();
    const output = TradingResearchOutputSchema.parse({
      algorithm: "breakout_20_1h_v1",
      venue: "okx",
      market,
      fetchedAt: at,
      candleCount: 0,
      latestClosedAt: null,
      signal: {
        kind: "no_trade",
        signalId: "okx:SOL-USDT:1H:no-bars:abstain",
        strategyId: "breakout_20_1h_v1",
        strategyVersion: "1",
        createdAt: at,
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        evidenceIds: ["okx:SOL-USDT:1H:no-bars"],
        reason: "insufficient history",
      },
    });
    const read = vi.fn(async () => ({
      id: okxObservation.evidence.id,
      source: "public_adapter_observation" as const,
      market,
      ticker: {
        venue: "okx" as const,
        kind: "spot" as const,
        symbol: "SOL-USDT",
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
        observedAt: at,
        fetchedAt: at,
      },
    }));
    const history = vi.fn(async () => ({ fetchedAt: at, candles: [] }));
    const research = vi.fn(() => output);
    const recordResult = {
      status: "recorded" as const,
      ledgerId: "paper-1",
      sourceScheduledFor: payload.scheduledFor,
      gateRevision: 7,
      targetRevision: 4,
      quoteEvidenceId: okxObservation.evidence.id,
      algorithm: output.algorithm,
      signalId: output.signal.signalId,
      signalKind: output.signal.kind,
    };
    const record = vi.fn(async () => recordResult);

    await expect(
      researchObservedPaperWorkerMarket(
        {} as PrismaClient,
        payload,
        okxObservation,
        now,
        read,
        history,
        research,
        record,
      ),
    ).resolves.toEqual({ status: "researched", output, record: recordResult });
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      okxObservation.evidence.id,
    );
    expect(history).toHaveBeenCalledWith(market, { now });
    expect(research).toHaveBeenCalledWith({
      market,
      candles: [],
      fetchedAt: at,
      now,
    });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      {
        sourceScheduledFor: payload.scheduledFor,
        gateRevision: 7,
        targetRevision: 4,
        quoteEvidenceId: okxObservation.evidence.id,
        output,
      },
    );
  });

  it("propagates durable research-write conflicts", async () => {
    const at = now.toISOString();
    const output = TradingResearchOutputSchema.parse({
      algorithm: "breakout_20_1h_v1",
      venue: "okx",
      market,
      fetchedAt: at,
      candleCount: 0,
      latestClosedAt: null,
      signal: {
        kind: "no_trade",
        signalId: "okx:SOL-USDT:1H:no-bars:abstain",
        strategyId: "breakout_20_1h_v1",
        strategyVersion: "1",
        createdAt: at,
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        evidenceIds: ["okx:SOL-USDT:1H:no-bars"],
        reason: "insufficient history",
      },
    });
    const read = vi.fn(async () => ({
      id: okxObservation.evidence.id,
      source: "public_adapter_observation" as const,
      market,
      ticker: {
        venue: "okx" as const,
        kind: "spot" as const,
        symbol: "SOL-USDT",
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
        observedAt: at,
        fetchedAt: at,
      },
    }));
    const record = vi.fn(async () => {
      throw new Error("conflicting research replay");
    });
    await expect(
      researchObservedPaperWorkerMarket(
        {} as PrismaClient,
        payload,
        okxObservation,
        now,
        read,
        vi.fn(async () => ({ fetchedAt: at, candles: [] })),
        vi.fn(() => output),
        record,
      ),
    ).rejects.toThrow("conflicting research replay");
  });
});
