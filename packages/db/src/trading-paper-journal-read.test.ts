import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  listOwnedTradingPaperJournals,
  readOwnedTradingPaperJournal,
} from "./trading-paper-journal-read.js";

const owner = { spaceId: "space-1", userId: "user-1" };

describe("read-only owner-scoped PAPER journal viewer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists metadata only within the authenticated user's space and owner scope", async () => {
    const findMany = vi.fn(async (_query: unknown) => [
      {
        id: "paper-one",
        openedAt: new Date("2026-10-08T08:00:00Z"),
        updatedAt: new Date("2026-10-08T09:00:00Z"),
        quoteCurrency: "USDT",
        version: 12,
      },
    ]);
    const prisma = { tradingPaperLedger: { findMany } } as unknown as PrismaClient;
    await expect(listOwnedTradingPaperJournals(prisma, owner)).resolves.toEqual({
      mode: "paper_only",
      ledgers: [
        {
          ledgerId: "paper-one",
          openedAt: "2026-10-08T08:00:00.000Z",
          updatedAt: "2026-10-08T09:00:00.000Z",
          quoteCurrency: "USDT",
          eventsCount: 12,
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", ownerUserId: "user-1" },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 50,
      select: {
        id: true,
        openedAt: true,
        updatedAt: true,
        quoteCurrency: true,
        version: true,
      },
    });
    // Never project monetary values from an unaudited list.
    const query = findMany.mock.calls[0]?.[0];
    expect(JSON.stringify(query)).not.toContain("projection");
  });

  it("returns NOT FOUND internally for a cross-owner journal without reading events", async () => {
    const findFirst = vi.fn(async () => null);
    const tx = { tradingPaperLedger: { findFirst } };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    );
    const prisma = { $transaction: transaction } as unknown as PrismaClient;

    await expect(
      readOwnedTradingPaperJournal(prisma, owner, "someone-elses-ledger"),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "someone-elses-ledger",
        spaceId: "space-1",
        ownerUserId: "user-1",
      },
      select: { id: true, openedAt: true, updatedAt: true },
    });
    expect(Object.keys(tx)).toEqual(["tradingPaperLedger"]);
  });

  it("rejects an invalid clock before starting a DB transaction", async () => {
    const transaction = vi.fn();
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    await expect(
      readOwnedTradingPaperJournal(
        prisma,
        owner,
        "paper-one",
        undefined,
        new Date("bad"),
      ),
    ).rejects.toThrow("clock");
    expect(transaction).not.toHaveBeenCalled();
  });
});
