import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  handlePaperProtectionOnlyWake,
  type PaperProtectionOnlyWake,
} from "./paper-protection-only-wake.js";

const payload: PaperProtectionOnlyWake = {
  ledgerId: "paper-1",
  spaceId: "space-1",
  userId: "user-1",
  gateRevision: 7,
  leaseRevision: 3,
  scheduledFor: "2026-10-09T00:00:00.000Z",
};
const prisma = {} as PrismaClient;
const now = new Date("2026-10-09T00:00:01.000Z");
const ready = {
  status: "ready" as const,
  mode: "paper_only" as const,
  ledgerId: "paper-1",
  revision: 3,
  gateRevision: 7,
  cadenceMinutes: 15,
  expiresAt: "2026-10-09T01:00:00.000Z",
};

describe("H2b protection-only wake", () => {
  it("denies without a separately approved protection lease, without running stops", async () => {
    const preflight = vi.fn(async () => ({
      status: "deny" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      reason: "protection_not_active" as const,
    }));
    const stops = vi.fn();
    const result = await handlePaperProtectionOnlyWake(
      prisma, payload, now, preflight, stops,
    );
    expect(result).toMatchObject({
      status: "deny", reason: "protection_not_active",
    });
    expect(stops).not.toHaveBeenCalled();
  });

  it("invokes the existing F4/G5 stop-only executor and no research, reserve or fill", async () => {
    const preflight = vi.fn(async () => ready);
    const worker = vi.fn(async () => ({
      status: "ready" as const,
      mode: "paper_only" as const,
      ledgerId: "paper-1",
      gateRevision: 7,
      policyRevision: 1,
      cadenceMinutes: 15,
      paperApprovalEffectId: "paper-effect",
      workerApprovalEffectId: "worker-effect",
    }));
    const stops = vi.fn(async (_prisma, p, _now, wrapped) => {
      expect(p).toMatchObject({
        ledgerId: "paper-1", gateRevision: 7,
      });
      expect(p).not.toHaveProperty("leaseRevision");
      expect(await wrapped(prisma, { spaceId: "space-1", userId: "user-1" }, "paper-1", now)).toMatchObject({
        status: "ready", gateRevision: 7,
      });
      return { status: "continue" as const, ledgerId: "paper-1", checkedPositions: 1 };
    });
    const out = await handlePaperProtectionOnlyWake(
      prisma, payload, now, preflight, stops, worker,
    );
    expect(out).toMatchObject({
      status: "handled",
      leaseRevision: 3,
      protectiveStop: { status: "continue", checkedPositions: 1 },
    });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(stops).toHaveBeenCalledTimes(1);
  });

  it("revocation during a quote fetch prevents the second F4/G5 worker authorization", async () => {
    const preflight = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({
        status: "deny", mode: "paper_only", ledgerId: "paper-1",
        reason: "protection_not_active",
      });
    const worker = vi.fn();
    const stops = vi.fn(async (_prisma, _p, _n, wrapped) => {
      expect(await wrapped(prisma, { spaceId: "space-1", userId: "user-1" }, "paper-1", now)).toMatchObject({
        status: "deny", reason: "worker_gate_disabled",
      });
      return {
        status: "stop" as const,
        ledgerId: "paper-1",
        checkedPositions: 0,
        reason: "worker_gate_denied" as const,
      };
    });
    const out = await handlePaperProtectionOnlyWake(
      prisma, payload, now, preflight, stops, worker,
    );
    expect(out).toMatchObject({
      status: "handled",
      protectiveStop: { status: "stop", reason: "worker_gate_denied" },
    });
    expect(worker).not.toHaveBeenCalled();
  });

  it("rejects malformed lease revisions before any protective checks", async () => {
    const preflight = vi.fn();
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(handlePaperProtectionOnlyWake(
        prisma, { ...payload, leaseRevision: invalid }, now, preflight,
      )).rejects.toThrow("Invalid protection-only PAPER wake scope");
    }
    expect(preflight).not.toHaveBeenCalled();
  });
});
