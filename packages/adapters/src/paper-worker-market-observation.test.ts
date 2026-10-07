import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { observeAuthorizedPaperWorkerSpotMarket } from "./paper-worker-market-observation.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-07T09:00:00.000Z",
};

describe("observeAuthorizedPaperWorkerSpotMarket", () => {
  it("captures one public quote only after a ready worker preflight", async () => {
    const preflight = vi.fn(async () => ({
      status: "ready" as const,
      gateRevision: 7,
      cadenceMinutes: 15,
    }));
    const capture = vi.fn(async () => ({
      id: "evidence-1",
      source: "public_adapter_observation" as const,
    }));
    const prisma = {} as PrismaClient;
    const target = { venue: "okx" as const, symbol: "SOL-USDT" };

    await expect(
      observeAuthorizedPaperWorkerSpotMarket(prisma, payload, target, preflight, capture),
    ).resolves.toEqual({
      status: "observed",
      preflight: { status: "ready", gateRevision: 7, cadenceMinutes: 15 },
      target,
      evidence: { id: "evidence-1", source: "public_adapter_observation" },
    });
    expect(capture).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      target,
    );
  });

  it("does not make a market request or evidence write after a denied wake", async () => {
    const capture = vi.fn();
    await expect(
      observeAuthorizedPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        { venue: "bingx", symbol: "SOL-USDT" },
        vi.fn(async () => ({ status: "deny" as const, reason: "worker_gate_disabled" })),
        capture,
      ),
    ).resolves.toEqual({
      status: "stop",
      preflight: { status: "deny", reason: "worker_gate_disabled" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not observe a market when the queued gate revision is stale", async () => {
    const capture = vi.fn();
    await expect(
      observeAuthorizedPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        { venue: "okx", symbol: "BTC-USDT" },
        vi.fn(async () => ({ status: "stale_gate_revision" as const })),
        capture,
      ),
    ).resolves.toEqual({
      status: "stop",
      preflight: { status: "stale_gate_revision" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("propagates public-adapter uncertainty instead of fabricating evidence", async () => {
    const capture = vi.fn(async () => {
      throw new Error("public market unavailable");
    });
    await expect(
      observeAuthorizedPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        { venue: "okx", symbol: "SOL-USDT" },
        vi.fn(async () => ({
          status: "ready" as const,
          gateRevision: 7,
          cadenceMinutes: 15,
        })),
        capture,
      ),
    ).rejects.toThrow("public market unavailable");
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
