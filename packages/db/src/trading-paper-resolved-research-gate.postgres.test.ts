import { randomUUID } from "node:crypto";
import type { TradingResolvedResearchEnvelope } from "@rakazo/contracts";
import { resolvedTradingResearchApprovalScope } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma } from "./client.js";
import { recordPublicAdapterPaperQuoteEvidence } from "./trading-paper-quote-evidence.js";
import { reserveApprovedResolvedTradingPaperSignal } from "./trading-paper-reserve.js";
import {
  applyApprovedTradingPaperResolvedResearchControl,
  readTradingPaperResolvedResearchPreflight,
  readVerifiedTradingPaperResolvedResearchGate,
} from "./trading-paper-resolved-research-gate.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger } from "./trading-paper-store.js";
import { applyApprovedTradingPaperWorkerControl } from "./trading-paper-worker-gate.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("resolved research PAPER gate PostgreSQL authorization", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `resolved-research-user-${suffix}`,
    spaceId: `resolved-research-space-${suffix}`,
  };
  const orgId = `resolved-research-org-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "resolved-research-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "resolved-research-second" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Resolved Research Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Resolved Research Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `resolved-research-member-${suffix}`,
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
        name: "Resolved Research Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `resolved-research-space-member-${suffix}`,
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

  const makeEffect = async (kind: string, label: string, request: Prisma.InputJsonValue) => {
    const botId = `resolved-research-bot-${label}-${suffix}`;
    const threadId = `resolved-research-thread-${label}-${suffix}`;
    const taskId = `resolved-research-task-${label}-${suffix}`;
    const runId = `resolved-research-run-${label}-${suffix}`;
    await first.prisma.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Resolved Research Helper",
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
        prompt: "resolved research helper",
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
        id: `resolved-research-effect-${label}-${suffix}`,
        spaceId: owner.spaceId,
        runId,
        kind,
        idempotencyKey: `resolved-research-key-${label}-${suffix}`,
        status: "executing",
        request,
      },
    });
  };

  const envelope = (overrides: Partial<TradingResolvedResearchEnvelope> = {}) =>
    ({
      schemaVersion: "trading-resolved-research-v1",
      mode: "research_only",
      executionAuthority: "none",
      provenance: {
        semanticKey: "signal.discovery",
        resolverKey: "signal.discovery",
        resolverDigest: "a".repeat(64),
        implementation: {
          name: "CCXT trading-signal Agent Skill",
          kind: "api",
          reference: "market:ccxt/ccxt:trading-signal",
          priority: 1,
          readOnly: true,
        },
        skill: {
          marketEntryId: `market-skill-${suffix}`,
          marketKey: "ccxt.trading-signal",
          sourceDigest: "b".repeat(64),
          variant: "original",
        },
        resolvedAt: new Date(Date.now() - 2_000).toISOString(),
      },
      signal: {
        kind: "proposal",
        executionStatus: "research_only",
        signalId: `resolved-proposal-${suffix}`,
        strategyId: "resolver_signal_v1",
        strategyVersion: "1",
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        evidenceIds: [`resolver-evidence-${suffix}`],
        market: {
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
        },
        action: "spot_buy",
        entryTrigger: "100",
        stopLoss: "95",
        takeProfit: ["110"],
        invalidation: "fixture",
        rationale: "generic resolver gate fixture",
        riskBudgetQuote: null,
        maxSlippageBps: null,
      },
      ...overrides,
    }) satisfies TradingResolvedResearchEnvelope;

  it("authorizes exactly one Resolver/Skill scope and invalidates it when worker authority changes", async () => {
    const ledgerId = `resolved-research-ledger-${suffix}`;
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

    const research = envelope();
    const scope = resolvedTradingResearchApprovalScope(research);
    expect(
      await readVerifiedTradingPaperResolvedResearchGate(first.prisma, owner, ledgerId),
    ).toEqual({
      configured: false,
      mode: "paper_only",
      ledgerId,
      enabled: false,
    });

    const eventsBefore = await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } });
    const outboxBefore = await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } });

    const enable = await makeEffect("paper_resolved_research_control", "research-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      scope,
    });
    await expect(
      applyApprovedTradingPaperResolvedResearchControl(second.prisma, owner, enable.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: true,
      scope,
      policyRevision: 1,
      gateRevision: 1,
      researchRevision: 1,
    });
    await expect(
      readTradingPaperResolvedResearchPreflight(first.prisma, owner, ledgerId, research),
    ).resolves.toMatchObject({
      status: "ready",
      scope,
      signalId: research.signal.signalId,
      gateRevision: 1,
      researchRevision: 1,
      researchApprovalEffectId: enable.id,
    });

    const differentImplementation = envelope({
      provenance: {
        ...research.provenance,
        implementation: {
          ...research.provenance.implementation,
          reference: "market:okx/agent-trade-kit:okx-cex-market",
        },
      },
    });
    await expect(
      readTradingPaperResolvedResearchPreflight(
        second.prisma,
        owner,
        ledgerId,
        differentImplementation,
      ),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "resolved_research_scope_mismatch",
    });

    const disableWorker = await makeEffect("paper_worker_control", "worker-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
    });
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, disableWorker.id);
    await expect(
      readTradingPaperResolvedResearchPreflight(second.prisma, owner, ledgerId, research),
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
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, reenableWorker.id);
    await expect(
      readTradingPaperResolvedResearchPreflight(second.prisma, owner, ledgerId, research),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "resolved_research_gate_worker_changed",
      currentGateRevision: 3,
    });

    const disable = await makeEffect("paper_resolved_research_control", "research-disable", {
      action: "disable",
      ledger_id: ledgerId,
      expected_gate_revision: 3,
    });
    await expect(
      applyApprovedTradingPaperResolvedResearchControl(second.prisma, owner, disable.id),
    ).resolves.toMatchObject({
      ok: true,
      enabled: false,
      scope: null,
      researchRevision: 2,
    });
    await expect(
      readTradingPaperResolvedResearchPreflight(first.prisma, owner, ledgerId, research),
    ).resolves.toMatchObject({
      status: "deny",
      reason: "resolved_research_gate_disabled",
    });

    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(
      eventsBefore,
    );
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(
      outboxBefore,
    );
  });

  it("creates only a B7 PAPER reserve with immutable G1 provenance and replays idempotently", async () => {
    const ledgerId = `resolved-reserve-ledger-${suffix}`;
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

    const paper = await makeEffect("paper_trading_control", "g2-paper-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 0,
    });
    await applyApprovedTradingPaperControl(first.prisma, owner, paper.id);
    const worker = await makeEffect("paper_worker_control", "g2-worker-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_policy_revision: 1,
      cadence_minutes: 15,
    });
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, worker.id);

    const research = envelope();
    const scope = resolvedTradingResearchApprovalScope(research);
    const approval = await makeEffect("paper_resolved_research_control", "g2-research-enable", {
      action: "enable",
      ledger_id: ledgerId,
      expected_gate_revision: 1,
      scope,
    });
    await applyApprovedTradingPaperResolvedResearchControl(first.prisma, owner, approval.id);
    const authority = await readTradingPaperResolvedResearchPreflight(
      first.prisma,
      owner,
      ledgerId,
      research,
    );
    if (authority.status !== "ready") {
      throw new Error(`Expected G1 authority, got ${authority.reason}`);
    }

    const observedAt = new Date().toISOString();
    const evidence = await recordPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      research.signal.kind === "proposal" ? research.signal.market : null,
      {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt,
        fetchedAt: observedAt,
        bid: "99.9",
        ask: "100",
        quoteVolume24h: "1000000",
      },
    );

    const created = await reserveApprovedResolvedTradingPaperSignal(
      second.prisma,
      owner,
      ledgerId,
      research,
      evidence.id,
      authority,
    );
    expect(created).toMatchObject({
      status: "reserved",
      mode: "paper_only",
      signalId: research.signal.signalId,
      policyRevision: 1,
    });
    if (created.status !== "reserved") throw new Error("Expected G2 reserve");

    const decision = await first.prisma.tradingPaperReservationDecision.findUniqueOrThrow({
      where: {
        ledgerId_reservationId: { ledgerId, reservationId: created.reservationId },
      },
    });
    expect(decision.policyApprovalEffectId).toBe(approval.id);
    const use = await first.prisma.tradingPaperResolvedResearchReserveUse.findUniqueOrThrow({
      where: {
        ledgerId_reservationId: { ledgerId, reservationId: created.reservationId },
      },
    });
    expect(use).toMatchObject({
      signalId: research.signal.signalId,
      researchApprovalEffectId: approval.id,
      policyRevision: 1,
      gateRevision: 1,
      researchRevision: 1,
      evidenceId: evidence.id,
      reserveEventSequence: created.eventSequence,
    });
    expect(await first.prisma.tradingPaperFillDecision.count({ where: { ledgerId } })).toBe(0);

    await expect(
      reserveApprovedResolvedTradingPaperSignal(
        first.prisma,
        owner,
        ledgerId,
        research,
        evidence.id,
        authority,
      ),
    ).resolves.toMatchObject({
      status: "duplicate",
      reservationId: created.reservationId,
      eventSequence: created.eventSequence,
    });
    expect(
      await first.prisma.tradingPaperResolvedResearchReserveUse.count({ where: { ledgerId } }),
    ).toBe(1);
  });
});
