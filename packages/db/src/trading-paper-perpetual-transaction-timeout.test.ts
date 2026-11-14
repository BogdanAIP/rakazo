import type { PrismaClient } from "./generated/prisma/client.js";
import { describe, expect, it, vi } from "vitest";
import {
  commandOwnedPerpetualWorkspace,
  completeIdleExternalPerpetualWake,
  failPerpetualWake,
  pausePerpetualAfterRestart,
  readOwnedPerpetualResearchHistory,
  readPerpetualWake,
  recordPerpetualResearchTick,
  reschedulePerpetualProtectionAfterResearchExpiry,
  retryTransientPerpetualMarketWake,
} from "./trading-paper-perpetual-workspace.js";

const owner = { spaceId: "paper-qa-space", userId: "paper-qa-owner" };
const ledgerId = "paper-futures:qa-timeout";
const key = { ledgerId, revision: 1, scheduledFor: "2026-11-14T06:00:00.000Z" };

describe("PAPER control and protection transactions under a growing event history", () => {
  const operations: Array<{ name: string; invoke: (prisma: PrismaClient) => Promise<unknown> }> = [
    {
      name: "resume command and exact position-plan verification",
      invoke: (prisma) =>
        commandOwnedPerpetualWorkspace(prisma, owner, {
          ledgerId,
          commandId: "ce986a12-c646-4529-89d5-1ea30b40a984",
          expectedRevision: 1,
          action: "resume",
          durationMinutes: 20160,
          protectionMinutes: 1440,
        }),
    },
    {
      name: "initial owner-scoped wake recovery",
      invoke: (prisma) => readPerpetualWake(prisma, owner, ledgerId, 1, key.scheduledFor),
    },
    {
      name: "idle external wake",
      invoke: (prisma) => completeIdleExternalPerpetualWake(prisma, owner, key),
    },
    {
      name: "rescheduling protection on expired research",
      invoke: (prisma) => reschedulePerpetualProtectionAfterResearchExpiry(prisma, owner, key),
    },
    {
      name: "bounded public market retry",
      invoke: (prisma) => retryTransientPerpetualMarketWake(prisma, owner, key),
    },
    {
      name: "fail-closed pause preserving held positions",
      invoke: (prisma) => failPerpetualWake(prisma, owner, ledgerId, 1, "database_unavailable"),
    },
    {
      name: "restart reconciliation with open exposure",
      invoke: (prisma) => pausePerpetualAfterRestart(prisma, owner, ledgerId),
    },
    {
      name: "commit protection tick before entering risk core",
      invoke: (prisma) =>
        recordPerpetualResearchTick(prisma, owner, { ...key, stage: "protection" }, [], {
          kind: "no_trade",
          reason: "Protect positions",
        }),
    },
    {
      name: "bounded hash-verified research history",
      invoke: (prisma) => readOwnedPerpetualResearchHistory(prisma, owner, ledgerId, 2),
    },
  ];

  it.each(operations)(
    "$name has a deliberate 30-second database transaction budget",
    async ({ invoke }) => {
      const transaction = vi.fn(async (_callback: unknown, _options: unknown) => null);
      const prisma = { $transaction: transaction } as unknown as PrismaClient;
      await invoke(prisma);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ timeout: 30000 }),
      );
    },
  );
});
