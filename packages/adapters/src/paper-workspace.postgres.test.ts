import { randomUUID } from "node:crypto";
import type { BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import {
  auditTradingPaperLifecycle,
  closeTradingPaperPositionOnStop,
  createDb,
  createOwnedTradingPaperAccount,
  fillApprovedTradingPaperReservation,
  readOwnedTradingPaperWorkspace,
  readTradingPaperWorkerFillPreflight,
  readTradingPaperWorkerMarketTargetPreflight,
  readTradingPaperWorkerSignalPreflight,
  readVerifiedTradingPaperEntrySession,
  readVerifiedTradingPaperLedger,
  recordPublicAdapterPaperQuoteEvidence,
  reserveApprovedTradingPaperSignal,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  controlTradingPaperWorkspace,
  reconcileTradingPaperWorkspaces,
} from "./paper-workspace.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("managed PAPER account lifecycle", () => {
  const suffix = randomUUID(),
    orgId = `paper-workspace-org-${suffix}`;
  const owner = {
    userId: `paper-workspace-user-${suffix}`,
    spaceId: `paper-workspace-space-${suffix}`,
  };
  let db: ReturnType<typeof createDb>;
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const deps = () => ({ prisma: db.prisma, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> });
  const create = () =>
    createOwnedTradingPaperAccount(db.prisma, owner, {
      name: "Training",
      initialBalanceQuote: "500",
      maxPerIdeaRiskQuote: "20",
      maxDailyLossQuote: "100",
      maxOpenRiskQuote: "40",
      maxTotalExposureQuote: "300",
    });
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 3 });
    const createdAt = new Date();
    await db.prisma.user.create({
      data: {
        id: owner.userId,
        name: "PAPER Session Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await db.prisma.organization.create({
      data: { id: orgId, name: "PAPER Session Fixture", slug: orgId, createdAt },
    });
    await db.prisma.member.create({
      data: {
        id: `paper-session-member-${suffix}`,
        organizationId: orgId,
        userId: owner.userId,
        role: "member",
        createdAt,
      },
    });
    await db.prisma.space.create({
      data: {
        id: owner.spaceId,
        organizationId: orgId,
        name: "PAPER Session Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: `paper-session-space-member-${suffix}`,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
    });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id: orgId } });
      await db.prisma.user.deleteMany({ where: { id: owner.userId } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  it("starts only by owner action, fills virtual funds, fences Pause and separately protects an open position", async () => {
    enqueue.mockClear();
    const { ledgerId } = await create();
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, ledgerId)).toMatchObject({
      status: "verified",
      phase: "idle",
      sessionRevision: 0,
      policy: { enabled: false },
    });
    expect(enqueue).not.toHaveBeenCalled();
    const start = {
      action: "start" as const,
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 0,
      venue: "okx" as const,
      symbol: "SOL-USDT",
      durationMinutes: 15,
    };
    await controlTradingPaperWorkspace(deps(), owner, start);
    const active = await readVerifiedTradingPaperEntrySession(db.prisma, owner, ledgerId);
    expect(active).toMatchObject({ status: "active", revision: 1 });
    if (active.status === "absent") throw new Error("missing Start");
    expect(Date.parse(active.expiresAt) - Date.parse(active.startedAt)).toBe(15 * 60_000);
    const queued = enqueue.mock.calls[0]?.[0] as {
      payload: BackgroundJobPayloads["paper.worker-preflight"];
    };
    expect(queued.payload).toMatchObject({
      ledgerId,
      sessionRevision: 1,
      gateRevision: active.workerGateRevision,
    });
    const deadline = active.expiresAt;
    await controlTradingPaperWorkspace(deps(), owner, start);
    expect(await readVerifiedTradingPaperEntrySession(db.prisma, owner, ledgerId)).toMatchObject({
      revision: 1,
      expiresAt: deadline,
    });
    await expect(
      controlTradingPaperWorkspace(
        deps(),
        { ...owner, userId: `other-${suffix}` },
        { ...start, commandId: randomUUID() },
      ),
    ).rejects.toThrow();
    const signalAuthority = await readTradingPaperWorkerSignalPreflight(db.prisma, owner, ledgerId);
    const fillAuthority = await readTradingPaperWorkerFillPreflight(db.prisma, owner, ledgerId);
    const target = await readTradingPaperWorkerMarketTargetPreflight(db.prisma, owner, ledgerId);
    if (
      signalAuthority.status !== "ready" ||
      fillAuthority.status !== "ready" ||
      target.status !== "ready"
    )
      throw new Error("missing approved scopes");
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
    const quote = async (bid: string, ask: string) => {
      const observedAt = new Date().toISOString();
      return recordPublicAdapterPaperQuoteEvidence(db.prisma, owner, ledgerId, market, {
        venue: "okx",
        kind: "spot",
        symbol: "SOL-USDT",
        observedAt,
        fetchedAt: observedAt,
        bid,
        ask,
        quoteVolume24h: "100000",
      });
    };
    const proposal = {
      kind: "proposal",
      executionStatus: "research_only",
      signalId: `workspace-signal-${suffix}`,
      strategyId: "breakout_20_1h_v1",
      strategyVersion: "1",
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      evidenceIds: ["synthetic-fixture"],
      market,
      action: "spot_buy",
      entryTrigger: "100.1",
      stopLoss: "95",
      takeProfit: ["110"],
      invalidation: "fixture",
      rationale: "managed account integration",
      riskBudgetQuote: "10",
      maxSlippageBps: null,
    } as const;
    const reserveQuote = await quote("100", "100.1");
    const held = await reserveApprovedTradingPaperSignal(
      db.prisma,
      owner,
      ledgerId,
      proposal,
      reserveQuote.id,
      signalAuthority,
      undefined,
      1,
    );
    expect(held.status, JSON.stringify(held)).toBe("reserved");
    if (held.status !== "reserved") throw new Error("missing hold");
    const fillQuote = await quote("99.99", "100");
    expect(
      await fillApprovedTradingPaperReservation(
        db.prisma,
        owner,
        ledgerId,
        held.reservationId,
        fillQuote.id,
        fillAuthority,
        target,
        undefined,
        1,
      ),
    ).toMatchObject({ status: "filled", mode: "paper_only" });
    await controlTradingPaperWorkspace(deps(), owner, {
      action: "pause",
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 1,
    });
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, ledgerId)).toMatchObject({
      phase: "attention_required",
      sessionStatus: "paused",
      openPositions: 1,
      openReservations: 0,
    });
    expect(
      await reserveApprovedTradingPaperSignal(
        db.prisma,
        owner,
        ledgerId,
        { ...proposal, signalId: `after-pause-${suffix}` },
        reserveQuote.id,
        signalAuthority,
        undefined,
        1,
      ),
    ).toMatchObject({ status: "deny", reason: "paper_entry_session_inactive" });
    await controlTradingPaperWorkspace(deps(), owner, {
      action: "protect",
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 2,
      expectedProtectionRevision: 0,
      durationMinutes: 30,
    });
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, ledgerId)).toMatchObject({
      phase: "protection_only",
      protectionRevision: 1,
      sessionRevision: 2,
    });
    const stopQuote = await quote("94", "94.01");
    expect(
      await closeTradingPaperPositionOnStop(
        db.prisma,
        owner,
        ledgerId,
        held.reservationId,
        stopQuote.id,
        { revision: 1, gateRevision: active.workerGateRevision },
      ),
    ).toMatchObject({ status: "closed", mode: "paper_only" });
    await controlTradingPaperWorkspace(deps(), owner, {
      action: "end",
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 2,
    });
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, ledgerId)).toMatchObject({
      phase: "finished",
      sessionStatus: "ended",
      openPositions: 0,
    });
    expect(await auditTradingPaperLifecycle(db.prisma, owner, ledgerId)).toMatchObject({
      fillDecisions: 1,
      closeDecisions: 1,
      openPositions: 0,
    });
    const state = await readVerifiedTradingPaperLedger(db.prisma, owner, ledgerId);
    expect(state.acceptedEvents).toBe(3);
  });
  it("pauses active entries after restart and leaves old Start retries inert", async () => {
    const { ledgerId } = await create();
    const first = {
      action: "start" as const,
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 0,
      venue: "okx" as const,
      symbol: "SOL-USDT",
      durationMinutes: 15,
    };
    await controlTradingPaperWorkspace(deps(), owner, first);
    await reconcileTradingPaperWorkspaces(deps(), true);
    expect(await readVerifiedTradingPaperEntrySession(db.prisma, owner, ledgerId)).toMatchObject({
      status: "paused",
      revision: 2,
    });
    await controlTradingPaperWorkspace(deps(), owner, {
      ...first,
      commandId: randomUUID(),
      expectedRevision: 2,
    });
    enqueue.mockClear();
    await controlTradingPaperWorkspace(deps(), owner, first);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await readVerifiedTradingPaperEntrySession(db.prisma, owner, ledgerId)).toMatchObject({
      status: "active",
      revision: 3,
    });
  });
  it("fences a committed Start when its first queue publication fails", async () => {
    const { ledgerId } = await create();
    const jobs = {
      enqueue: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
    };
    await expect(
      controlTradingPaperWorkspace({ prisma: db.prisma, jobs }, owner, {
        action: "start",
        ledgerId,
        commandId: randomUUID(),
        expectedRevision: 0,
        venue: "okx",
        symbol: "SOL-USDT",
        durationMinutes: 15,
      }),
    ).rejects.toThrow("queue unavailable");
    expect(await readVerifiedTradingPaperEntrySession(db.prisma, owner, ledgerId)).toMatchObject({
      status: "paused",
      revision: 2,
    });
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, ledgerId)).toMatchObject({
      runtimeError: "queue_or_settlement_unavailable",
    });
  });
});
