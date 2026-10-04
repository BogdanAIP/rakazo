import { TradingInstrumentSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  appendTradingPaperLedgerEvent,
  createTradingPaperLedger,
  PaperLedgerConflictError,
  PaperLedgerIntegrityError,
  readVerifiedTradingPaperLedger,
} from "./trading-paper-store.js";

type Row = Record<string, unknown>;
type Snapshot = { ledger: Row | null; events: Row[]; outbox: Row[] };
const owner = { spaceId: "space-1", userId: "user-1" };
const market = TradingInstrumentSchema.parse({
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
});
const reserve = {
  ledgerId: "paper-1",
  eventId: "event-1",
  kind: "reserve" as const,
  sequence: 1,
  recordedAt: "2026-10-04T08:01:00.000Z",
  reservationId: "reservation-1",
  signalId: "signal-1",
  market,
  quantityBase: "2",
  maxSpendQuote: "220",
  expiresAt: "2026-10-04T09:00:00.000Z",
};
const buy = {
  ledgerId: "paper-1",
  eventId: "event-2",
  kind: "fill_buy" as const,
  sequence: 2,
  recordedAt: "2026-10-04T08:02:00.000Z",
  reservationId: "reservation-1",
  quantityBase: "2",
  executedPriceQuote: "100.12",
  feeQuote: "0.20",
};
function harness() {
  let snapshot: Snapshot = { ledger: null, events: [], outbox: [] };
  let allow = true;
  let failOutbox = false;
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
    const working = structuredClone(snapshot);
    const tx = {
      spaceMember: {
        findFirst: vi.fn(async ({ where }: { where: Row }) =>
          allow && where.spaceId === owner.spaceId && where.userId === owner.userId
            ? { id: "membership-1" }
            : null,
        ),
      },
      tradingPaperLedger: {
        findFirst: vi.fn(async ({ where }: { where: Row }) =>
          working.ledger &&
          working.ledger.id === where.id &&
          working.ledger.spaceId === where.spaceId &&
          working.ledger.ownerUserId === where.ownerUserId
            ? working.ledger
            : null,
        ),
        create: vi.fn(async ({ data }: { data: Row }) => {
          if (working.ledger) throw new Error("duplicate ledger");
          working.ledger = { ...data };
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
          ) return { count: 0 };
          working.ledger = {
            ...working.ledger,
            ...data,
            version: (working.ledger.version as number) + 1,
          };
          return { count: 1 };
        }),
      },
      tradingPaperLedgerEvent: {
        findMany: vi.fn(async ({ where }: { where: Row }) =>
          working.events.filter((r) => r.ledgerId === where.ledgerId)
            .sort((a, b) => (a.sequence as number) - (b.sequence as number)),
        ),
        create: vi.fn(async ({ data }: { data: Row }) => {
          if (working.events.some((entry) =>
            entry.ledgerId === data.ledgerId &&
            (entry.eventId === data.eventId || entry.sequence === data.sequence)
          )) throw new Error("duplicate paper event");
          working.events.push({ ...data });
          return data;
        }),
      },
      tradingPaperLedgerOutbox: {
        create: vi.fn(async ({ data }: { data: Row }) => {
          if (failOutbox) throw new Error("outbox insert unavailable");
          working.outbox.push({ ...data });
          return data;
        }),
      },
    };
    const result = await callback(tx);
    snapshot = working; // commit only after ALL operations complete
    return result;
  });
  return {
    prisma: { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">,
    transaction,
    snapshot: () => structuredClone(snapshot),
    tamper: (mutate: (data: Snapshot) => void) => mutate(snapshot),
    denyMembership: () => { allow = false; },
    breakOutbox: () => { failOutbox = true; },
  };
}
const create = (h: ReturnType<typeof harness>) =>
  createTradingPaperLedger(h.prisma, owner, {
    ledgerId: "paper-1",
    openedAt: "2026-10-04T08:00:00.000Z",
    quoteCurrency: "USDT",
    initialBalanceQuote: "1000",
  });

