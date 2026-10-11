import type { PerpetualPaperEvent } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  appendVerifiedPerpetualPaperEvent,
  createDisabledPerpetualPaperAccount,
  PerpetualPaperConflictError,
  PerpetualPaperIntegrityError,
  readVerifiedPerpetualPaperAccount,
} from "./trading-paper-perpetual-store.js";

type Row = Record<string, unknown>;
type Snapshot = { ledger: Row | null; events: Row[] };
const owner = { spaceId: "space-1", userId: "user-1" };
const openedAt = "2026-10-11T00:00:00.000Z";
const ledgerId = "perp.test.ledger";

const first: PerpetualPaperEvent = {
  ledgerId,
  eventId: "event-1",
  sequence: 1,
  recordedAt: "2026-10-11T00:00:01.000Z",
  kind: "open",
  positionId: "btc-long",
  venue: "okx",
  instrument: "BTC-USDT-SWAP",
  side: "long",
  leverage: 2,
  quantityBase: "1",
  entryPriceQuote: "100",
  entryFeeQuote: "0.1",
  maintenanceMarginBps: 50,
};
function harness() {
  let state: Snapshot = { ledger: null, events: [] };
  let memberAccess = true;
  const transaction = vi.fn(
    async (callback: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
      const working: Snapshot = structuredClone(state);
      const tx = {
        spaceMember: {
          findFirst: vi.fn(async ({ where }: { where: Row }) =>
            memberAccess && where.spaceId === owner.spaceId && where.userId === owner.userId
              ? { id: "membership-1" }
              : null,
          ),
        },
        tradingPaperPerpetualLedger: {
          findFirst: vi.fn(async ({ where }: { where: Row }) =>
            working.ledger &&
            working.ledger.id === where.id &&
            working.ledger.spaceId === where.spaceId &&
            working.ledger.ownerUserId === where.ownerUserId
              ? working.ledger
              : null,
          ),
          create: vi.fn(async ({ data }: { data: Row }) => {
            if (working.ledger) throw new Error("duplicate account");
            working.ledger = { ...data, version: 0 };
            return working.ledger;
          }),
          updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
            if (
              !working.ledger ||
              working.ledger.id !== where.id ||
              working.ledger.spaceId !== where.spaceId ||
              working.ledger.ownerUserId !== where.ownerUserId ||
              working.ledger.version !== where.version ||
              working.ledger.headSha256 !== where.headSha256
            ) {
              return { count: 0 };
            }
            working.ledger = {
              ...working.ledger,
              ...data,
              version: Number(working.ledger.version) + 1,
            };
            return { count: 1 };
          }),
        },
        tradingPaperPerpetualEvent: {
          findMany: vi.fn(async ({ where }: { where: Row }) =>
            working.events
              .filter((event) => event.ledgerId === where.ledgerId)
              .sort((a, b) => Number(a.sequence) - Number(b.sequence)),
          ),
          create: vi.fn(async ({ data }: { data: Row }) => {
            if (
              working.events.some(
                (event) =>
                  event.ledgerId === data.ledgerId &&
                  (event.eventId === data.eventId || event.sequence === data.sequence),
              )
            ) {
              throw new Error("duplicate synthetic event");
            }
            working.events.push({ ...data });
            return data;
          }),
        },
      };
      const result = await callback(tx);
      state = working;
      return result;
    },
  );
  return {
    prisma: { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">,
    snapshot: () => structuredClone(state),
    tamper: (change: (current: Snapshot) => void) => change(state),
    denyMember: () => {
      memberAccess = false;
    },
  };
}
const create = (h: ReturnType<typeof harness>) =>
  createDisabledPerpetualPaperAccount(h.prisma, owner, {
    ledgerId,
    strategy: "moderate",
    openedAt,
  });

describe("internal owner-scoped, hash-chained futures PAPER journal", () => {
  it("creates exactly 1000 virtual USDT and verifies empty ledger", async () => {
    const h = harness();
    expect((await create(h)).availableQuote).toBe("1000");
    expect(
      (await readVerifiedPerpetualPaperAccount(h.prisma, owner, ledgerId)).openPositions,
    ).toHaveLength(0);
    const row = h.snapshot().ledger;
    expect(row?.headSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.projectionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.version).toBe(0);
  });

  it("atomically appends, replays and idempotently ignores an exact repeat", async () => {
    const h = harness();
    await create(h);
    const opened = await appendVerifiedPerpetualPaperEvent(h.prisma, owner, first);
    expect(opened.status).toBe("appended");
    expect(opened.state.availableQuote).toBe("949.9");
    expect(opened.state.openPositions).toHaveLength(1);
    expect((await appendVerifiedPerpetualPaperEvent(h.prisma, owner, first)).status).toBe(
      "duplicate",
    );
    const marked: PerpetualPaperEvent = {
      ledgerId,
      eventId: "event-2",
      sequence: 2,
      recordedAt: "2026-10-11T00:00:02.000Z",
      kind: "mark",
      positionId: "btc-long",
      markPriceQuote: "105",
    };
    const mark = await appendVerifiedPerpetualPaperEvent(h.prisma, owner, marked);
    expect(mark.state.unrealizedPnlQuote).toBe("5");
    const finished = await appendVerifiedPerpetualPaperEvent(h.prisma, owner, {
      ledgerId,
      eventId: "event-3",
      sequence: 3,
      recordedAt: "2026-10-11T00:00:03.000Z",
      kind: "close",
      positionId: "btc-long",
      exitPriceQuote: "105",
      exitFeeQuote: "0.1",
    });
    expect(finished.state.availableQuote).toBe("1004.8");
    expect(finished.state.closedPositions).toBe(1);
    expect((await readVerifiedPerpetualPaperAccount(h.prisma, owner, ledgerId)).nextSequence).toBe(
      4,
    );
    expect(h.snapshot().events).toHaveLength(3);
  });

  it("rejects stolen owner, hash tampering and conflicting duplicate IDs", async () => {
    const h = harness();
    await create(h);
    await expect(
      readVerifiedPerpetualPaperAccount(
        h.prisma,
        { spaceId: owner.spaceId, userId: "intruder" },
        ledgerId,
      ),
    ).rejects.toBeInstanceOf(PerpetualPaperIntegrityError);
    await appendVerifiedPerpetualPaperEvent(h.prisma, owner, first);
    await expect(
      appendVerifiedPerpetualPaperEvent(h.prisma, owner, {
        ...first,
        kind: "mark",
        positionId: "btc-long",
        markPriceQuote: "1",
      } as PerpetualPaperEvent),
    ).rejects.toBeInstanceOf(PerpetualPaperConflictError);
    h.tamper((data) => {
      if (data.events[0]) data.events[0].payloadSha256 = "0".repeat(64);
    });
    await expect(
      readVerifiedPerpetualPaperAccount(h.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PerpetualPaperIntegrityError);
  });

  it("rolls back an invalid event and denies inaccessible membership", async () => {
    const h = harness();
    await create(h);
    await expect(
      appendVerifiedPerpetualPaperEvent(h.prisma, owner, {
        ...first,
        sequence: 2,
      }),
    ).rejects.toBeInstanceOf(PerpetualPaperConflictError);
    expect(h.snapshot().events).toHaveLength(0);
    h.denyMember();
    await expect(readVerifiedPerpetualPaperAccount(h.prisma, owner, ledgerId))
      .rejects.toBeInstanceOf(PerpetualPaperIntegrityError);
  });
});
