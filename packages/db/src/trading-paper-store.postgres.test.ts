import { createHash, randomUUID } from "node:crypto";
import { TradingInstrumentSchema, TradingPaperPolicySchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { closeTradingPaperPositionOnStop, PaperCloseConflictError } from "./trading-paper-close.js";
import {
  fillApprovedTradingPaperReservation,
  PaperFillConflictError,
} from "./trading-paper-fill.js";
import {
  auditTradingPaperLifecycle,
  PaperLifecycleAuditError,
} from "./trading-paper-lifecycle-audit.js";
import {
  applyApprovedTradingPaperProtectiveExitControl,
  PaperProtectiveExitAuthorityIntegrityError,
  readVerifiedTradingPaperProtectiveExitAuthority,
} from "./trading-paper-protective-exit-authority.js";
import {
  PaperQuoteEvidenceError,
  readVerifiedPaperQuoteEvidence,
  readVerifiedPublicPaperQuoteEvidence,
  recordPublicAdapterPaperQuoteEvidence,
  recordSyntheticPaperQuoteEvidence,
} from "./trading-paper-quote-evidence.js";
import { reconcileTradingPaperReservations } from "./trading-paper-reconciliation.js";
import { readTradingPaperRecoveryStatus } from "./trading-paper-recovery-status.js";
import { preflightTradingPaperReservation } from "./trading-paper-reservation-preflight.js";
import {
  PaperReservationConflictError,
  reserveApprovedTradingPaperSignal,
} from "./trading-paper-reserve.js";
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
  const makePaperControlEffect = async (
    ledgerId: string,
    label: string,
    action: "enable" | "disable",
    revision: number,
  ) => {
    const botId = `paper-control-helper-bot-${label}-${suffix}`;
    const threadId = `paper-control-helper-thread-${label}-${suffix}`;
    const taskId = `paper-control-helper-task-${label}-${suffix}`;
    const runId = `paper-control-helper-run-${label}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper Control Helper",
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
        prompt: "paper control helper",
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
    return first.prisma.externalEffect.create({
      data: {
        id: `paper-control-helper-effect-${label}-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind: "paper_trading_control",
        idempotencyKey: `paper-control-helper-key-${label}-${suffix}`,
        status: "executing",
        request: { action, ledger_id: ledgerId, expected_policy_revision: revision },
      },
    });
  };

  const makePaperPositionControlEffect = async (
    ledgerId: string,
    positionId: string,
    label: string,
    revision: number,
  ) => {
    const botId = `paper-position-control-helper-bot-${label}-${suffix}`;
    const threadId = `paper-position-control-helper-thread-${label}-${suffix}`;
    const taskId = `paper-position-control-helper-task-${label}-${suffix}`;
    const runId = `paper-position-control-helper-run-${label}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper Position Control Helper",
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
        prompt: "paper position control helper",
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
    return first.prisma.externalEffect.create({
      data: {
        id: `paper-position-control-helper-effect-${label}-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind: "paper_position_control",
        idempotencyKey: `paper-position-control-helper-key-${label}-${suffix}`,
        status: "executing",
        request: {
          action: "authorize_protective_stop_exit",
          ledger_id: ledgerId,
          position_id: positionId,
          expected_policy_revision: revision,
        },
      },
    });
  };

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
  it("P11B-7 atomically reserves once, replays idempotently and rejects changed same-signal input", async () => {
    const ledgerId = `paper-b7-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 20_000).toISOString(),
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
      maxTotalExposureQuote: "500",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const botId = `paper-b7-bot-${suffix}`;
    const threadId = `paper-b7-thread-${suffix}`;
    const taskId = `paper-b7-task-${suffix}`;
    const runId = `paper-b7-run-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper B7 Fixture",
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
        prompt: "paper b7 fixture",
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
    const effect = await first.prisma.externalEffect.create({
      data: {
        id: `paper-b7-enable-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind: "paper_trading_control",
        idempotencyKey: `paper-b7-enable-key-${suffix}`,
        status: "executing",
        request: { action: "enable", ledger_id: ledgerId, expected_policy_revision: 0 },
      },
    });
    await applyApprovedTradingPaperControl(first.prisma, owner, effect.id);

    const at = new Date().toISOString();
    const evidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: at,
        fetchedAt: at,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `b7-signal-${suffix}`,
      strategyId: "b7-fixture",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "Synthetic B7 verification",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;

    const firstResult = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      evidence.id,
    );
    expect(firstResult.status).toBe("reserved");
    if (firstResult.status !== "reserved") throw new Error("expected synthetic reservation");
    expect(firstResult.mode).toBe("paper_only");
    expect(firstResult.quantityBase).not.toBe("0");
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperReservationDecision.count({ where: { ledgerId } })).toBe(
      1,
    );
    const ledger = await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId);
    expect(ledger.reservations).toHaveLength(1);
    expect(ledger.reservations[0]?.reservationId).toBe(firstResult.reservationId);
    expect(ledger.reservedQuote).toBe(firstResult.heldQuote);

    await expect(
      reserveApprovedTradingPaperSignal(second.prisma, owner, ledgerId, signal, evidence.id),
    ).resolves.toMatchObject({
      status: "duplicate",
      reservationId: firstResult.reservationId,
      eventId: firstResult.eventId,
    });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(1);

    await expect(
      reserveApprovedTradingPaperSignal(
        second.prisma,
        owner,
        ledgerId,
        { ...signal, entryTrigger: "100.2" },
        evidence.id,
      ),
    ).rejects.toBeInstanceOf(PaperReservationConflictError);
  });

  it("P11B-7 requires a B6 enable audit and serializes competing candidates to one hold", async () => {
    const makeLedger = async (label: string, audited: boolean) => {
      const ledgerId = `paper-b7-race-${label}-${suffix}`;
      await createTradingPaperLedger(first.prisma, owner, {
        ledgerId,
        openedAt: new Date(Date.now() - 20_000).toISOString(),
        quoteCurrency: "USDT",
        initialBalanceQuote: "500",
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
        maxTotalExposureQuote: "300",
        assumedFeeBpsPerSide: 10,
        assumedSlippageBpsPerSide: 10,
      });
      if (audited) {
        const botId = `paper-b7-race-bot-${label}-${suffix}`;
        const threadId = `paper-b7-race-thread-${label}-${suffix}`;
        const taskId = `paper-b7-race-task-${label}-${suffix}`;
        const runId = `paper-b7-race-run-${label}-${suffix}`;
        await first.prisma.bot.create({
          data: {
            id: botId,
            spaceId: owner.spaceId,
            userId: owner.userId,
            name: "B7 Race",
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
            prompt: "b7 race",
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
        const effect = await first.prisma.externalEffect.create({
          data: {
            id: `paper-b7-race-effect-${label}-${suffix}`,
            spaceId: owner.spaceId,
            runId,
            kind: "paper_trading_control",
            idempotencyKey: `paper-b7-race-key-${label}-${suffix}`,
            status: "executing",
            request: { action: "enable", ledger_id: ledgerId, expected_policy_revision: 0 },
          },
        });
        await applyApprovedTradingPaperControl(first.prisma, owner, effect.id);
      } else {
        const forged = TradingPaperPolicySchema.parse({
          ...disabled,
          enabled: true,
          killSwitch: false,
        });
        await first.prisma.tradingPaperRiskPolicy.update({
          where: { ledgerId },
          data: {
            revision: 1,
            policy: JSON.parse(JSON.stringify(forged)),
            policySha256: createHash("sha256").update(JSON.stringify(forged), "utf8").digest("hex"),
          },
        });
      }
      const at = new Date().toISOString();
      const evidence = await recordPublicAdapterPaperQuoteEvidence(
        first.prisma,
        owner,
        ledgerId,
        market,
        {
          venue: "okx",
          kind: "spot",
          symbol: "SOL-USDT",
          observedAt: at,
          fetchedAt: at,
          bid: "100",
          ask: "100.1",
          quoteVolume24h: "100000",
        },
      );
      return { ledgerId, evidence };
    };

    const unaudited = await makeLedger("unaudited", false);
    const baseSignal = {
      kind: "proposal",
      executionStatus: "research_only",
      strategyId: "b7-race",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "Synthetic competing B7 verification",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    await expect(
      reserveApprovedTradingPaperSignal(
        first.prisma,
        owner,
        unaudited.ledgerId,
        { ...baseSignal, signalId: `b7-unaudited-${suffix}` },
        unaudited.evidence.id,
      ),
    ).resolves.toMatchObject({ status: "deny", reason: "paper_capability_unapproved" });
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId: unaudited.ledgerId } }),
    ).toBe(0);

    const race = await makeLedger("audited", true);
    const [a, b] = await Promise.all([
      reserveApprovedTradingPaperSignal(
        first.prisma,
        owner,
        race.ledgerId,
        { ...baseSignal, signalId: `b7-race-a-${suffix}` },
        race.evidence.id,
      ),
      reserveApprovedTradingPaperSignal(
        second.prisma,
        owner,
        race.ledgerId,
        { ...baseSignal, signalId: `b7-race-b-${suffix}` },
        race.evidence.id,
      ),
    ]);
    expect([a.status, b.status].filter((status) => status === "reserved")).toHaveLength(1);
    expect([a, b].filter((result) => result.status === "deny")).toHaveLength(1);
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId: race.ledgerId } }),
    ).toBe(1);
    expect(
      await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId: race.ledgerId } }),
    ).toBe(1);
    expect(
      await first.prisma.tradingPaperReservationDecision.count({
        where: { ledgerId: race.ledgerId },
      }),
    ).toBe(1);
  });
  it("P11C-0 rejects legacy P9 expiry reconciliation without a B7 decision", async () => {
    const ledgerId = `paper-b8-expired-${suffix}`;
    const now = Date.now();
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(now - 180_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
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
      maxTotalExposureQuote: "300",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const enable = await makePaperControlEffect(ledgerId, "b8-expired-enable", "enable", 0);
    await applyApprovedTradingPaperControl(first.prisma, owner, enable.id);
    // A direct P9 append deliberately has NO B7 reservation decision. It is
    // not a managed C0 hold and may not be silently upgraded by reconciliation.
    await appendTradingPaperLedgerEvent(first.prisma, owner, {
      ledgerId,
      eventId: `b8-expired-reserve-event-${suffix}`,
      sequence: 1,
      kind: "reserve",
      recordedAt: new Date(now - 120_000).toISOString(),
      reservationId: `b8-expired-reservation-${suffix}`,
      signalId: `b8-expired-signal-${suffix}`,
      market,
      quantityBase: "1",
      maxSpendQuote: "110",
      expiresAt: new Date(now - 60_000).toISOString(),
    });
    expect(
      (await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId)).reservedQuote,
    ).toBe("110");
    await expect(
      reconcileTradingPaperReservations(second.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    const recovered = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    expect(recovered.reservations).toHaveLength(1);
    expect(recovered.availableQuote).toBe("390");
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperReleaseAudit.count({ where: { ledgerId } })).toBe(0);
    await expect(
      reconcileTradingPaperReservations(second.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
  });

  it("P11C-0 approved disable atomically releases an outstanding B7 hold but never creates a fill", async () => {
    const ledgerId = `paper-b8-kill-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 20_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
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
      maxTotalExposureQuote: "300",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const enable = await makePaperControlEffect(ledgerId, "b8-kill-enable", "enable", 0);
    await applyApprovedTradingPaperControl(first.prisma, owner, enable.id);
    const at = new Date().toISOString();
    const evidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: at,
        fetchedAt: at,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `b8-kill-signal-${suffix}`,
      strategyId: "b8-kill",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "B8 synthetic disable reconciliation",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserved = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      evidence.id,
    );
    expect(reserved.status).toBe("reserved");
    expect(
      (await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId)).reservations,
    ).toHaveLength(1);

    const disable = await makePaperControlEffect(ledgerId, "b8-kill-disable", "disable", 1);
    await applyApprovedTradingPaperControl(second.prisma, owner, disable.id);

    const policyAfter = await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId);
    expect(policyAfter).toMatchObject({
      revision: 2,
      policy: { mode: "paper_only", enabled: false, killSwitch: true },
    });
    const state = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    expect(state.reservations).toHaveLength(0);
    expect(state.positions).toHaveLength(0);
    expect(state.availableQuote).toBe("500");
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "release" } }),
    ).toBe(1);
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_buy" } }),
    ).toBe(0);
    expect(
      await first.prisma.tradingPaperReleaseAudit.findMany({ where: { ledgerId } }),
    ).toMatchObject([{ reason: "kill_switch", policyRevision: 2 }]);
  });
  it("P11C-1 atomically full-fills a B7 hold with a stop guard and idempotent decision", async () => {
    const ledgerId = `paper-c1-fill-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 20_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
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
      maxTotalExposureQuote: "300",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const enable = await makePaperControlEffect(ledgerId, "c1-fill-enable", "enable", 0);
    await applyApprovedTradingPaperControl(first.prisma, owner, enable.id);
    const reserveAt = new Date().toISOString();
    const reserveEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: reserveAt,
        fetchedAt: reserveAt,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `c1-fill-signal-${suffix}`,
      strategyId: "c1-fill",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "Synthetic C1 full-fill verification",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserved = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      reserveEvidence.id,
    );
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected reservation");

    const fillAt = new Date().toISOString();
    const fillEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: fillAt,
        fetchedAt: fillAt,
        bid: "99.99",
        ask: "100",
        quoteVolume24h: "100000",
      },
    );
    const filled = await fillApprovedTradingPaperReservation(
      second.prisma,
      owner,
      ledgerId,
      reserved.reservationId,
      fillEvidence.id,
    );
    expect(filled.status).toBe("filled");
    if (filled.status !== "filled") throw new Error("expected synthetic fill");
    expect(filled.mode).toBe("paper_only");
    expect(filled.quantityBase).toBe(reserved.quantityBase);
    expect(Number(filled.executedPriceQuote)).toBeLessThanOrEqual(
      Number(reserved.heldQuote) / Number(reserved.quantityBase),
    );
    const state = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    expect(state.reservations).toHaveLength(0);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]?.positionId).toBe(reserved.reservationId);
    expect(await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } })).toBe(1);
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_buy" } }),
    ).toBe(1);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(2);

    await expect(
      fillApprovedTradingPaperReservation(
        first.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        fillEvidence.id,
      ),
    ).resolves.toMatchObject({
      status: "duplicate",
      fillEventId: filled.fillEventId,
      executedPriceQuote: filled.executedPriceQuote,
    });
    expect(await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(2);

    const changedAt = new Date().toISOString();
    const changedEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: changedAt,
        fetchedAt: changedAt,
        bid: "99.98",
        ask: "99.99",
        quoteVolume24h: "100000",
      },
    );
    await expect(
      fillApprovedTradingPaperReservation(
        second.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        changedEvidence.id,
      ),
    ).rejects.toBeInstanceOf(PaperFillConflictError);
  });

  it("P11C-1 refuses adverse fill price and serializes fill against approved disable", async () => {
    const buildReserved = async (label: string) => {
      const ledgerId = `paper-c1-${label}-${suffix}`;
      await createTradingPaperLedger(first.prisma, owner, {
        ledgerId,
        openedAt: new Date(Date.now() - 20_000).toISOString(),
        quoteCurrency: "USDT",
        initialBalanceQuote: "500",
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
        maxTotalExposureQuote: "300",
        assumedFeeBpsPerSide: 10,
        assumedSlippageBpsPerSide: 10,
      });
      const enable = await makePaperControlEffect(ledgerId, `c1-${label}-enable`, "enable", 0);
      await applyApprovedTradingPaperControl(first.prisma, owner, enable.id);
      const at = new Date().toISOString();
      const evidence = await recordPublicAdapterPaperQuoteEvidence(
        first.prisma,
        owner,
        ledgerId,
        market,
        {
          venue: "okx",
          kind: "spot",
          symbol: "SOL-USDT",
          observedAt: at,
          fetchedAt: at,
          bid: "100",
          ask: "100.1",
          quoteVolume24h: "100000",
        },
      );
      const signal = {
        kind: "proposal",
        executionStatus: "research_only",
        signalId: `c1-${label}-signal-${suffix}`,
        strategyId: "c1-race",
        strategyVersion: "1",
        createdAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        evidenceIds: ["research-only"],
        market,
        action: "spot_buy",
        entryTrigger: "100.1",
        stopLoss: "95",
        takeProfit: ["110"],
        invalidation: "fixture",
        rationale: "Synthetic C1 race verification",
        riskBudgetQuote: "10",
        maxSlippageBps: null,
      } as const;
      const reserved = await reserveApprovedTradingPaperSignal(
        first.prisma,
        owner,
        ledgerId,
        signal,
        evidence.id,
      );
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      return { ledgerId, reserved };
    };

    const adverse = await buildReserved("adverse");
    const adverseAt = new Date().toISOString();
    const adverseEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      adverse.ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: adverseAt,
        fetchedAt: adverseAt,
        bid: "100.99",
        ask: "101",
        quoteVolume24h: "100000",
      },
    );
    await expect(
      fillApprovedTradingPaperReservation(
        second.prisma,
        owner,
        adverse.ledgerId,
        adverse.reserved.reservationId,
        adverseEvidence.id,
      ),
    ).resolves.toMatchObject({ status: "deny", reason: "price_beyond_reserve_cap" });
    expect(
      (await readVerifiedTradingPaperLedger(first.prisma, owner, adverse.ledgerId)).reservations,
    ).toHaveLength(1);
    expect(
      await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId: adverse.ledgerId } }),
    ).toBe(0);

    const race = await buildReserved("disable-race");
    const raceAt = new Date().toISOString();
    const raceEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      race.ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: raceAt,
        fetchedAt: raceAt,
        bid: "99.99",
        ask: "100",
        quoteVolume24h: "100000",
      },
    );
    const disable = await makePaperControlEffect(race.ledgerId, "c1-disable-race", "disable", 1);
    const [fillResult, disableResult] = await Promise.all([
      fillApprovedTradingPaperReservation(
        first.prisma,
        owner,
        race.ledgerId,
        race.reserved.reservationId,
        raceEvidence.id,
      ),
      applyApprovedTradingPaperControl(second.prisma, owner, disable.id),
    ]);
    expect(disableResult).toMatchObject({ ok: true, action: "disable", policyRevision: 2 });
    expect(["filled", "deny"]).toContain(fillResult.status);
    const fillCount = await first.prisma.tradingPaperLedgerEvent.count({
      where: { ledgerId: race.ledgerId, kind: "fill_buy" },
    });
    const releaseCount = await first.prisma.tradingPaperLedgerEvent.count({
      where: { ledgerId: race.ledgerId, kind: "release" },
    });
    expect(fillCount + releaseCount).toBe(1);
    const finalState = await readVerifiedTradingPaperLedger(first.prisma, owner, race.ledgerId);
    expect(finalState.reservations).toHaveLength(0);
    if (fillCount === 1) {
      expect(finalState.positions).toHaveLength(1);
      expect(
        await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId: race.ledgerId } }),
      ).toBe(1);
    } else {
      expect(finalState.positions).toHaveLength(0);
      expect(
        await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId: race.ledgerId } }),
      ).toBe(0);
    }
  });
  it("P11C-2 closes only after persisted stop trigger and replays idempotently", async () => {
    const ledgerId = `paper-c2-stop-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 30_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
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
      maxTotalExposureQuote: "300",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const enable = await makePaperControlEffect(ledgerId, "c2-stop-enable", "enable", 0);
    await applyApprovedTradingPaperControl(first.prisma, owner, enable.id);
    const reserveAt = new Date().toISOString();
    const reserveEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: reserveAt,
        fetchedAt: reserveAt,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `c2-stop-signal-${suffix}`,
      strategyId: "c2-stop",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "Synthetic C2 stop close verification",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserved = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      reserveEvidence.id,
    );
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const fillAt = new Date().toISOString();
    const fillEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: fillAt,
        fetchedAt: fillAt,
        bid: "99.99",
        ask: "100",
        quoteVolume24h: "100000",
      },
    );
    const filled = await fillApprovedTradingPaperReservation(
      first.prisma,
      owner,
      ledgerId,
      reserved.reservationId,
      fillEvidence.id,
    );
    if (filled.status !== "filled") throw new Error("expected fill");

    const safeAt = new Date().toISOString();
    const safeEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: safeAt,
        fetchedAt: safeAt,
        bid: "95.5",
        ask: "95.51",
        quoteVolume24h: "100000",
      },
    );
    await expect(
      closeTradingPaperPositionOnStop(
        second.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        safeEvidence.id,
      ),
    ).resolves.toMatchObject({ status: "deny", reason: "stop_not_triggered" });
    expect(
      (await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId)).positions,
    ).toHaveLength(1);

    const stopAt = new Date().toISOString();
    const stopEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: stopAt,
        fetchedAt: stopAt,
        bid: "94.99",
        ask: "95",
        quoteVolume24h: "100000",
      },
    );
    const closed = await closeTradingPaperPositionOnStop(
      second.prisma,
      owner,
      ledgerId,
      reserved.reservationId,
      stopEvidence.id,
    );
    expect(closed.status).toBe("closed");
    if (closed.status !== "closed") throw new Error("expected stop close");
    expect(Number(closed.executedPriceQuote)).toBeLessThan(95);
    const finalState = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    expect(finalState.positions).toHaveLength(0);
    expect(Number(finalState.realizedPnlQuote)).toBeLessThan(0);
    expect(await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(0);
    expect(await first.prisma.tradingPaperCloseDecision.count({ where: { ledgerId } })).toBe(1);
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_sell" } }),
    ).toBe(1);

    // A retry of the ORIGINAL buy after a successful full-lot stop close is
    // historical idempotency, not a request to reopen the virtual position.
    const afterCloseVersion = finalState.version;
    const restarted = createDb(databaseUrl!, {
      poolMax: 1,
      applicationName: "paper-c7-historical-fill-retry",
    });
    try {
      await expect(
        fillApprovedTradingPaperReservation(
          restarted.prisma,
          owner,
          ledgerId,
          reserved.reservationId,
          fillEvidence.id,
        ),
      ).resolves.toMatchObject({
        status: "duplicate",
        fillEventId: filled.fillEventId,
        fillEventSequence: filled.fillEventSequence,
        signalId: signal.signalId,
      });
      await expect(
        fillApprovedTradingPaperReservation(
          first.prisma,
          owner,
          ledgerId,
          reserved.reservationId,
          fillEvidence.id,
        ),
      ).resolves.toMatchObject({ status: "duplicate", fillEventId: filled.fillEventId });
      await expect(
        fillApprovedTradingPaperReservation(
          restarted.prisma,
          owner,
          ledgerId,
          reserved.reservationId,
          stopEvidence.id,
        ),
      ).rejects.toBeInstanceOf(PaperFillConflictError);
      expect(
        (await readVerifiedTradingPaperLedger(restarted.prisma, owner, ledgerId)).version,
      ).toBe(afterCloseVersion);
      expect(await restarted.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(3);
      expect(await restarted.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
        3,
      );
      expect(await restarted.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(0);
      expect(await restarted.prisma.tradingPaperFillDecision.count({ where: { ledgerId } })).toBe(
        1,
      );
      expect(await restarted.prisma.tradingPaperCloseDecision.count({ where: { ledgerId } })).toBe(
        1,
      );
    } finally {
      await restarted.prisma.$disconnect();
      await restarted.pool.end();
    }

    await expect(
      closeTradingPaperPositionOnStop(
        first.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        stopEvidence.id,
      ),
    ).resolves.toMatchObject({ status: "duplicate", closeEventId: closed.closeEventId });

    const changedAt = new Date().toISOString();
    const changedEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: changedAt,
        fetchedAt: changedAt,
        bid: "94.98",
        ask: "94.99",
        quoteVolume24h: "100000",
      },
    );
    await expect(
      closeTradingPaperPositionOnStop(
        second.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        changedEvidence.id,
      ),
    ).rejects.toBeInstanceOf(PaperCloseConflictError);
  });

  it("P11C-2 serializes stop close against approved disable without double terminal mutation", async () => {
    const ledgerId = `paper-c2-race-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 30_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
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
      maxTotalExposureQuote: "300",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const enable = await makePaperControlEffect(ledgerId, "c2-race-enable", "enable", 0);
    await applyApprovedTradingPaperControl(first.prisma, owner, enable.id);
    const at = new Date().toISOString();
    const evidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: at,
        fetchedAt: at,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `c2-race-signal-${suffix}`,
      strategyId: "c2-race",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "Synthetic C2 close-disable race",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserved = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      evidence.id,
    );
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const fillAt = new Date().toISOString();
    const fillEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: fillAt,
        fetchedAt: fillAt,
        bid: "99.99",
        ask: "100",
        quoteVolume24h: "100000",
      },
    );
    const filled = await fillApprovedTradingPaperReservation(
      first.prisma,
      owner,
      ledgerId,
      reserved.reservationId,
      fillEvidence.id,
    );
    if (filled.status !== "filled") throw new Error("expected fill");
    const stopAt = new Date().toISOString();
    const stopEvidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: stopAt,
        fetchedAt: stopAt,
        bid: "94.99",
        ask: "95",
        quoteVolume24h: "100000",
      },
    );
    const disable = await makePaperControlEffect(ledgerId, "c2-race-disable", "disable", 1);
    const [closeResult, disableResult] = await Promise.all([
      closeTradingPaperPositionOnStop(
        first.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        stopEvidence.id,
      ),
      applyApprovedTradingPaperControl(second.prisma, owner, disable.id),
    ]);
    expect(disableResult).toMatchObject({ ok: true, action: "disable", policyRevision: 2 });
    expect(["closed", "deny"]).toContain(closeResult.status);
    const state = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    expect(state.reservations).toHaveLength(0);
    const sellCount = await first.prisma.tradingPaperLedgerEvent.count({
      where: { ledgerId, kind: "fill_sell" },
    });
    expect(sellCount).toBe(closeResult.status === "closed" ? 1 : 0);
    if (sellCount === 1) {
      expect(state.positions).toHaveLength(0);
      expect(await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(0);
    } else {
      expect(state.positions).toHaveLength(1);
      expect(await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(1);
      expect(await first.prisma.tradingPaperCloseDecision.count({ where: { ledgerId } })).toBe(0);
    }
  });
  it("P11C-3 audits closed PnL across a fresh DB client and fails on decision/guard tampering", async () => {
    const closedId = `paper-c2-stop-${suffix}`;
    const restarted = createDb(databaseUrl!, {
      poolMax: 1,
      applicationName: "paper-lifecycle-audit-restart",
    });
    try {
      const audited = await auditTradingPaperLifecycle(restarted.prisma, owner, closedId);
      const state = await readVerifiedTradingPaperLedger(restarted.prisma, owner, closedId);
      expect(audited).toMatchObject({
        status: "verified",
        mode: "paper_only",
        acceptedEvents: 3,
        reservationDecisions: 1,
        fillDecisions: 1,
        releaseAudits: 0,
        closeDecisions: 1,
        openPositions: 0,
        openReservations: 0,
        realizedPnlQuote: state.realizedPnlQuote,
      });
      expect(Number(audited.realizedPnlQuote)).toBeLessThan(0);
      const close = await first.prisma.tradingPaperCloseDecision.findFirstOrThrow({
        where: { ledgerId: closedId },
      });
      await first.prisma.tradingPaperCloseDecision.update({
        where: { ledgerId_positionId: { ledgerId: closedId, positionId: close.positionId } },
        data: { decisionSha256: "0".repeat(64) },
      });
      await expect(
        auditTradingPaperLifecycle(restarted.prisma, owner, closedId),
      ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
      await first.prisma.tradingPaperCloseDecision.update({
        where: { ledgerId_positionId: { ledgerId: closedId, positionId: close.positionId } },
        data: { decisionSha256: close.decisionSha256 },
      });
      expect((await auditTradingPaperLifecycle(restarted.prisma, owner, closedId)).status).toBe(
        "verified",
      );
      await first.prisma.tradingPaperCloseDecision.delete({
        where: { ledgerId_positionId: { ledgerId: closedId, positionId: close.positionId } },
      });
      await expect(
        auditTradingPaperLifecycle(restarted.prisma, owner, closedId),
      ).rejects.toBeInstanceOf(PaperLifecycleAuditError);

      const openId = `paper-c1-fill-${suffix}`;
      const open = await auditTradingPaperLifecycle(restarted.prisma, owner, openId);
      expect(open).toMatchObject({
        status: "verified",
        reservationDecisions: 1,
        fillDecisions: 1,
        closeDecisions: 0,
        openPositions: 1,
      });
      const guard = await first.prisma.tradingPaperStopGuard.findFirstOrThrow({
        where: { ledgerId: openId },
      });
      await first.prisma.tradingPaperStopGuard.update({
        where: { ledgerId_positionId: { ledgerId: openId, positionId: guard.positionId } },
        data: { guardSha256: "0".repeat(64) },
      });
      await expect(auditTradingPaperLifecycle(restarted.prisma, owner, openId)).rejects.toThrow();
      await first.prisma.tradingPaperStopGuard.update({
        where: { ledgerId_positionId: { ledgerId: openId, positionId: guard.positionId } },
        data: { guardSha256: guard.guardSha256 },
      });
    } finally {
      await restarted.prisma.$disconnect();
      await restarted.pool.end();
    }
  });
  it("P11C-4 blocks corrupt-money writes but still latches approved kill-switch", async () => {
    const ledgerId = `paper-c1-fill-${suffix}`;
    const row = await first.prisma.tradingPaperFillDecision.findFirstOrThrow({
      where: { ledgerId },
    });
    const before = {
      version: (
        await first.prisma.tradingPaperLedger.findUniqueOrThrow({ where: { id: ledgerId } })
      ).version,
      events: await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } }),
      outbox: await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } }),
      decisions: await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } }),
    };
    const where = { ledgerId_reservationId: { ledgerId, reservationId: row.reservationId } };
    await first.prisma.tradingPaperFillDecision.update({
      where,
      data: { decisionSha256: "0".repeat(64) },
    });
    const disable = await makePaperControlEffect(ledgerId, "c4-block-disable", "disable", 1);
    await expect(
      reconcileTradingPaperReservations(first.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    await expect(
      reserveApprovedTradingPaperSignal(second.prisma, owner, ledgerId, null, ""),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    await expect(
      fillApprovedTradingPaperReservation(
        second.prisma,
        owner,
        ledgerId,
        row.reservationId,
        row.evidenceId,
      ),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    await expect(
      closeTradingPaperPositionOnStop(
        second.prisma,
        owner,
        ledgerId,
        row.reservationId,
        row.evidenceId,
      ),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, disable.id),
    ).resolves.toMatchObject({
      ok: true,
      mode: "paper_only",
      action: "disable",
      policyRevision: 2,
      enabled: false,
      killSwitch: true,
      reconciliationRequired: true,
    });
    expect(
      (await first.prisma.externalEffect.findUniqueOrThrow({ where: { id: disable.id } })).status,
    ).toBe("completed");
    expect(await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId)).toMatchObject({
      revision: 2,
      policy: { enabled: false, killSwitch: true },
    });
    expect(
      (await first.prisma.tradingPaperLedger.findUniqueOrThrow({ where: { id: ledgerId } }))
        .version,
    ).toBe(before.version);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      before.events,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      before.outbox,
    );
    expect(await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } })).toBe(
      before.decisions,
    );
    await first.prisma.tradingPaperFillDecision.update({
      where,
      data: { decisionSha256: row.decisionSha256 },
    });
    expect((await auditTradingPaperLifecycle(first.prisma, owner, ledgerId)).status).toBe(
      "verified",
    );
  });
  it("P11C-5 restores audited paper-only hold recovery without implicit re-enable", async () => {
    const ledgerId = `paper-c5-recovery-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 30_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
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
      maxTotalExposureQuote: "300",
      assumedFeeBpsPerSide: 10,
      assumedSlippageBpsPerSide: 10,
    });
    const initialEnable = await makePaperControlEffect(ledgerId, "c5-enable", "enable", 0);
    await expect(
      applyApprovedTradingPaperControl(first.prisma, owner, initialEnable.id),
    ).resolves.toMatchObject({ ok: true, enabled: true, policyRevision: 1 });
    const at = new Date().toISOString();
    const evidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      market,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt: at,
        fetchedAt: at,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `c5-signal-${suffix}`,
      strategyId: "c5-recovery",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "synthetic",
      rationale: "Safe hold restoration fixture",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserved = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      evidence.id,
    );
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected B7 reserve fixture");
    const decision = await first.prisma.tradingPaperReservationDecision.findUniqueOrThrow({
      where: { ledgerId_signalId: { ledgerId, signalId: signal.signalId } },
    });
    const decisionWhere = { ledgerId_signalId: { ledgerId, signalId: signal.signalId } };
    await first.prisma.tradingPaperReservationDecision.update({
      where: decisionWhere,
      data: { decisionSha256: "0".repeat(64) },
    });
    const disable = await makePaperControlEffect(ledgerId, "c5-disable", "disable", 1);
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, disable.id),
    ).resolves.toMatchObject({
      ok: true,
      mode: "paper_only",
      action: "disable",
      policyRevision: 2,
      enabled: false,
      killSwitch: true,
      reconciliationRequired: true,
    });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(1);
    expect(await first.prisma.tradingPaperReleaseAudit.count({ where: { ledgerId } })).toBe(0);
    const blockedReport = await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId);
    expect(blockedReport).toMatchObject({
      status: "integrity_blocked",
      mode: "paper_only",
      enabled: false,
      killSwitch: true,
      nextAction: "inspect_and_restore_independently",
    });
    expect("availableQuote" in blockedReport).toBe(false);
    const blockedEnable = await makePaperControlEffect(ledgerId, "c5-corrupt-enable", "enable", 2);
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, blockedEnable.id),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    expect(await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId)).toMatchObject({
      revision: 2,
      policy: { enabled: false, killSwitch: true },
    });
    await expect(
      reconcileTradingPaperReservations(second.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    // This test repairs only its own deliberately altered disposable fixture.
    // It never calls an automated recovery or edits a user's original journal.
    await first.prisma.tradingPaperReservationDecision.update({
      where: decisionWhere,
      data: { decisionSha256: decision.decisionSha256 },
    });
    expect((await auditTradingPaperLifecycle(second.prisma, owner, ledgerId)).status).toBe(
      "verified",
    );
    expect(await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      enabled: false,
      nextAction: "internal_reconcile_holds",
      openReservations: 1,
    });
    const prematureEnable = await makePaperControlEffect(
      ledgerId,
      "c5-premature-enable",
      "enable",
      2,
    );
    await expect(
      applyApprovedTradingPaperControl(first.prisma, owner, prematureEnable.id),
    ).resolves.toMatchObject({
      ok: false,
      action: "enable",
      error: "reconciliation_required",
      currentPolicyRevision: 2,
    });
    expect(await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId)).toMatchObject({
      revision: 2,
      policy: { enabled: false, killSwitch: true },
    });
    const [a, b] = await Promise.all([
      reconcileTradingPaperReservations(first.prisma, owner, ledgerId),
      reconcileTradingPaperReservations(second.prisma, owner, ledgerId),
    ]);
    expect([a.released, b.released].sort()).toEqual([0, 1]);
    expect([a.reason, b.reason]).toEqual(["kill_switch", "kill_switch"]);
    await expect(
      reconcileTradingPaperReservations(second.prisma, owner, ledgerId),
    ).resolves.toEqual({ released: 0, reason: "kill_switch" });
    const ledger = await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId);
    expect(ledger.reservations).toHaveLength(0);
    expect(ledger.positions).toHaveLength(0);
    expect(ledger.availableQuote).toBe("500");
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(2);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(2);
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_buy" } }),
    ).toBe(0);
    expect(
      await first.prisma.tradingPaperReleaseAudit.findMany({ where: { ledgerId } }),
    ).toMatchObject([{ reason: "kill_switch", policyRevision: 2 }]);
    expect(await auditTradingPaperLifecycle(first.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      openReservations: 0,
      releaseAudits: 1,
    });
    expect(await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      enabled: false,
      openReservations: 0,
      nextAction: "separate_owner_approval_to_enable",
    });
    // Reconciliation cannot implicitly change the disabled capability.
    expect(await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId)).toMatchObject({
      revision: 2,
      policy: { enabled: false, killSwitch: true },
    });
    const reviewedEnable = await makePaperControlEffect(
      ledgerId,
      "c5-reviewed-enable",
      "enable",
      2,
    );
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, reviewedEnable.id),
    ).resolves.toMatchObject({
      ok: true,
      policyRevision: 3,
      enabled: true,
      killSwitch: false,
    });
    expect(await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      mode: "paper_only",
      enabled: true,
      killSwitch: false,
      openReservations: 0,
      nextAction: "none",
    });
  });

  it("P11C-6 reports only verified finances and respects owner scope", async () => {
    // C3 deliberately removes a close decision and leaves this disposable
    // fixture corrupt: the status reader must not report its PnL as verified.
    const damagedClose = await readTradingPaperRecoveryStatus(
      first.prisma,
      owner,
      `paper-c2-stop-${suffix}`,
    );
    expect(damagedClose).toMatchObject({
      status: "integrity_blocked",
      nextAction: "inspect_and_restore_independently",
    });
    expect("realizedPnlQuote" in damagedClose).toBe(false);
    // C4 restores its tampered fill SHA, but keeps the policy disabled and
    // the synthetic open position protected by its persisted stop guard.
    const verifiedOpen = await readTradingPaperRecoveryStatus(
      second.prisma,
      owner,
      `paper-c1-fill-${suffix}`,
    );
    expect(verifiedOpen).toMatchObject({
      status: "verified",
      enabled: false,
      killSwitch: true,
      openReservations: 0,
      openPositions: 1,
      nextAction: "owner_decision_required_for_open_position",
    });
    const damagedLegacy = await readTradingPaperRecoveryStatus(
      second.prisma,
      owner,
      `paper-b8-expired-${suffix}`,
    );
    expect(damagedLegacy).toMatchObject({
      status: "integrity_blocked",
      nextAction: "inspect_and_restore_independently",
    });
    expect("reservedQuote" in damagedLegacy).toBe(false);
    await expect(
      readTradingPaperRecoveryStatus(
        second.prisma,
        { ...owner, userId: "unrecognized-paper-owner" },
        `paper-c5-recovery-${suffix}`,
      ),
    ).rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
  });
  it("P11C-10 reports disabled open position as owner decision without mutation", async () => {
    const ledgerId = `paper-c1-fill-${suffix}`;
    const before = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    const policyBefore = await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId);
    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });
    const guardsBefore = await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } });
    expect(before.positions).toHaveLength(1);
    expect(before.reservations).toHaveLength(0);
    expect(guardsBefore).toBe(1);

    const status = await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId);
    expect(status).toMatchObject({
      mode: "paper_only",
      status: "verified",
      enabled: false,
      killSwitch: true,
      openReservations: 0,
      openPositions: 1,
      nextAction: "owner_decision_required_for_open_position",
    });

    expect(await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId)).toEqual(before);
    expect(await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId)).toEqual(
      policyBefore,
    );
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      eventsBefore,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      outboxBefore,
    );
    expect(await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(
      guardsBefore,
    );
  });

  it("P11C-11 persists explicit protective exit authority without closing the position", async () => {
    const ledgerId = `paper-c1-fill-${suffix}`;
    const before = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    const positionId = before.positions[0]?.positionId;
    if (!positionId) throw new Error("expected verified open position");
    const policyBefore = await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId);
    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });
    const guardsBefore = await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } });
    const sellsBefore = await first.prisma.tradingPaperLedgerEvent.count({
      where: { ledgerId, kind: "fill_sell" },
    });
    expect(policyBefore.policy).toMatchObject({ enabled: false, killSwitch: true });
    expect(before.positions).toHaveLength(1);
    expect(before.positions[0]?.positionId).toBe(positionId);
    expect(before.reservations).toHaveLength(0);

    const effect = await makePaperPositionControlEffect(
      ledgerId,
      positionId,
      "c11-authorize",
      policyBefore.revision,
    );
    const authorized = await applyApprovedTradingPaperProtectiveExitControl(
      second.prisma,
      owner,
      effect.id,
    );
    expect(authorized).toMatchObject({
      ok: true,
      mode: "paper_only",
      action: "authorize_protective_stop_exit",
      ledgerId,
      positionId,
      policyRevision: policyBefore.revision,
      enabled: false,
      killSwitch: true,
    });
    if (!authorized.ok) throw new Error("expected protective exit authority");
    expect(Date.parse(authorized.expiresAt)).toBeGreaterThan(Date.parse(authorized.authorizedAt));
    expect(Date.parse(authorized.expiresAt) - Date.parse(authorized.authorizedAt)).toBe(60_000);

    const verified = await readVerifiedTradingPaperProtectiveExitAuthority(
      first.prisma,
      owner,
      effect.id,
    );
    expect(verified).toMatchObject({
      effectId: effect.id,
      ledgerId,
      positionId,
      policyRevision: policyBefore.revision,
      expiresAt: authorized.expiresAt,
    });
    expect(
      (await first.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
    ).toBe("completed");
    expect(
      await first.prisma.tradingPaperProtectiveExitAuthority.count({ where: { ledgerId } }),
    ).toBe(1);
    expect(await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId)).toEqual(before);
    expect(await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId)).toEqual(
      policyBefore,
    );
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      eventsBefore,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      outboxBefore,
    );
    expect(await first.prisma.tradingPaperStopGuard.count({ where: { ledgerId } })).toBe(
      guardsBefore,
    );
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_sell" } }),
    ).toBe(sellsBefore);

    const duplicate = await makePaperPositionControlEffect(
      ledgerId,
      positionId,
      "c11-duplicate",
      policyBefore.revision,
    );
    await expect(
      applyApprovedTradingPaperProtectiveExitControl(second.prisma, owner, duplicate.id),
    ).resolves.toMatchObject({
      ok: false,
      error: "authority_already_active",
      currentPolicyRevision: policyBefore.revision,
    });
    if (policyBefore.revision > 0) {
      const stale = await makePaperPositionControlEffect(
        ledgerId,
        positionId,
        "c11-stale",
        policyBefore.revision - 1,
      );
      await expect(
        applyApprovedTradingPaperProtectiveExitControl(second.prisma, owner, stale.id),
      ).resolves.toMatchObject({
        ok: false,
        error: "stale_policy_revision",
        currentPolicyRevision: policyBefore.revision,
      });
    }

    const authorityRow = await first.prisma.tradingPaperProtectiveExitAuthority.findUniqueOrThrow({
      where: { effectId: effect.id },
    });
    await first.prisma.tradingPaperProtectiveExitAuthority.update({
      where: { effectId: effect.id },
      data: { authoritySha256: "0".repeat(64) },
    });
    await expect(
      readVerifiedTradingPaperProtectiveExitAuthority(second.prisma, owner, effect.id),
    ).rejects.toBeInstanceOf(PaperProtectiveExitAuthorityIntegrityError);
    await first.prisma.tradingPaperProtectiveExitAuthority.update({
      where: { effectId: effect.id },
      data: { authoritySha256: authorityRow.authoritySha256 },
    });
    expect(
      (await readVerifiedTradingPaperProtectiveExitAuthority(second.prisma, owner, effect.id))
        ?.authoritySha256,
    ).toBe(authorityRow.authoritySha256);
  });

  it("P11C-8 rejects a forged inert-outbox delivery marker without money mutation", async () => {
    const ledgerId = `paper-c5-recovery-${suffix}`;
    const before = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    const policyBefore = await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId);
    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });
    const entry = await first.prisma.tradingPaperLedgerOutbox.findFirstOrThrow({
      where: { ledgerId },
      orderBy: { sequence: "asc" },
    });
    expect(entry.status).toBe("pending");
    const where = { ledgerId_sequence: { ledgerId, sequence: entry.sequence } };
    await first.prisma.tradingPaperLedgerOutbox.update({
      where,
      data: { status: "delivered" },
    });
    await expect(auditTradingPaperLifecycle(second.prisma, owner, ledgerId)).rejects.toBeInstanceOf(
      PaperLifecycleAuditError,
    );
    const blocked = await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId);
    expect(blocked).toMatchObject({
      status: "integrity_blocked",
      nextAction: "inspect_and_restore_independently",
    });
    expect("availableQuote" in blocked).toBe(false);
    await expect(
      reserveApprovedTradingPaperSignal(second.prisma, owner, ledgerId, null, ""),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      eventsBefore,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      outboxBefore,
    );
    expect(await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId)).toEqual(before);
    expect(await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId)).toEqual(
      policyBefore,
    );
    // Restore only the disposable test fixture; there is no automatic repair API.
    await first.prisma.tradingPaperLedgerOutbox.update({
      where,
      data: { status: "pending" },
    });
    expect(await auditTradingPaperLifecycle(second.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      acceptedEvents: eventsBefore,
    });
  });

  it("P11C-9 latches approved kill-switch despite forged paper outbox delivery", async () => {
    const ledgerId = `paper-c5-recovery-${suffix}`;
    const before = await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId);
    const policyBefore = await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId);
    expect(policyBefore.policy).toMatchObject({ enabled: true, killSwitch: false });
    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });
    const releasesBefore = await first.prisma.tradingPaperReleaseAudit.count({
      where: { ledgerId },
    });
    const entry = await first.prisma.tradingPaperLedgerOutbox.findFirstOrThrow({
      where: { ledgerId },
      orderBy: { sequence: "asc" },
    });
    const where = { ledgerId_sequence: { ledgerId, sequence: entry.sequence } };
    expect(entry.status).toBe("pending");
    // Corrupt only a disposable fixture; there is no dispatcher.
    await first.prisma.tradingPaperLedgerOutbox.update({ where, data: { status: "delivered" } });
    const disable = await makePaperControlEffect(
      ledgerId,
      "c9-outbox-disable",
      "disable",
      policyBefore.revision,
    );
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, disable.id),
    ).resolves.toMatchObject({
      ok: true,
      mode: "paper_only",
      action: "disable",
      policyRevision: policyBefore.revision + 1,
      enabled: false,
      killSwitch: true,
      reconciliationRequired: true,
    });
    expect(
      (await first.prisma.externalEffect.findUniqueOrThrow({ where: { id: disable.id } })).status,
    ).toBe("completed");
    const disabled = await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerId);
    expect(disabled.revision).toBe(policyBefore.revision + 1);
    expect(disabled.policy).toEqual({ ...policyBefore.policy, enabled: false, killSwitch: true });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      eventsBefore,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      outboxBefore,
    );
    expect(await first.prisma.tradingPaperReleaseAudit.count({ where: { ledgerId } })).toBe(
      releasesBefore,
    );
    expect(await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId)).toEqual(before);
    const blocked = await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId);
    expect(blocked).toMatchObject({
      status: "integrity_blocked",
      enabled: false,
      killSwitch: true,
      nextAction: "inspect_and_restore_independently",
    });
    expect("availableQuote" in blocked).toBe(false);
    const prematureEnable = await makePaperControlEffect(
      ledgerId,
      "c9-corrupt-enable",
      "enable",
      disabled.revision,
    );
    await expect(
      applyApprovedTradingPaperControl(first.prisma, owner, prematureEnable.id),
    ).rejects.toBeInstanceOf(PaperLifecycleAuditError);
    expect(await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerId)).toEqual(
      disabled,
    );
    // Test fixture restoration only, never an application repair path.
    await first.prisma.tradingPaperLedgerOutbox.update({ where, data: { status: "pending" } });
    expect(await auditTradingPaperLifecycle(second.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      acceptedEvents: eventsBefore,
    });
    expect(await readTradingPaperRecoveryStatus(second.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      enabled: false,
      nextAction: "separate_owner_approval_to_enable",
    });
    const reenable = await makePaperControlEffect(
      ledgerId,
      "c9-reviewed-enable",
      "enable",
      disabled.revision,
    );
    await expect(
      applyApprovedTradingPaperControl(second.prisma, owner, reenable.id),
    ).resolves.toMatchObject({
      ok: true,
      policyRevision: disabled.revision + 1,
      enabled: true,
      killSwitch: false,
    });
    expect(await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId)).toEqual(before);
    expect(
      await first.prisma.tradingPaperLedgerOutbox.count({
        where: { ledgerId, status: { not: "pending" } },
      }),
    ).toBe(0);
  });
});
