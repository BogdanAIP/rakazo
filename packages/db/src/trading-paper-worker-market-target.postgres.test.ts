import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma } from "./client.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger } from "./trading-paper-store.js";
import {
  applyApprovedTradingPaperWorkerControl,
  readVerifiedTradingPaperWorkerGate,
} from "./trading-paper-worker-gate.js";
import {
  applyApprovedTradingPaperWorkerMarketTargetControl,
  PaperWorkerMarketTargetIntegrityError,
  readTradingPaperWorkerMarketTargetPreflight,
  readVerifiedTradingPaperWorkerMarketTarget,
} from "./trading-paper-worker-market-target.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("paper worker market target PostgreSQL authorization", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-target-user-${suffix}`,
    spaceId: `paper-target-space-${suffix}`,
  };
  const orgId = `paper-target-org-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-target-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-target-second" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Paper Target Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Paper Target Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-target-member-${suffix}`,
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
        name: "Paper Target Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-target-space-member-${suffix}`,
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
    kind: "paper_trading_control" | "paper_worker_control" | "paper_worker_market_target_control",
    label: string,
    request: Record<string, unknown>,
  ) => {
    const botId = `paper-target-bot-${label}-${suffix}`;
    const threadId = `paper-target-thread-${label}-${suffix}`;
    const taskId = `paper-target-task-${label}-${suffix}`;
    const runId = `paper-target-run-${label}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper Target Helper",
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
        prompt: "paper target helper",
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
        id: `paper-target-effect-${label}-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind,
        idempotencyKey: `paper-target-key-${label}-${suffix}`,
        status: "executing",
        request: request as Prisma.InputJsonValue,
      },
    });
  };

  const createEnabledPaperWorker = async (ledgerId: string, label: string) => {
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 30_000).toISOString(),
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
    const paper = await makeEffect("paper_trading_control", `${label}-paper`, {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 0,
    });
    await applyApprovedTradingPaperControl(first.prisma, owner, paper.id);
    const worker = await makeEffect("paper_worker_control", `${label}-worker`, {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await applyApprovedTradingPaperWorkerControl(second.prisma, owner, worker.id);
  };

  it("binds one explicit target to the current worker gate and revokes stale-safe", async () => {
    const ledgerId = `paper-target-ledger-${suffix}`;
    await createEnabledPaperWorker(ledgerId, "main");
    expect(await readVerifiedTradingPaperWorkerMarketTarget(first.prisma, owner, ledgerId)).toEqual(
      {
        configured: false,
        mode: "paper_only",
        ledgerId,
        enabled: false,
      },
    );

    const routinesBefore = await first.prisma.routine.count({
      where: { spaceId: owner.spaceId, userId: owner.userId },
    });
    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });

    const enable = await makeEffect("paper_worker_market_target_control", "target-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      venue: "okx",
      symbol: "SOL-USDT",
    });
    await expect(
      applyApprovedTradingPaperWorkerMarketTargetControl(second.prisma, owner, enable.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: true,
      venue: "okx",
      symbol: "SOL-USDT",
      gateRevision: 1,
      targetRevision: 1,
    });
    await expect(
      readTradingPaperWorkerMarketTargetPreflight(first.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "ready",
      venue: "okx",
      symbol: "SOL-USDT",
      gateRevision: 1,
      targetRevision: 1,
      targetApprovalEffectId: enable.id,
    });

    const badQuote = await makeEffect("paper_worker_market_target_control", "target-bad-quote", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      venue: "bingx",
      symbol: "SOL-USDC",
    });
    await expect(
      applyApprovedTradingPaperWorkerMarketTargetControl(first.prisma, owner, badQuote.id),
    ).resolves.toMatchObject({ ok: false, error: "quote_currency_mismatch" });
    await expect(
      readVerifiedTradingPaperWorkerMarketTarget(first.prisma, owner, ledgerId),
    ).resolves.toMatchObject({ enabled: true, symbol: "SOL-USDT", targetRevision: 1 });

    const disableWorker = await makeEffect("paper_worker_control", "target-worker-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
    });
    await applyApprovedTradingPaperWorkerControl(second.prisma, owner, disableWorker.id);
    await expect(
      readTradingPaperWorkerMarketTargetPreflight(first.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "worker_preflight_denied",
      workerReason: "worker_gate_disabled",
    });

    const reenableWorker = await makeEffect("paper_worker_control", "target-worker-reenable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await expect(
      applyApprovedTradingPaperWorkerControl(second.prisma, owner, reenableWorker.id),
    ).resolves.toMatchObject({ ok: true, enabled: true, gateRevision: 3 });
    await expect(
      readTradingPaperWorkerMarketTargetPreflight(first.prisma, owner, ledgerId),
    ).resolves.toEqual({
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "target_gate_changed",
      currentGateRevision: 3,
    });

    const disable = await makeEffect("paper_worker_market_target_control", "target-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_gate_revision: 0,
    });
    await expect(
      applyApprovedTradingPaperWorkerMarketTargetControl(second.prisma, owner, disable.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: false,
      venue: null,
      symbol: null,
      gateRevision: 1,
      targetRevision: 2,
    });
    await expect(
      readTradingPaperWorkerMarketTargetPreflight(first.prisma, owner, ledgerId),
    ).resolves.toEqual({
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "target_disabled",
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
    expect(await readVerifiedTradingPaperWorkerGate(first.prisma, owner, ledgerId)).toMatchObject({
      enabled: true,
      gateRevision: 3,
    });
  });

  it("fails closed when enabled target approval provenance is tampered", async () => {
    const ledgerId = `paper-target-tamper-${suffix}`;
    await createEnabledPaperWorker(ledgerId, "tamper");
    const target = await makeEffect("paper_worker_market_target_control", "tamper-target", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      venue: "okx",
      symbol: "BTC-USDT",
    });
    await applyApprovedTradingPaperWorkerMarketTargetControl(first.prisma, owner, target.id);
    await first.prisma.externalEffect.update({
      where: { id: target.id },
      data: { status: "executing" },
    });
    await expect(
      readTradingPaperWorkerMarketTargetPreflight(second.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperWorkerMarketTargetIntegrityError);
  });
});
