import { createHash, randomUUID } from "node:crypto";
import { TradingInstrumentSchema, TradingPaperPolicySchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  PaperQuoteEvidenceError,
  readVerifiedPaperQuoteEvidence,
  recordSyntheticPaperQuoteEvidence,
} from "./trading-paper-quote-evidence.js";
import { preflightTradingPaperReservation } from "./trading-paper-reservation-preflight.js";
import {
  createDisabledTradingPaperRiskPolicy,
  PaperRiskPolicyIntegrityError,
  readVerifiedTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import {
  appendTradingPaperLedgerEvent,
  createTradingPaperLedger,
  PaperLedgerIntegrityError,
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
  it("P11A persists a disabled/killed paper policy and verifies owner/digest", async () => {
    const ledgerId = `paper-race-${suffix}`;
    const before = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const policy = await createDisabledTradingPaperRiskPolicy(first.prisma, owner, ledgerId, {
      allowedVenues: ["okx"],
      quoteCurrency: "USDT",
      maxAgeMs: 60_000,
      maxSpreadBps: 40,
      maxTriggerDeviationBps: 50,
      maxPositions: 2,
      maxPerIdeaRiskQuote: "20",
      maxDailyLossQuote: "100",
      maxOpenRiskQuote: "40",
      maxTotalExposureQuote: "1500",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    expect(policy).toMatchObject({ mode: "paper_only", enabled: false, killSwitch: true });
    const verified = await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId);
    expect(verified.revision).toBe(0);
    expect(verified.policy).toEqual(policy);
    const noMutation = await preflightTradingPaperReservation(second.prisma, owner, ledgerId, {
      kind: "no_trade",
      signalId: "synthetic-abstain",
      strategyId: "test",
      strategyVersion: "1",
      createdAt: "2026-10-04T08:01:00.000Z",
      expiresAt: "2026-10-04T09:01:00.000Z",
      evidenceIds: ["offline"],
      reason: "no signal",
    });
    expect(noMutation).toMatchObject({
      status: "deny",
      reason: "policy_disabled",
      ledgerRevision: 7,
      policyRevision: 0,
    });
    const [one, two] = await Promise.all([
      preflightTradingPaperReservation(first.prisma, owner, ledgerId, null),
      preflightTradingPaperReservation(second.prisma, owner, ledgerId, null),
    ]);
    expect(one.reason).toBe("policy_disabled");
    expect(two.reason).toBe("policy_disabled");
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(7);
    await expect(
      readVerifiedTradingPaperRiskPolicy(
        second.prisma,
        { spaceId: owner.spaceId, userId: "not-owner" },
        ledgerId,
      ),
    ).rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(before);
    await first.prisma.tradingPaperRiskPolicy.update({
      where: { ledgerId },
      data: { policySha256: "0".repeat(64) },
    });
    await expect(
      readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    await expect(
      preflightTradingPaperReservation(second.prisma, owner, ledgerId, null),
    ).rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(before);
  });
  it("P11B-0 refuses an externally flipped policy without trusted market data", async () => {
    const ledgerId = `paper-preflight-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: "2026-10-04T08:00:00.000Z",
      quoteCurrency: "USDT",
      initialBalanceQuote: "1000",
    });
    const disabled = await createDisabledTradingPaperRiskPolicy(first.prisma, owner, ledgerId, {
      allowedVenues: ["okx"],
      quoteCurrency: "USDT",
      maxAgeMs: 60_000,
      maxSpreadBps: 40,
      maxTriggerDeviationBps: 50,
      maxPositions: 2,
      maxPerIdeaRiskQuote: "20",
      maxDailyLossQuote: "100",
      maxOpenRiskQuote: "40",
      maxTotalExposureQuote: "1500",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    // Simulate a privileged DB edit in the disposable test DB. This does NOT
    // introduce any policy enable method into the Rakazo application.
    const switched = TradingPaperPolicySchema.parse({
      ...disabled,
      enabled: true,
      killSwitch: false,
    });
    const policySha256 = createHash("sha256")
      .update(JSON.stringify(switched), "utf8")
      .digest("hex");
    await first.prisma.tradingPaperRiskPolicy.update({
      where: { ledgerId },
      data: { policy: JSON.parse(JSON.stringify(switched)), policySha256 },
    });
    const candidate = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: "synthetic-untrusted-quote",
      strategyId: "offline-fixture",
      strategyVersion: "1",
      createdAt: "2026-10-04T08:00:30.000Z",
      expiresAt: "2026-10-04T08:30:00.000Z",
      evidenceIds: ["fixture-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "offline-test-only",
      rationale: "Synthetic, not a live recommendation",
      riskBudgetQuote: null,
      maxSlippageBps: null,
    };
    const result = await preflightTradingPaperReservation(
      second.prisma,
      owner,
      ledgerId,
      candidate,
    );
    expect(result).toEqual({
      status: "deny",
      reason: "trusted_market_snapshot_unavailable",
      ledgerRevision: 0,
      policyRevision: 0,
    });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(0);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(0);
    await first.prisma.tradingPaperLedger.update({
      where: { id: ledgerId },
      data: { projectionSha256: "f".repeat(64) },
    });
    await expect(
      preflightTradingPaperReservation(second.prisma, owner, ledgerId, candidate),
    ).rejects.toBeInstanceOf(PaperLedgerIntegrityError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(0);
  });
  it("P11B-1 persists only bounded offline evidence with owner and checksum", async () => {
    const ledgerId = `paper-evidence-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: "2026-10-04T08:00:00.000Z",
      quoteCurrency: "USDT",
      initialBalanceQuote: "1000",
    });
    const fetchedAt = new Date().toISOString();
    const ticker = {
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      observedAt: fetchedAt,
      fetchedAt,
      bid: "100",
      ask: "100.1",
      quoteVolume24h: "100000",
    };
    await expect(
      recordSyntheticPaperQuoteEvidence(first.prisma, owner, ledgerId, { ...ticker, bid: "101" }),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    await expect(
      recordSyntheticPaperQuoteEvidence(first.prisma, owner, ledgerId, {
        ...ticker,
        observedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    const saved = await recordSyntheticPaperQuoteEvidence(first.prisma, owner, ledgerId, ticker);
    expect(saved.source).toBe("offline_fixture");
    const recovered = await readVerifiedPaperQuoteEvidence(second.prisma, owner, ledgerId, saved.id);
    expect(recovered.ticker).toMatchObject(ticker);
    await expect(
      readVerifiedPaperQuoteEvidence(
        second.prisma,
        { ...owner, userId: "not-owner" },
        ledgerId,
        saved.id,
      ),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(0);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(0);
    await first.prisma.tradingPaperQuoteEvidence.update({
      where: { id: saved.id },
      data: { payloadSha256: "f".repeat(64) },
    });
    await expect(
      readVerifiedPaperQuoteEvidence(second.prisma, owner, ledgerId, saved.id),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
  });

});
