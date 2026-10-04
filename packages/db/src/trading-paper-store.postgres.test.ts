import { createHash, randomUUID } from "node:crypto";
import { TradingInstrumentSchema, TradingPaperPolicySchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  PaperQuoteEvidenceError,
  readVerifiedPaperQuoteEvidence,
  readVerifiedPublicPaperQuoteEvidence,
  recordPublicAdapterPaperQuoteEvidence,
  recordSyntheticPaperQuoteEvidence,
} from "./trading-paper-quote-evidence.js";
import { preflightTradingPaperReservation } from "./trading-paper-reservation-preflight.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
  PaperRiskPolicyIntegrityError,
  readVerifiedTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import {
  PaperStopGuardIntegrityError,
  recordTradingPaperStopGuardForOpenPosition,
} from "./trading-paper-stop-guard.js";
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
    const recovered = await readVerifiedPaperQuoteEvidence(
      second.prisma,
      owner,
      ledgerId,
      saved.id,
    );
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
  it("P11B-2 labels public adapter evidence and verifies metadata and owner", async () => {
    const ledgerId = `paper-public-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: "2026-10-04T08:00:00.000Z",
      quoteCurrency: "USDT",
      initialBalanceQuote: "1000",
    });
    const at = new Date().toISOString();
    const ticker = {
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      observedAt: at,
      fetchedAt: at,
      bid: "100",
      ask: "100.1",
      quoteVolume24h: "100000",
    };
    await expect(
      recordPublicAdapterPaperQuoteEvidence(first.prisma, owner, ledgerId, market, {
        ...ticker,
        symbol: "WRONG-USDT",
      }),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    await expect(
      recordPublicAdapterPaperQuoteEvidence(first.prisma, owner, ledgerId, market, {
        ...ticker,
        bid: "101",
      }),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    await expect(
      recordPublicAdapterPaperQuoteEvidence(first.prisma, owner, ledgerId, market, {
        ...ticker,
        observedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    const saved = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      ticker,
    );
    expect(saved.source).toBe("public_adapter_observation");
    const recovered = await readVerifiedPublicPaperQuoteEvidence(
      second.prisma,
      owner,
      ledgerId,
      saved.id,
    );
    expect(recovered.market).toEqual(market);
    expect(recovered.ticker).toMatchObject(ticker);
    await expect(
      readVerifiedPaperQuoteEvidence(second.prisma, owner, ledgerId, saved.id),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    await expect(
      readVerifiedPublicPaperQuoteEvidence(
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
      data: { market: { ...market, quantityIncrement: "0.1" } },
    });
    await expect(
      readVerifiedPublicPaperQuoteEvidence(second.prisma, owner, ledgerId, saved.id),
    ).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
  });
  it("P11B-3 checks a persisted public quote inside preflight and ALWAYS denies", async () => {
    const ledgerId = `paper-decision-${suffix}`;
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
    // Privileged TEST DATABASE edit only. There is NO runtime policy-enable API.
    const changed = TradingPaperPolicySchema.parse({
      ...disabled,
      enabled: true,
      killSwitch: false,
    });
    await first.prisma.tradingPaperRiskPolicy.update({
      where: { ledgerId },
      data: {
        policy: JSON.parse(JSON.stringify(changed)),
        policySha256: createHash("sha256").update(JSON.stringify(changed), "utf8").digest("hex"),
      },
    });
    const createdAt = new Date(Date.now() - 1000).toISOString();
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: "synthetic-p11b3",
      strategyId: "offline-only",
      strategyVersion: "1",
      createdAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evidenceIds: ["model-note-is-not-a-quote"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture-only",
      rationale: "Synthetic database verification only",
      riskBudgetQuote: null,
      maxSlippageBps: null,
    };
    const run = (candidate: unknown, evidenceId: string | null = null) =>
      preflightTradingPaperReservation(second.prisma, owner, ledgerId, candidate, evidenceId);
    expect((await run(signal)).reason).toBe("trusted_market_snapshot_unavailable");
    const at = new Date().toISOString();
    const ticker = {
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      observedAt: at,
      fetchedAt: at,
      bid: "100",
      ask: "100.1",
      quoteVolume24h: "100000",
    };
    const offline = await recordSyntheticPaperQuoteEvidence(first.prisma, owner, ledgerId, ticker);
    expect((await run(signal, offline.id)).reason).toBe("trusted_market_snapshot_unavailable");
    const publicEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      ticker,
    );
    expect((await run(signal, publicEvidence.id)).reason).toBe("reserve_authority_unavailable");
    expect(
      (await run({ ...signal, market: { ...market, priceIncrement: "0.1" } }, publicEvidence.id))
        .reason,
    ).toBe("market_snapshot_mismatch");
    expect((await run({ ...signal, entryTrigger: "120" }, publicEvidence.id)).reason).toBe(
      "market_trigger_deviation_exceeded",
    );
    expect((await run({ ...signal, expiresAt: createdAt }, publicEvidence.id)).reason).toBe(
      "invalid_signal",
    );
    const wide = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      { ...ticker, bid: "90" },
    );
    expect((await run(signal, wide.id)).reason).toBe("market_spread_exceeded");
    // Simulates aged but internally consistent evidence in disposable CI only.
    const oldAt = new Date(Date.now() - 120_000).toISOString();
    const stale = { ...ticker, observedAt: oldAt, fetchedAt: oldAt };
    await first.prisma.tradingPaperQuoteEvidence.update({
      where: { id: publicEvidence.id },
      data: {
        payload: JSON.parse(JSON.stringify(stale)),
        payloadSha256: createHash("sha256")
          .update(JSON.stringify(["public_adapter_observation", market, stale]), "utf8")
          .digest("hex"),
        observedAt: new Date(oldAt),
        fetchedAt: new Date(oldAt),
      },
    });
    expect((await run(signal, publicEvidence.id)).reason).toBe("market_snapshot_stale");
    await first.prisma.tradingPaperQuoteEvidence.update({
      where: { id: wide.id },
      data: { payloadSha256: "f".repeat(64) },
    });
    await expect(run(signal, wide.id)).rejects.toBeInstanceOf(PaperQuoteEvidenceError);
    const forgedPolicy = { ...changed, maxSpreadBps: 30 };
    await first.prisma.tradingPaperRiskPolicy.update({
      where: { ledgerId },
      data: { policy: JSON.parse(JSON.stringify(forgedPolicy)) },
    });
    await expect(run(signal, offline.id)).rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(0);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(0);
    expect(
      (await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId)).availableQuote,
    ).toBe("1000");
  });
  it("P11B-4 derives daily loss/exposure from persisted fills and fails closed on missing stops", async () => {
    const ledgerId = `paper-derived-risk-${suffix}`;
    const now = Date.now();
    const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: at(-20_000),
      quoteCurrency: "USDT",
      initialBalanceQuote: "1000",
    });
    const disabled = await createDisabledTradingPaperRiskPolicy(first.prisma, owner, ledgerId, {
      allowedVenues: ["okx"],
      quoteCurrency: "USDT",
      maxAgeMs: 60_000,
      maxSpreadBps: 40,
      maxTriggerDeviationBps: 50,
      maxPositions: 3,
      maxPerIdeaRiskQuote: "20",
      maxDailyLossQuote: "5",
      maxOpenRiskQuote: "40",
      maxTotalExposureQuote: "1500",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const enabled = TradingPaperPolicySchema.parse({
      ...disabled,
      enabled: true,
      killSwitch: false,
    });
    const writePolicy = async (policy: typeof enabled) =>
      first.prisma.tradingPaperRiskPolicy.update({
        where: { ledgerId },
        data: {
          policy: JSON.parse(JSON.stringify(policy)),
          policySha256: createHash("sha256").update(JSON.stringify(policy), "utf8").digest("hex"),
        },
      });
    await writePolicy(enabled);
    const events = [
      {
        ledgerId,
        eventId: "risk-reserve-loss",
        sequence: 1,
        kind: "reserve",
        recordedAt: at(-18_000),
        reservationId: "risk-loss",
        signalId: "risk-loss-signal",
        market,
        quantityBase: "1",
        maxSpendQuote: "110",
        expiresAt: at(60_000),
      },
      {
        ledgerId,
        eventId: "risk-buy-loss",
        sequence: 2,
        kind: "fill_buy",
        recordedAt: at(-17_000),
        reservationId: "risk-loss",
        quantityBase: "1",
        executedPriceQuote: "100",
        feeQuote: "0",
      },
      {
        ledgerId,
        eventId: "risk-sell-loss",
        sequence: 3,
        kind: "fill_sell",
        recordedAt: at(-16_000),
        positionId: "risk-loss",
        quantityBase: "1",
        executedPriceQuote: "90",
        feeQuote: "0",
      },
      {
        ledgerId,
        eventId: "risk-reserve-open",
        sequence: 4,
        kind: "reserve",
        recordedAt: at(-15_000),
        reservationId: "risk-open",
        signalId: "risk-open-signal",
        market,
        quantityBase: "1",
        maxSpendQuote: "110",
        expiresAt: at(60_000),
      },
      {
        ledgerId,
        eventId: "risk-buy-open",
        sequence: 5,
        kind: "fill_buy",
        recordedAt: at(-14_000),
        reservationId: "risk-open",
        quantityBase: "1",
        executedPriceQuote: "100",
        feeQuote: "0",
      },
    ] as const;
    for (const event of events) {
      await appendTradingPaperLedgerEvent(first.prisma, owner, event);
    }
    const quoteAt = new Date().toISOString();
    const evidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: quoteAt,
        fetchedAt: quoteAt,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: "risk-new-signal",
      strategyId: "risk-test",
      strategyVersion: "1",
      createdAt: at(-1000),
      expiresAt: at(60_000),
      evidenceIds: ["not-authority"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "Synthetic risk-state verification",
      riskBudgetQuote: null,
      maxSlippageBps: null,
    };
    const beforeEvents = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const beforeOutbox = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });
    expect(
      (await preflightTradingPaperReservation(second.prisma, owner, ledgerId, signal, evidence.id))
        .reason,
    ).toBe("daily_loss_limit_exceeded");

    const relaxed = TradingPaperPolicySchema.parse({
      ...enabled,
      maxDailyLossQuote: "100",
    });
    await writePolicy(relaxed);
    expect(
      (await preflightTradingPaperReservation(second.prisma, owner, ledgerId, signal, evidence.id))
        .reason,
    ).toBe("stop_risk_unavailable");

    await recordTradingPaperStopGuardForOpenPosition(
      first.prisma,
      owner,
      ledgerId,
      "risk-open",
      "95",
    );
    expect(
      (await preflightTradingPaperReservation(second.prisma, owner, ledgerId, signal, evidence.id))
        .reason,
    ).toBe("reserve_authority_unavailable");

    const risky = {
      ledgerId,
      positionId: "risk-open",
      signalId: "risk-open-signal",
      symbol: "SOL-USDT",
      quantityBase: "1",
      stopPriceQuote: "50",
      openedSequence: 5,
    };
    await first.prisma.tradingPaperStopGuard.update({
      where: { ledgerId_positionId: { ledgerId, positionId: "risk-open" } },
      data: {
        stopPriceQuote: risky.stopPriceQuote,
        guardSha256: createHash("sha256")
          .update(
            JSON.stringify([
              risky.ledgerId,
              risky.positionId,
              risky.signalId,
              risky.symbol,
              risky.quantityBase,
              risky.stopPriceQuote,
              risky.openedSequence,
            ]),
            "utf8",
          )
          .digest("hex"),
      },
    });
    expect(
      (await preflightTradingPaperReservation(second.prisma, owner, ledgerId, signal, evidence.id))
        .reason,
    ).toBe("open_stop_risk_limit_exceeded");

    await first.prisma.tradingPaperStopGuard.update({
      where: { ledgerId_positionId: { ledgerId, positionId: "risk-open" } },
      data: { guardSha256: "f".repeat(64) },
    });
    await expect(
      preflightTradingPaperReservation(second.prisma, owner, ledgerId, signal, evidence.id),
    ).rejects.toBeInstanceOf(PaperStopGuardIntegrityError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      beforeEvents,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      beforeOutbox,
    );
  });
  it("P11B-6 binds paper control to an executing explicit effect", async () => {
    const ledgerId = `paper-control-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: "2026-10-04T10:00:00.000Z",
      quoteCurrency: "USDT",
      initialBalanceQuote: "1000",
    });
    await createDisabledTradingPaperRiskPolicy(first.prisma, owner, ledgerId, {
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
    const botId = `paper-control-bot-${suffix}`;
    const threadId = `paper-control-thread-${suffix}`;
    const taskId = `paper-control-task-${suffix}`;
    const runId = `paper-control-run-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper Control Fixture",
        color: "#000000",
      },
    });
    await first.prisma.thread.create({
      data: { id: threadId, spaceId: owner.spaceId, botId, userId: owner.userId },
    });
    await first.prisma.task.create({
      data: {
        id: taskId,
        spaceId: owner.spaceId,
        botId,
        threadId,
        userId: owner.userId,
        prompt: "paper control fixture",
        status: "running",
      },
    });
    await first.prisma.run.create({
      data: {
        id: runId,
        spaceId: owner.spaceId,
        botId,
        threadId,
        taskId,
        userId: owner.userId,
        status: "running",
        trigger: "user",
      },
    });
    const makeEffect = (
      label: string,
      action: "enable" | "disable",
      revision: number,
      status = "executing",
    ) =>
      first.prisma.externalEffect.create({
        data: {
          id: `paper-control-effect-${label}-${suffix}`,
          spaceId: owner.spaceId,
          runId,
          kind: "paper_trading_control",
          idempotencyKey: `paper-control-key-${label}-${suffix}`,
          status,
          request: { action, ledger_id: ledgerId, expected_policy_revision: revision },
        },
      });
    const beforeEvents = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const beforeOutbox = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });

    const enable = await makeEffect("enable", "enable", 0);
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, enable.id),
    ).resolves.toEqual({
      ok: true,
      mode: "paper_only",
      action: "enable",
      ledgerId,
      policyRevision: 1,
      enabled: true,
      killSwitch: false,
    });
    expect(
      (await second.prisma.externalEffect.findUniqueOrThrow({ where: { id: enable.id } })).status,
    ).toBe("completed");
    expect(await second.prisma.tradingPaperPolicyAudit.count({ where: { ledgerId } })).toBe(1);

    const stale = await makeEffect("stale", "disable", 0);
    await expect(applyApprovedTradingPaperControl(second.prisma, owner, stale.id)).resolves.toEqual(
      {
        ok: false,
        mode: "paper_only",
        action: "disable",
        ledgerId,
        error: "stale_policy_revision",
        currentPolicyRevision: 1,
      },
    );
    expect(await second.prisma.tradingPaperPolicyAudit.count({ where: { ledgerId } })).toBe(1);

    const disable = await makeEffect("disable", "disable", 1);
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, disable.id),
    ).resolves.toEqual({
      ok: true,
      mode: "paper_only",
      action: "disable",
      ledgerId,
      policyRevision: 2,
      enabled: false,
      killSwitch: true,
    });
    expect(await second.prisma.tradingPaperPolicyAudit.count({ where: { ledgerId } })).toBe(2);
    expect(await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId)).toMatchObject({
      revision: 2,
      policy: { mode: "paper_only", enabled: false, killSwitch: true },
    });

    const unapproved = await makeEffect("unapproved", "enable", 2, "intended");
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, unapproved.id),
    ).rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    expect(
      (await second.prisma.externalEffect.findUniqueOrThrow({ where: { id: unapproved.id } }))
        .status,
    ).toBe("intended");
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      beforeEvents,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      beforeOutbox,
    );
  });
});
