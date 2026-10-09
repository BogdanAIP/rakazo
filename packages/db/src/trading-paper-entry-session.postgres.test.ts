import { randomUUID } from "node:crypto";
import { TradingInstrumentSchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma } from "./client.js";
import {
  applyApprovedTradingPaperEntrySessionControl,
  assessTradingPaperEntrySessionInTransaction,
  lockAndVerifyTradingPaperEntrySessionInTransaction,
  readVerifiedTradingPaperEntrySession,
} from "./trading-paper-entry-session.js";
import { auditTradingPaperLifecycle } from "./trading-paper-lifecycle-audit.js";
import {
  applyApprovedTradingPaperProtectionControl,
  readVerifiedTradingPaperProtectionLease,
  readTradingPaperProtectionWakePreflight,
} from "./trading-paper-protection-lease.js";
import { recordPublicAdapterPaperQuoteEvidence } from "./trading-paper-quote-evidence.js";
import { reserveApprovedTradingPaperSignal } from "./trading-paper-reserve.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { settleVerifiedTradingPaperSessionReservations } from "./trading-paper-session-settlement.js";
import { createTradingPaperLedger, readVerifiedTradingPaperLedger } from "./trading-paper-store.js";
import { applyApprovedTradingPaperWorkerControl } from "./trading-paper-worker-gate.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("H1 finite PAPER entry session PostgreSQL owner/fence", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-session-user-${suffix}`,
    spaceId: `paper-session-space-${suffix}`,
  };
  const orgId = `paper-session-org-${suffix}`;
  const ledgerId = `paper-session-ledger-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let counter = 0;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-session-h1-a" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-session-h1-b" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "PAPER Session Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "PAPER Session Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-session-member-${suffix}`,
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
        name: "PAPER Session Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-session-space-member-${suffix}`,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
    });
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 60_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
    });
    await createDisabledTradingPaperRiskPolicy(first.prisma, owner, ledgerId, {
      allowedVenues: ["okx", "bingx"],
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

  const effect = async (kind: string, request: Prisma.InputJsonValue) => {
    counter += 1;
    const id = `paper-session-e${counter}-${suffix}`;
    const botId = `paper-session-b${counter}-${suffix}`;
    const threadId = `paper-session-th${counter}-${suffix}`;
    const taskId = `paper-session-t${counter}-${suffix}`;
    const runId = `paper-session-r${counter}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Session",
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
        prompt: "paper session integration",
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
        id,
        spaceId: owner.spaceId,
        runId,
        kind,
        idempotencyKey: id,
        status: "executing",
        request,
      },
    });
  };

  it("requires a new explicit approval, denies before Start, fences Pause/End and never creates trades", async () => {
    const absent = await readVerifiedTradingPaperEntrySession(first.prisma, owner, ledgerId);
    expect(absent).toMatchObject({ status: "absent", revision: 0 });

    const policy = await effect("paper_trading_control", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 0,
    });
    await applyApprovedTradingPaperControl(first.prisma, owner, policy.id);
    const worker = await effect("paper_worker_control", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, worker.id);

    const preStart = await first.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId),
    );
    expect(preStart).toMatchObject({ status: "deny", reason: "session_absent" });

    const start = await effect("paper_session_control", {
      action: "start",
      ledger_id: ledgerId,
      expected_revision: 0,
      duration_minutes: 30,
    });
    const started = await applyApprovedTradingPaperEntrySessionControl(
      second.prisma,
      owner,
      start.id,
    );
    expect(started).toMatchObject({ ok: true, status: "active", revision: 1 });
    expect(await readVerifiedTradingPaperEntrySession(first.prisma, owner, ledgerId)).toMatchObject(
      {
        status: "active",
        revision: 1,
      },
    );

    const active = await second.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(active).toMatchObject({ status: "ready", sessionRevision: 1 });

    const tokenless = await first.prisma.$transaction((tx) =>
      lockAndVerifyTradingPaperEntrySessionInTransaction(tx, owner, ledgerId),
    );
    expect(tokenless).toMatchObject({
      status: "deny",
      reason: "session_revision_missing",
    });
    const correctlyFenced = await second.prisma.$transaction((tx) =>
      lockAndVerifyTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(correctlyFenced).toMatchObject({ status: "ready", sessionRevision: 1 });

    const duplicate = await effect("paper_session_control", {
      action: "start",
      ledger_id: ledgerId,
      expected_revision: 1,
      duration_minutes: 30,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(first.prisma, owner, duplicate.id),
    ).toMatchObject({ ok: false, reason: "already_active", currentRevision: 1 });

    const crossOwner = { ...owner, userId: `different-${suffix}` };
    await expect(
      readVerifiedTradingPaperEntrySession(second.prisma, crossOwner, ledgerId),
    ).rejects.toThrow("PAPER ledger unavailable");

    const pause = await effect("paper_session_control", {
      action: "pause",
      ledger_id: ledgerId,
      expected_revision: 1,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(first.prisma, owner, pause.id),
    ).toMatchObject({ ok: true, status: "paused", revision: 2 });
    const paused = await first.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(paused).toMatchObject({ status: "deny", reason: "session_paused_or_ended" });

    const afterPause = await second.prisma.$transaction((tx) =>
      lockAndVerifyTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(afterPause).toMatchObject({ status: "deny", reason: "session_paused_or_ended" });

    const staleEnd = await effect("paper_session_control", {
      action: "end",
      ledger_id: ledgerId,
      expected_revision: 1,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(second.prisma, owner, staleEnd.id),
    ).toMatchObject({ ok: false, reason: "stale_revision", currentRevision: 2 });

    const end = await effect("paper_session_control", {
      action: "end",
      ledger_id: ledgerId,
      expected_revision: 2,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(second.prisma, owner, end.id),
    ).toMatchObject({ ok: true, status: "ended", revision: 3 });
    expect(await readVerifiedTradingPaperEntrySession(first.prisma, owner, ledgerId)).toMatchObject(
      {
        status: "ended",
        revision: 3,
      },
    );

    const newStart = await effect("paper_session_control", {
      action: "start",
      ledger_id: ledgerId,
      expected_revision: 3,
      duration_minutes: 5,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(first.prisma, owner, newStart.id),
    ).toMatchObject({ ok: true, status: "active", revision: 4 });
    const staleWake = await second.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(staleWake).toMatchObject({ status: "deny", reason: "worker_gate_changed" });

    const staleMoney = await first.prisma.$transaction((tx) =>
      lockAndVerifyTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(staleMoney).toMatchObject({ status: "deny", reason: "worker_gate_changed" });
    const newMoney = await second.prisma.$transaction((tx) =>
      lockAndVerifyTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 4),
    );
    expect(newMoney).toMatchObject({ status: "ready", sessionRevision: 4 });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(0);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(0);
  });

  it("H2a releases only pending PAPER reserves after approved Pause, never closes positions and is idempotent", async () => {
    const instrument = TradingInstrumentSchema.parse({
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
    const observedAt = new Date().toISOString();
    const quote = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      instrument,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt,
        fetchedAt: observedAt,
        bid: "100",
        ask: "100.1",
        quoteVolume24h: "100000",
      },
    );
    const signal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `h2a-${suffix}`,
      strategyId: "h2a-fixture",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market: instrument,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "H2a synthetic settlement",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const held = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      signal,
      quote.id,
    );
    expect(held.status).toBe("reserved");
    expect(
      (await readVerifiedTradingPaperLedger(first.prisma, owner, ledgerId)).reservations,
    ).toHaveLength(1);

    await expect(
      settleVerifiedTradingPaperSessionReservations(second.prisma, owner, ledgerId),
    ).rejects.toThrow("An active or absent entry session cannot authorize");
    expect(await first.prisma.tradingPaperReleaseAudit.count({ where: { ledgerId } })).toBe(0);

    const pause = await effect("paper_session_control", {
      action: "pause",
      ledger_id: ledgerId,
      expected_revision: 4,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(second.prisma, owner, pause.id),
    ).toMatchObject({ ok: true, status: "paused", revision: 5 });

    const settled = await settleVerifiedTradingPaperSessionReservations(
      first.prisma,
      owner,
      ledgerId,
    );
    expect(settled).toMatchObject({
      status: "settled_reservations",
      sessionRevision: 5,
      sessionStatus: "paused",
      releasedReservations: 1,
      remainingReservations: 0,
      openPositions: 0,
    });
    expect(
      await settleVerifiedTradingPaperSessionReservations(second.prisma, owner, ledgerId),
    ).toMatchObject({
      sessionRevision: 5,
      releasedReservations: 0,
      remainingReservations: 0,
    });
    const audited = await auditTradingPaperLifecycle(first.prisma, owner, ledgerId);
    expect(audited.openReservations).toBe(0);
    const rows = await first.prisma.tradingPaperReleaseAudit.findMany({ where: { ledgerId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("session_end");
    const state = await readVerifiedTradingPaperLedger(second.prisma, owner, ledgerId);
    expect(state.reservations).toHaveLength(0);
    expect(state.positions).toHaveLength(0);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(2);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(2);
    await expect(
      settleVerifiedTradingPaperSessionReservations(
        second.prisma,
        { ...owner, userId: `other-${suffix}` },
        ledgerId,
      ),
    ).rejects.toThrow();
  });
  it("H2b requires separate owner approval and refuses fake protective oversight for a flat ledger", async () => {
    expect(await readVerifiedTradingPaperProtectionLease(first.prisma, owner, ledgerId))
      .toMatchObject({ status: "absent", revision: 0 });
    await expect(
      readTradingPaperProtectionWakePreflight(first.prisma, owner, ledgerId, 1, 2),
    ).resolves.toMatchObject({
      status: "deny", reason: "protection_not_active",
    });

    const start = await effect("paper_protection_control", {
      action: "start",
      ledger_id: ledgerId,
      expected_revision: 0,
      cadence_minutes: 15,
      duration_minutes: 30,
    });
    expect(
      await applyApprovedTradingPaperProtectionControl(second.prisma, owner, start.id),
    ).toMatchObject({
      ok: false,
      reason: "no_protectable_positions",
      currentRevision: 0,
    });
    expect(await first.prisma.tradingPaperProtectionLease.count({ where: { ledgerId } }))
      .toBe(0);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(2);

    const end = await effect("paper_protection_control", {
      action: "end", ledger_id: ledgerId, expected_revision: 0,
    });
    expect(
      await applyApprovedTradingPaperProtectionControl(first.prisma, owner, end.id),
    ).toMatchObject({ ok: false, reason: "not_active" });
    await expect(
      readVerifiedTradingPaperProtectionLease(
        second.prisma, { spaceId: owner.spaceId, userId: `different-${suffix}` }, ledgerId,
      ),
    ).rejects.toThrow("PAPER protection ledger owner mismatch");
  });

});
