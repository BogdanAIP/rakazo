import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { observeConfiguredPaperWorkerSpotMarket } from "./paper-worker-market-observation.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-07T09:00:00.000Z",
};
const now = new Date("2026-10-07T09:00:01.000Z");

describe("observeConfiguredPaperWorkerSpotMarket", () => {
  it("captures only the owner-approved target after an exact gate match", async () => {
    const targetPreflight = vi.fn(async () => ({
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
    }));
    const capture = vi.fn(async () => ({
      id: "evidence-1",
      source: "public_adapter_observation" as const,
    }));
    const prisma = {} as PrismaClient;

    await expect(
      observeConfiguredPaperWorkerSpotMarket(prisma, payload, now, targetPreflight, capture),
    ).resolves.toMatchObject({
      status: "observed",
      target: { venue: "okx", symbol: "SOL-USDT" },
      evidence: { id: "evidence-1", source: "public_adapter_observation" },
    });
    expect(targetPreflight).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      now,
    );
    expect(capture).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      { venue: "okx", symbol: "SOL-USDT" },
    );
  });

  it("does not contact a public venue when target authorization is denied", async () => {
    const capture = vi.fn();
    const denied = {
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "target_disabled" as const,
    };
    await expect(
      observeConfiguredPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        now,
        vi.fn(async () => denied),
        capture,
      ),
    ).resolves.toEqual({ status: "stop", reason: "target_denied", targetPreflight: denied });
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not contact a public venue for a stale queued worker revision", async () => {
    const capture = vi.fn();
    const targetPreflight = {
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      venue: "bingx" as const,
      symbol: "BTC-USDT",
      gateRevision: 8,
      targetRevision: 4,
      targetApprovalEffectId: "target-approval",
      workerApprovalEffectId: "worker-approval",
      paperApprovalEffectId: "paper-approval",
    };
    await expect(
      observeConfiguredPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        now,
        vi.fn(async () => targetPreflight),
        capture,
      ),
    ).resolves.toEqual({
      status: "stop",
      reason: "queued_gate_revision_stale",
      targetPreflight,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("propagates public-adapter uncertainty instead of fabricating evidence", async () => {
    const capture = vi.fn(async () => {
      throw new Error("public market unavailable");
    });
    await expect(
      observeConfiguredPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        now,
        vi.fn(async () => ({
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
        })),
        capture,
      ),
    ).rejects.toThrow("public market unavailable");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid clock before DB or network access", async () => {
    const targetPreflight = vi.fn();
    const capture = vi.fn();
    await expect(
      observeConfiguredPaperWorkerSpotMarket(
        {} as PrismaClient,
        payload,
        new Date(Number.NaN),
        targetPreflight,
        capture,
      ),
    ).rejects.toThrow("Invalid paper market observation clock");
    expect(targetPreflight).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
