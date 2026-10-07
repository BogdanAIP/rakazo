import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma } from "./client.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger } from "./trading-paper-store.js";
import { applyApprovedTradingPaperWorkerControl } from "./trading-paper-worker-gate.js";
import {
  applyApprovedTradingPaperWorkerSignalControl,
  readTradingPaperWorkerSignalPreflight,
  readVerifiedTradingPaperWorkerSignalGate,
} from "./trading-paper-worker-signal-gate.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("paper worker signal gate PostgreSQL authorization", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-signal-user-${suffix}`,
    spaceId: `paper-signal-space-${suffix}`,
  };
  const orgId = `paper-signal-org-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-signal-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-signal-second" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Paper Signal Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Paper Signal Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-signal-member-${suffix}`,
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
        name: "Paper Signal Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-signal-space-member-${suffix}`,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
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

  const makeEffect = async (
    kind: "paper_trading_control" | "paper_worker_control" | "paper_worker_signal_control",
    label: string,
    request: Prisma.InputJsonValue,
  ) => {
    const botId = `paper-signal-bot-${label}-${suffix}`;
    const threadId = `paper-signal-thread-${label}-${suffix}`;
    const taskId = `paper-signal-task-${label}-${suffix}`;
    const runId = `paper-signal-run-${label}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper Signal Helper",
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
        prompt: "paper signal helper",
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
        id: `paper-signal-effect-${label}-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind,
        idempotencyKey: `paper-signal-key-${label}-${suffix}`,
        status: "executing",
        request,
      },
    });
  };

  it("requires a separate explicit strategy gate and invalidates it on worker revision change", async () => {
    const ledgerId = `paper-signal-ledger-${suffix}`;
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

    const paper = await makeEffect("paper_trading_control", "paper-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 0,
    });
    await expect(
      applyApprovedTradingPaperControl(first.prisma, owner, paper.id),
    ).resolves.toMatchObject({ ok: true, enabled: true, policyRevision: 1 });

    const worker = await makeEffect("paper_worker_control", "worker-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await expect(
      applyApprovedTradingPaperWorkerControl(second.prisma, owner, worker.id),
    ).resolves.toMatchObject({ ok: true, enabled: true, gateRevision: 1 });

    expect(await readVerifiedTradingPaperWorkerSignalGate(first.prisma, owner, ledgerId)).toEqual({
      configured: false,
      mode: "paper_only",
      ledgerId,
      enabled: false,
    });
    const routinesBefore = await first.prisma.routine.count({
      where: { spaceId: owner.spaceId, userId: owner.userId },
    });
    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });

    const enableSignal = await makeEffect("paper_worker_signal_control", "signal-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await expect(
      applyApprovedTradingPaperWorkerSignalControl(second.prisma, owner, enableSignal.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: true,
      strategyId: "breakout_20_1h_v1",
      policyRevision: 1,
      gateRevision: 1,
      signalRevision: 1,
    });
    await expect(
      readTradingPaperWorkerSignalPreflight(first.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "ready",
      strategyId: "breakout_20_1h_v1",
      gateRevision: 1,
      signalRevision: 1,
      signalApprovalEffectId: enableSignal.id,
    });

    const disableWorker = await makeEffect("paper_worker_control", "worker-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
    });
    await expect(
      applyApprovedTradingPaperWorkerControl(first.prisma, owner, disableWorker.id),
    ).resolves.toMatchObject({ ok: true, enabled: false, gateRevision: 2 });
    await expect(
      readTradingPaperWorkerSignalPreflight(second.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "worker_preflight_denied",
      workerReason: "worker_gate_disabled",
    });

    const reenableWorker = await makeEffect("paper_worker_control", "worker-reenable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await expect(
      applyApprovedTradingPaperWorkerControl(first.prisma, owner, reenableWorker.id),
    ).resolves.toMatchObject({ ok: true, enabled: true, gateRevision: 3 });
    await expect(
      readTradingPaperWorkerSignalPreflight(second.prisma, owner, ledgerId),
    ).resolves.toEqual({
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "signal_gate_worker_changed",
      currentGateRevision: 3,
    });

    const staleEnable = await makeEffect("paper_worker_signal_control", "signal-stale-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await expect(
      applyApprovedTradingPaperWorkerSignalControl(first.prisma, owner, staleEnable.id),
    ).resolves.toMatchObject({
      ok: false,
      error: "stale_gate_revision",
      currentGateRevision: 3,
    });

    const disableSignal = await makeEffect("paper_worker_signal_control", "signal-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_gate_revision: 0,
    });
    await expect(
      applyApprovedTradingPaperWorkerSignalControl(second.prisma, owner, disableSignal.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: false,
      strategyId: null,
      signalRevision: 2,
    });
    await expect(
      readTradingPaperWorkerSignalPreflight(first.prisma, owner, ledgerId),
    ).resolves.toEqual({
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "signal_gate_disabled",
    });

    expect(
      await first.prisma.routine.count({ where: { spaceId: owner.spaceId, userId: owner.userId } }),
    ).toBe(routinesBefore);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      eventsBefore,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      outboxBefore,
    );
  });
});
