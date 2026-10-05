import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handlePaperWorkerPreflight } from "./paper-worker-background.js";

const payload: BackgroundJobPayloads["paper.worker-preflight"] = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  scheduledFor: "2026-10-05T12:00:00.000Z",
};

describe("handlePaperWorkerPreflight", () => {
  it("returns ready only for the exact gate revision", async () => {
    const read = vi.fn(async () => ({
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      cadenceMinutes: 15,
      policyRevision: 2,
      gateRevision: 7,
      workerApprovalEffectId: "worker-effect",
      paperApprovalEffectId: "paper-effect",
    }));
    const prisma = {} as PrismaClient;

    await expect(handlePaperWorkerPreflight(prisma, payload, read)).resolves.toEqual({
      status: "ready",
      gateRevision: 7,
      cadenceMinutes: 15,
    });
    expect(read).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space-1", userId: "user-1" },
      "paper-1",
      expect.any(Date),
    );
  });

  it("turns a superseded gate revision into an inert stale result", async () => {
    const read = vi.fn(async () => ({
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      cadenceMinutes: 15,
      policyRevision: 2,
      gateRevision: 8,
      workerApprovalEffectId: "new-worker-effect",
      paperApprovalEffectId: "paper-effect",
    }));
    await expect(handlePaperWorkerPreflight({} as PrismaClient, payload, read)).resolves.toEqual({
      status: "stale_gate_revision",
    });
  });

  it("keeps preflight denial inert", async () => {
    const read = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "worker_gate_disabled" as const,
    }));
    await expect(handlePaperWorkerPreflight({} as PrismaClient, payload, read)).resolves.toEqual({
      status: "deny",
      reason: "worker_gate_disabled",
    });
  });
});
