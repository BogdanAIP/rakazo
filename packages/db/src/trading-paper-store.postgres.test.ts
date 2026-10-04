import { randomUUID } from "node:crypto";
import { TradingInstrumentSchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  appendTradingPaperLedgerEvent,
  createTradingPaperLedger,
  readVerifiedTradingPaperLedger,
} from "./trading-paper-store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/** Real PostgreSQL transactions using two independent Prisma clients and pg pools.
 * Only runs in the testkit's disposable, migrated PostgreSQL database. */
describePostgres("paper journal concurrent PostgreSQL writers", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-race-user-${suffix}`,
    spaceId: `paper-race-space-${suffix}`,
  };
  const orgId = `paper-race-org-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  beforeAll(() => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-race-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-race-second" });
  });
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
  const reserve = (ledgerId: string, sequence: number, variant: string) => ({
    ledgerId,
    eventId: `reserve-${sequence}-${variant}`,
    kind: "reserve" as const,
    sequence,
    recordedAt: new Date(Date.parse("2026-10-04T08:00:00.000Z") + sequence * 60_000).toISOString(),
    reservationId: `hold-${sequence}-${variant}`,
    signalId: `signal-${sequence}-${variant}`,
    market,
    quantityBase: "1",
    maxSpendQuote: "20",
    expiresAt: "2026-10-04T10:00:00.000Z",
  });

  afterAll(async () => {
    if (!first || !second) return;
    try {
      await first.prisma.organization.deleteMany({ where: { id: orgId } });
      await first.prisma.user.deleteMany({ where: { id: owner.userId } });
    } finally {
      await Promise.allSettled([first.prisma.$disconnect(), second.prisma.$disconnect()]);
      await Promise.allSettled([first.pool.end(), second.pool.end()]);
    }
  });

  it("creates an authenticated, isolated test owner and an inert ledger", async () => {
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Paper Race Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Paper Race Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-race-member-${suffix}`,
        organizationId: orgId,
        userId: owner.userId,
        role: "member",
        createdAt,
      },
    });
    await first.prisma.space.create({
      data: {
        id: owner.spaceId,
        organizationId: orgId,
        name: "Paper Race Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-race-space-member-${suffix}`,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
    });
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId: `paper-race-${suffix}`,
      openedAt: "2026-10-04T08:00:00.000Z",
      quoteCurrency: "USDT",
      initialBalanceQuote: "1000",
    });
    expect(
      (await readVerifiedTradingPaperLedger(second.prisma, owner, `paper-race-${suffix}`))
        .availableQuote,
    ).toBe("1000");
  });

  it("serializes distinct competing events for the same sequence without double-spend", async () => {
    const ledgerId = `paper-race-${suffix}`;
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      const a = reserve(ledgerId, sequence, "a");
      const b = reserve(ledgerId, sequence, "b");
      const outcomes = await Promise.allSettled([
        appendTradingPaperLedgerEvent(first.prisma, owner, a),
        appendTradingPaperLedgerEvent(second.prisma, owner, b),
      ]);
      const accepted = outcomes.filter(
        (outcome) => outcome.status === "fulfilled" && outcome.value.status === "appended",
      );
      expect(accepted).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const state = await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId);
      expect(state.nextSequence).toBe(sequence + 1);
      expect(state.acceptedEvents).toBe(sequence);
      expect(state.reservedQuote).toBe(String(sequence * 20));
      expect(state.availableQuote).toBe(String(1000 - sequence * 20));
      expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
        sequence,
      );
      expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
        sequence,
      );
      const winner = outcomes[0]?.status === "fulfilled" ? a : b;
      const retry = await appendTradingPaperLedgerEvent(second.prisma, owner, winner);
      expect(retry.status).toBe("duplicate");
      expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
        sequence,
      );
    }
  });

  it("deduplicates the same event submitted concurrently and survives a new client", async () => {
    const ledgerId = `paper-race-${suffix}`;
    const event = reserve(ledgerId, 7, "same");
    const outcomes = await Promise.allSettled([
      appendTradingPaperLedgerEvent(first.prisma, owner, event),
      appendTradingPaperLedgerEvent(second.prisma, owner, event),
    ]);
    expect(
      outcomes.filter(
        (outcome) => outcome.status === "fulfilled" && outcome.value.status === "appended",
      ),
    ).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) => outcome.status === "fulfilled" && outcome.value.status === "duplicate",
      ).length + outcomes.filter((outcome) => outcome.status === "rejected").length,
    ).toBe(1);
    const restarted = createDb(databaseUrl!, {
      poolMax: 1,
      applicationName: "paper-race-restart",
    });
    try {
      const state = await readVerifiedTradingPaperLedger(restarted.prisma, owner, ledgerId);
      expect(state.acceptedEvents).toBe(7);
      expect(state.reservedQuote).toBe("140");
      expect(state.availableQuote).toBe("860");
      expect(await restarted.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
        7,
      );
      expect((await appendTradingPaperLedgerEvent(restarted.prisma, owner, event)).status).toBe(
        "duplicate",
      );
    } finally {
      await restarted.prisma.$disconnect();
      await restarted.pool.end();
    }
  });
});
