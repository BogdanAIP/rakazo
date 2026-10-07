import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma } from "./client.js";
import { fillApprovedTradingPaperReservation } from "./trading-paper-fill.js";
import { auditTradingPaperLifecycle } from "./trading-paper-lifecycle-audit.js";
import { recordPublicAdapterPaperQuoteEvidence } from "./trading-paper-quote-evidence.js";
import { reserveApprovedTradingPaperSignal } from "./trading-paper-reserve.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger } from "./trading-paper-store.js";
import {
  applyApprovedTradingPaperWorkerFillControl,
  PaperWorkerFillGateIntegrityError,
  readTradingPaperWorkerFillPreflight,
  readVerifiedTradingPaperWorkerFillGate,
} from "./trading-paper-worker-fill-gate.js";
import { applyApprovedTradingPaperWorkerControl } from "./trading-paper-worker-gate.js";
import {
  applyApprovedTradingPaperWorkerMarketTargetControl,
  readTradingPaperWorkerMarketTargetPreflight,
} from "./trading-paper-worker-market-target.js";
import {
  applyApprovedTradingPaperWorkerSignalControl,
  readTradingPaperWorkerSignalPreflight,
} from "./trading-paper-worker-signal-gate.js";
import { readVerifiedTradingPaperWorkerAutomaticStopCandidates } from "./trading-paper-worker-stop-preflight.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("paper worker fill gate PostgreSQL authorization", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-fill-gate-user-${suffix}`,
    spaceId: `paper-fill-gate-space-${suffix}`,
  };
  const orgId = `paper-fill-gate-org-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-fill-gate-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-fill-gate-second" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Paper Fill Gate Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Paper Fill Gate Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-fill-gate-member-${suffix}`,
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
        name: "Paper Fill Gate Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-fill-gate-space-member-${suffix}`,
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
    kind:
      | "paper_trading_control"
      | "paper_worker_control"
      | "paper_worker_signal_control"
      | "paper_worker_fill_control"
      | "paper_worker_market_target_control",
    label: string,
    request: Prisma.InputJsonValue,
  ) => {
    const botId = `paper-fill-gate-bot-${label}-${suffix}`;
    const threadId = `paper-fill-gate-thread-${label}-${suffix}`;
    const taskId = `paper-fill-gate-task-${label}-${suffix}`;
    const runId = `paper-fill-gate-run-${label}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Paper Fill Gate Helper",
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
        prompt: "paper fill gate helper",
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
        id: `paper-fill-gate-effect-${label}-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind,
        idempotencyKey: `paper-fill-gate-key-${label}-${suffix}`,
        status: "executing",
        request,
      },
    });
  };

  it("F3 revalidates F2 and market target inside C1 and keeps restart-verifiable provenance", async () => {
    const ledgerId = `paper-fill-f3-ledger-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 60_000).toISOString(),
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

    const paper = await makeEffect("paper_trading_control", "f3-paper-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 0,
    });
    await applyApprovedTradingPaperControl(first.prisma, owner, paper.id);
    const worker = await makeEffect("paper_worker_control", "f3-worker-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, worker.id);
    const target = await makeEffect("paper_worker_market_target_control", "f3-target-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      venue: "okx",
      symbol: "SOL-USDT",
    });
    await applyApprovedTradingPaperWorkerMarketTargetControl(first.prisma, owner, target.id);
    const signal = await makeEffect("paper_worker_signal_control", "f3-signal-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await applyApprovedTradingPaperWorkerSignalControl(first.prisma, owner, signal.id);
    const fillGate = await makeEffect("paper_worker_fill_control", "f3-fill-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      expected_signal_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await applyApprovedTradingPaperWorkerFillControl(first.prisma, owner, fillGate.id);

    const signalAuthority = await readTradingPaperWorkerSignalPreflight(
      first.prisma,
      owner,
      ledgerId,
    );
    const fillAuthority = await readTradingPaperWorkerFillPreflight(first.prisma, owner, ledgerId);
    const targetAuthority = await readTradingPaperWorkerMarketTargetPreflight(
      first.prisma,
      owner,
      ledgerId,
    );
    if (signalAuthority.status !== "ready") throw new Error("expected F0 authority");
    if (fillAuthority.status !== "ready") throw new Error("expected F2 authority");
    if (targetAuthority.status !== "ready") throw new Error("expected target authority");

    const market = {
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
    } as const;
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
    const proposal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `paper-fill-f3-signal-${suffix}`,
      strategyId: "breakout_20_1h_v1",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["research-only"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "F3 transactional authority regression",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserved = await reserveApprovedTradingPaperSignal(
      first.prisma,
      owner,
      ledgerId,
      proposal,
      reserveEvidence.id,
      signalAuthority,
    );
    if (reserved.status !== "reserved") throw new Error("expected F1 reservation");

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

    const disableTarget = await makeEffect(
      "paper_worker_market_target_control",
      "f3-target-disable",
      {
        action: "disable",
        ledger_id: ledgerId,
        expected_gate_revision: 0,
      },
    );
    await applyApprovedTradingPaperWorkerMarketTargetControl(
      second.prisma,
      owner,
      disableTarget.id,
    );
    const reenableTarget = await makeEffect(
      "paper_worker_market_target_control",
      "f3-target-reenable",
      {
        action: "enable",
        ledger_id: ledgerId,
        expected_gate_revision: 1,
        venue: "okx",
        symbol: "SOL-USDT",
      },
    );
    await applyApprovedTradingPaperWorkerMarketTargetControl(
      second.prisma,
      owner,
      reenableTarget.id,
    );

    await expect(
      fillApprovedTradingPaperReservation(
        first.prisma,
        owner,
        ledgerId,
        reserved.reservationId,
        fillEvidence.id,
        fillAuthority,
        targetAuthority,
      ),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "paper_worker_target_unapproved",
    });
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_buy" } }),
    ).toBe(0);

    const renewedTarget = await readTradingPaperWorkerMarketTargetPreflight(
      first.prisma,
      owner,
      ledgerId,
    );
    if (renewedTarget.status !== "ready") throw new Error("expected renewed target authority");
    const filled = await fillApprovedTradingPaperReservation(
      second.prisma,
      owner,
      ledgerId,
      reserved.reservationId,
      fillEvidence.id,
      fillAuthority,
      renewedTarget,
    );
    expect(filled).toMatchObject({
      status: "filled",
      mode: "paper_only",
      reservationId: reserved.reservationId,
    });
    if (filled.status !== "filled") throw new Error("expected F3 fill");

    const use = await first.prisma.tradingPaperWorkerFillUse.findUniqueOrThrow({
      where: {
        ledgerId_reservationId: {
          ledgerId,
          reservationId: reserved.reservationId,
        },
      },
    });
    expect(use).toMatchObject({
      fillApprovalEffectId: fillGate.id,
      targetApprovalEffectId: reenableTarget.id,
      strategyId: "breakout_20_1h_v1",
      venue: "okx",
      symbol: "SOL-USDT",
      policyRevision: 1,
      gateRevision: 1,
      signalRevision: 1,
      fillRevision: 1,
      targetRevision: 3,
      evidenceId: fillEvidence.id,
      reserveEventSequence: reserved.eventSequence,
      fillEventSequence: filled.fillEventSequence,
    });
    await expect(auditTradingPaperLifecycle(first.prisma, owner, ledgerId)).resolves.toMatchObject({
      status: "verified",
      fillDecisions: 1,
      openPositions: 1,
      openReservations: 0,
    });

    const stopCandidates = await readVerifiedTradingPaperWorkerAutomaticStopCandidates(
      second.prisma,
      owner,
      ledgerId,
    );
    expect(stopCandidates).toEqual({
      status: "ready",
      mode: "paper_only",
      ledgerId,
      positions: [
        {
          mode: "paper_only",
          ledgerId,
          positionId: reserved.reservationId,
          signalId: proposal.signalId,
          venue: "okx",
          symbol: "SOL-USDT",
          quantityBase: filled.quantityBase,
          stopPriceQuote: "95",
          policyRevision: 1,
          gateRevision: 1,
          signalRevision: 1,
          fillRevision: 1,
          targetRevision: 3,
          fillApprovalEffectId: fillGate.id,
          targetApprovalEffectId: reenableTarget.id,
          fillEventSequence: filled.fillEventSequence,
        },
      ],
    });

    await first.prisma.tradingPaperWorkerFillUse.update({
      where: {
        ledgerId_reservationId: {
          ledgerId,
          reservationId: reserved.reservationId,
        },
      },
      data: { useSha256: "0".repeat(64) },
    });
    await expect(auditTradingPaperLifecycle(second.prisma, owner, ledgerId)).rejects.toBeInstanceOf(
      PaperWorkerFillGateIntegrityError,
    );
    await first.prisma.tradingPaperWorkerFillUse.update({
      where: {
        ledgerId_reservationId: {
          ledgerId,
          reservationId: reserved.reservationId,
        },
      },
      data: { useSha256: use.useSha256 },
    });
    await expect(auditTradingPaperLifecycle(second.prisma, owner, ledgerId)).resolves.toMatchObject(
      {
        status: "verified",
        fillDecisions: 1,
      },
    );
  });

  it("requires separate fill permission and invalidates it when the signal gate changes", async () => {
    const ledgerId = `paper-fill-gate-ledger-${suffix}`;
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
    await applyApprovedTradingPaperControl(first.prisma, owner, paper.id);
    const worker = await makeEffect("paper_worker_control", "worker-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, worker.id);
    const signal = await makeEffect("paper_worker_signal_control", "signal-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await applyApprovedTradingPaperWorkerSignalControl(first.prisma, owner, signal.id);

    expect(await readVerifiedTradingPaperWorkerFillGate(first.prisma, owner, ledgerId)).toEqual({
      configured: false,
      mode: "paper_only",
      ledgerId,
      enabled: false,
    });
    const before = {
      routines: await first.prisma.routine.count({
        where: { spaceId: owner.spaceId, userId: owner.userId },
      }),
      events: await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } }),
      outbox: await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } }),
      reservations: await first.prisma.tradingPaperReservationDecision.count({
        where: { ledgerId },
      }),
      fills: await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } }),
    };

    const enableFill = await makeEffect("paper_worker_fill_control", "fill-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      expected_signal_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await expect(
      applyApprovedTradingPaperWorkerFillControl(second.prisma, owner, enableFill.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: true,
      strategyId: "breakout_20_1h_v1",
      policyRevision: 1,
      gateRevision: 1,
      signalRevision: 1,
      fillRevision: 1,
    });
    await expect(
      readTradingPaperWorkerFillPreflight(first.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "ready",
      strategyId: "breakout_20_1h_v1",
      gateRevision: 1,
      signalRevision: 1,
      fillRevision: 1,
      fillApprovalEffectId: enableFill.id,
      signalApprovalEffectId: signal.id,
    });

    const disableSignal = await makeEffect("paper_worker_signal_control", "signal-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_gate_revision: 0,
    });
    await applyApprovedTradingPaperWorkerSignalControl(first.prisma, owner, disableSignal.id);
    await expect(
      readTradingPaperWorkerFillPreflight(second.prisma, owner, ledgerId),
    ).resolves.toEqual({
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "signal_preflight_denied",
      signalReason: "signal_gate_disabled",
    });

    const reenableSignal = await makeEffect("paper_worker_signal_control", "signal-reenable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await applyApprovedTradingPaperWorkerSignalControl(first.prisma, owner, reenableSignal.id);
    await expect(
      readTradingPaperWorkerFillPreflight(second.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "fill_gate_signal_changed",
      currentGateRevision: 1,
      currentSignalRevision: 3,
    });

    const staleFill = await makeEffect("paper_worker_fill_control", "fill-stale-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      expected_signal_revision: 1,
      strategy_id: "breakout_20_1h_v1",
    });
    await expect(
      applyApprovedTradingPaperWorkerFillControl(first.prisma, owner, staleFill.id),
    ).resolves.toMatchObject({
      ok: false,
      error: "stale_signal_revision",
      currentGateRevision: 1,
      currentSignalRevision: 3,
    });

    const renewFill = await makeEffect("paper_worker_fill_control", "fill-renew", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      expected_signal_revision: 3,
      strategy_id: "breakout_20_1h_v1",
    });
    await expect(
      applyApprovedTradingPaperWorkerFillControl(first.prisma, owner, renewFill.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: true,
      gateRevision: 1,
      signalRevision: 3,
      fillRevision: 2,
    });
    await expect(
      readTradingPaperWorkerFillPreflight(second.prisma, owner, ledgerId),
    ).resolves.toMatchObject({
      status: "ready",
      gateRevision: 1,
      signalRevision: 3,
      fillRevision: 2,
      fillApprovalEffectId: renewFill.id,
      signalApprovalEffectId: reenableSignal.id,
    });

    const disableFill = await makeEffect("paper_worker_fill_control", "fill-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_gate_revision: 0,
      expected_signal_revision: 0,
    });
    await expect(
      applyApprovedTradingPaperWorkerFillControl(first.prisma, owner, disableFill.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: false,
      strategyId: null,
      gateRevision: 1,
      signalRevision: 3,
      fillRevision: 3,
    });
    await expect(
      readTradingPaperWorkerFillPreflight(second.prisma, owner, ledgerId),
    ).resolves.toEqual({
      status: "deny",
      mode: "paper_only",
      ledgerId,
      reason: "fill_gate_disabled",
    });

    expect(
      await first.prisma.routine.count({ where: { spaceId: owner.spaceId, userId: owner.userId } }),
    ).toBe(before.routines);
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      before.events,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      before.outbox,
    );
    expect(await first.prisma.tradingPaperReservationDecision.count({ where: { ledgerId } })).toBe(
      before.reservations,
    );
    expect(await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } })).toBe(
      before.fills,
    );

    await first.prisma.tradingPaperWorkerFillGate.update({
      where: { ledgerId },
      data: { gateSha256: "0".repeat(64) },
    });
    await expect(
      readVerifiedTradingPaperWorkerFillGate(second.prisma, owner, ledgerId),
    ).rejects.toBeInstanceOf(PaperWorkerFillGateIntegrityError);
    expect(
      await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId, kind: "fill_buy" } }),
    ).toBe(0);
  });
});