describe("trusted-service-only transactional paper journal", () => {
  it("creates a scoped inert journal, atomically appends event + projection + outbox", async () => {
    const h = harness();
    expect((await create(h)).availableQuote).toBe("1000");
    const created = h.snapshot();
    expect(created.ledger?.version).toBe(0);
    expect(created.events).toHaveLength(0);
    expect(created.outbox).toHaveLength(0);
    const a = await appendTradingPaperLedgerEvent(h.prisma, owner, reserve);
    expect(a.status).toBe("appended");
    expect(a.state.availableQuote).toBe("780");
    const data = h.snapshot();
    expect(data.ledger?.version).toBe(1);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.events[0]?.chainSha256).toBe(data.ledger?.headSha256);
    expect(data.outbox).toEqual([{ ledgerId: "paper-1", sequence: 1, status: "pending" }]);
    expect(h.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    const b = await appendTradingPaperLedgerEvent(h.prisma, owner, buy);
    expect(b.state.availableQuote).toBe("799.56");
    expect(b.state.openCostBasisQuote).toBe("200.44");
    expect((await readVerifiedTradingPaperLedger(h.prisma, owner, "paper-1")).bookEquityQuote)
      .toBe("1000");
  });

  it("an identical event retry is inert; conflicting ID, sequence or actor fails closed", async () => {
    const h = harness();
    await create(h);
    await appendTradingPaperLedgerEvent(h.prisma, owner, reserve);
    const before = h.snapshot();
    const duplicate = await appendTradingPaperLedgerEvent(h.prisma, owner, reserve);
    expect(duplicate.status).toBe("duplicate");
    expect(h.snapshot()).toEqual(before);
    await expect(appendTradingPaperLedgerEvent(h.prisma, owner, {
      ...reserve, maxSpendQuote: "210",
    })).rejects.toBeInstanceOf(PaperLedgerConflictError);
    await expect(appendTradingPaperLedgerEvent(h.prisma, owner, {
      ...buy, sequence: 3,
    })).rejects.toBeInstanceOf(PaperLedgerConflictError);
    await expect(readVerifiedTradingPaperLedger(h.prisma, {
      spaceId: owner.spaceId, userId: "another-user",
    }, "paper-1")).rejects.toBeInstanceOf(PaperLedgerIntegrityError);
    expect(h.snapshot()).toEqual(before);
  });

  it("detects payload, chain and projection corruption before any further append", async () => {
    const h = harness();
    await create(h);
    await appendTradingPaperLedgerEvent(h.prisma, owner, reserve);
    h.tamper((d) => { d.events[0]!.payloadSha256 = "0".repeat(64); });
    await expect(readVerifiedTradingPaperLedger(h.prisma, owner, "paper-1")).rejects
      .toBeInstanceOf(PaperLedgerIntegrityError);
    await expect(appendTradingPaperLedgerEvent(h.prisma, owner, buy)).rejects
      .toBeInstanceOf(PaperLedgerIntegrityError);
    const h2 = harness();
    await create(h2);
    await appendTradingPaperLedgerEvent(h2.prisma, owner, reserve);
    h2.tamper((d) => { d.ledger!.projectionSha256 = "1".repeat(64); });
    await expect(readVerifiedTradingPaperLedger(h2.prisma, owner, "paper-1")).rejects
      .toBeInstanceOf(PaperLedgerIntegrityError);
  });

  it("rolls back revision and cash reservation when outbox insert fails", async () => {
    const h = harness();
    await create(h);
    const before = h.snapshot();
    h.breakOutbox();
    await expect(appendTradingPaperLedgerEvent(h.prisma, owner, reserve)).rejects.toThrow(
      "outbox insert unavailable",
    );
    expect(h.snapshot()).toEqual(before);
  });

  it("does not create or append after membership is revoked", async () => {
    const h = harness();
    h.denyMembership();
    await expect(create(h)).rejects.toBeInstanceOf(PaperLedgerIntegrityError);
    const another = harness();
    await create(another);
    another.denyMembership();
    await expect(appendTradingPaperLedgerEvent(another.prisma, owner, reserve)).rejects
      .toBeInstanceOf(PaperLedgerIntegrityError);
    expect(another.snapshot().events).toHaveLength(0);
  });
});
