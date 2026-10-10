import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntime, BackgroundJobPayloads, JobPublisher } from "@rakazo/adapter-kit";
import type { TradingInstrument } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import {
  auditTradingPaperLifecycle,
  closeTradingPaperPositionOnStop,
  createDb,
  createOwnedTradingPaperAccount,
  fillApprovedTradingPaperReservation,
  readOwnedMarketPreparedResearch,
  readOwnedTradingPaperWorkspace,
  readTradingPaperResearchSnapshot,
  readTradingPaperWorkerFillPreflight,
  readTradingPaperWorkerMarketTargetPreflight,
  readTradingPaperWorkerSignalPreflight,
  readVerifiedTradingPaperEntrySession,
  readVerifiedTradingPaperLedger,
  recordIdempotentPublicAdapterPaperQuoteEvidence,
  recordPublicAdapterPaperQuoteEvidence,
  recordTradingPaperResearchSnapshot,
  reserveApprovedTradingPaperSignal,
  tradingPaperMarketScope,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPreparedMarketResearchProvider } from "./paper-worker-market-prepared-provider.js";
import { handlePreparedPaperWorkerResolvedResearch } from "./paper-worker-resolved-research-flow.js";
import {
  controlTradingPaperWorkspace,
  reconcileTradingPaperWorkspaces,
} from "./paper-workspace.js";
import { handleManagedPaperWorkerWake } from "./paper-workspace-market.js";

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

  it("pins the Market-selected Skill, fills only the approved symbol and survives retry and Pause", async () => {
    const ref = "a".repeat(40);
    const source = {
      spaceId: owner.spaceId,
      userId: owner.userId,
      repository: "okx/agent-trade-kit",
      sourceUrl: `https://github.com/okx/agent-trade-kit/blob/${ref}/fixture`,
      sourceRef: ref,
      license: "MIT",
      trust: "curated",
      metrics: {},
      metadata: {},
      preferredVariant: "original",
    };
    const original = buildSkillMd({
      name: "research",
      description: "Read public data.",
      body: "Produce a spot-buy research proposal or NO_TRADE from the public snapshot.",
    });
    const skill = await db.prisma.marketEntry.create({
      data: {
        ...source,
        kind: "skill",
        key: `okx/agent-trade-kit:skills/research/SKILL.md@${ref}`,
        name: "research",
        description: "Read public data.",
        tags: ["trading"],
        sourcePath: "skills/research/SKILL.md",
        originalContent: original,
        digest: createHash("sha256").update(original).digest("hex"),
      },
    });
    const resolver = JSON.stringify({
      semanticKey: "signal.discovery",
      implementations: [
        {
          name: "Public research Skill",
          kind: "api",
          reference: "market:okx/agent-trade-kit:research",
          priority: 1,
          readOnly: true,
          constraints: ["public data only"],
        },
      ],
    });
    await db.prisma.marketEntry.create({
      data: {
        ...source,
        kind: "resolver",
        key: `signal.discovery@${ref}`,
        name: "Signal research",
        description: "Public research",
        tags: ["signal.discovery"],
        sourcePath: "resolver.json",
        originalContent: resolver,
        digest: createHash("sha256").update(resolver).digest("hex"),
      },
    });
    const prepared = await readOwnedMarketPreparedResearch(db.prisma, owner, {
      semanticKey: "signal.discovery",
      limit: 50,
    });
    const scope = tradingPaperMarketScope(prepared, "okx");
    const { ledgerId } = await create();
    const start = {
      action: "start" as const,
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 0,
      venue: "okx" as const,
      symbol: "SOL-USDT",
      durationMinutes: 15,
      researchSource: { kind: "market" as const, scope },
    };
    await controlTradingPaperWorkspace(deps(), owner, start);
    const session = await readVerifiedTradingPaperEntrySession(db.prisma, owner, ledgerId);
    if (session.status !== "active") throw new Error("Start failed");
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
    const now = new Date();
    const provider = createPreparedMarketResearchProvider(
      async () => prepared,
      async () => ({
        kind: "proposal",
        executionStatus: "research_only",
        signalId: `market-test:${suffix}`,
        strategyId: scope.strategyId,
        strategyVersion: scope.strategyVersion,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 120000).toISOString(),
        evidenceIds: ["public-test"],
        market,
        action: "spot_buy",
        entryTrigger: "100.1",
        stopLoss: "95",
        takeProfit: ["110"],
        invalidation: "support lost",
        rationale: "public fixture",
        riskBudgetQuote: null,
        maxSlippageBps: null,
      }),
    );
    const payload = {
      ...owner,
      ledgerId,
      gateRevision: session.workerGateRevision,
      sessionRevision: session.revision,
      scheduledFor: session.startedAt,
    };
    const key = { ledgerId, sessionRevision: session.revision, scheduledFor: session.startedAt };
    const envelope = await recordTradingPaperResearchSnapshot(
      db.prisma,
      owner,
      key,
      await provider(payload, now),
    );
    expect(await readTradingPaperResearchSnapshot(db.prisma, owner, key)).toEqual(envelope);
    expect(
      await recordTradingPaperResearchSnapshot(db.prisma, owner, key, {
        ...envelope,
        signal: { ...envelope.signal, signalId: "different-retry" },
      }),
    ).toEqual(envelope);
    const capture = async (
      prisma: typeof db.prisma,
      quoteOwner: typeof owner,
      id: string,
      quoteMarket: TradingInstrument,
      evidenceId: string,
    ) => {
      const at = new Date().toISOString();
      return recordIdempotentPublicAdapterPaperQuoteEvidence(
        prisma,
        quoteOwner,
        id,
        evidenceId,
        quoteMarket,
        {
          venue: "okx",
          kind: "spot",
          symbol: quoteMarket.symbol,
          bid: "99.99",
          ask: "100",
          observedAt: at,
          fetchedAt: at,
          quoteVolume24h: "100000",
        },
      );
    };
    const foreignMarket = {
      ...envelope,
      signal: {
        ...envelope.signal,
        signalId: `wrong-market:${suffix}`,
        market: { ...market, symbol: "ETH-USDT", base: "ETH" },
      },
    };
    expect(
      await handlePreparedPaperWorkerResolvedResearch(
        db.prisma,
        payload,
        async () => foreignMarket,
        capture,
        now,
      ),
    ).toMatchObject({ status: "stop", stage: "reserve" });
    expect((await readVerifiedTradingPaperLedger(db.prisma, owner, ledgerId)).acceptedEvents).toBe(
      0,
    );
    const outcome = await handlePreparedPaperWorkerResolvedResearch(
      db.prisma,
      payload,
      async () => envelope,
      capture,
      now,
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "filled",
      fill: { status: "filled", mode: "paper_only" },
    });
    expect(
      await handlePreparedPaperWorkerResolvedResearch(
        db.prisma,
        payload,
        async () => envelope,
        capture,
        now,
      ),
    ).toMatchObject({ status: "filled", fill: { status: "duplicate" } });
    expect(await auditTradingPaperLifecycle(db.prisma, owner, ledgerId)).toMatchObject({
      fillDecisions: 1,
      openPositions: 1,
    });
    await controlTradingPaperWorkspace(deps(), owner, {
      action: "pause",
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: 1,
    });
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, ledgerId)).toMatchObject({
      sessionStatus: "paused",
      openPositions: 1,
    });
    const another = await create();
    await db.prisma.marketEntry.update({
      where: { id: skill.id },
      data: {
        adaptedContent: `${skill.originalContent}\nDifferent variant.`,
        adaptationMode: "wrapped",
        preferredVariant: "wrapped",
      },
    });
    await expect(
      controlTradingPaperWorkspace(deps(), owner, {
        ...start,
        ledgerId: another.ledgerId,
        commandId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await readOwnedTradingPaperWorkspace(db.prisma, owner, another.ledgerId)).toMatchObject({
      sessionRevision: 0,
      policy: { enabled: false },
    });
    const currentPrepared = await readOwnedMarketPreparedResearch(db.prisma, owner, {
      semanticKey: "signal.discovery",
      limit: 50,
    });
    const currentScope = tradingPaperMarketScope(currentPrepared, "okx");
    const managed = await create();
    await controlTradingPaperWorkspace(deps(), owner, {
      ...start,
      ledgerId: managed.ledgerId,
      commandId: randomUUID(),
      researchSource: { kind: "market", scope: currentScope },
    });
    const managedSession = await readVerifiedTradingPaperEntrySession(
      db.prisma,
      owner,
      managed.ledgerId,
    );
    if (managedSession.status !== "active") throw new Error("managed session missing");
    const requests: unknown[] = [];
    const runtime = {
      async *run(request: Parameters<AgentRuntime["run"]>[0]) {
        requests.push(request);
        yield {
          type: "text",
          text: JSON.stringify({
            kind: "proposal",
            entryTrigger: "100",
            stopLoss: "95",
            takeProfit: ["110"],
            invalidation: "support",
            rationale: "public fixture",
          }),
        };
      },
    } as unknown as AgentRuntime;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, options: RequestInit) => {
        const endpoint = new URL(String(url));
        expect(endpoint.origin).toBe("https://www.okx.com");
        expect(options.method).toBe("GET");
        expect(JSON.stringify(options.headers)).not.toMatch(
          /authorization|secret|signature|api.?key/i,
        );
        const data = endpoint.pathname.endsWith("/instruments")
          ? endpoint.searchParams.get("instType") === "SPOT"
            ? [
                {
                  instType: "SPOT",
                  instId: "SOL-USDT",
                  state: "live",
                  ruleType: "normal",
                  baseCcy: "SOL",
                  quoteCcy: "USDT",
                  tickSz: "0.01",
                  lotSz: "0.001",
                  minSz: "0.01",
                  expTime: "",
                },
              ]
            : []
          : endpoint.pathname.endsWith("/tickers")
            ? [
                {
                  instType: "SPOT",
                  instId: "SOL-USDT",
                  bidPx: "99.99",
                  askPx: "100",
                  volCcy24h: "100000",
                  vol24h: "1000",
                  ts: String(Date.now()),
                },
              ]
            : endpoint.pathname.endsWith("/history-candles")
              ? [
                  [
                    String(Math.floor(Date.now() / 3600000) * 3600000 - 3600000),
                    "99",
                    "101",
                    "95",
                    "100",
                    "6",
                    "120",
                    "50000",
                    "1",
                  ],
                ]
              : null;
        if (!data) throw new Error("Unexpected public fixture endpoint");
        return Response.json({ code: "0", data });
      }),
    );
    try {
      const wake = {
        ...owner,
        ledgerId: managed.ledgerId,
        gateRevision: managedSession.workerGateRevision,
        sessionRevision: managedSession.revision,
        scheduledFor: managedSession.startedAt,
      };
      const workerDeps = { ...deps(), runtime, resolveModel: async () => ({}) as never };
      expect(await handleManagedPaperWorkerWake(workerDeps, wake)).toMatchObject({
        status: "resolved",
        resolvedResearch: { status: "filled" },
      });
      expect(await handleManagedPaperWorkerWake(workerDeps, wake)).toMatchObject({
        status: "resolved",
        resolvedResearch: { status: "filled", fill: { status: "duplicate" } },
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain("Different variant.");
      expect(await auditTradingPaperLifecycle(db.prisma, owner, managed.ledgerId)).toMatchObject({
        fillDecisions: 1,
        openPositions: 1,
      });
      const failure = await create();
      await controlTradingPaperWorkspace(deps(), owner, {
        ...start,
        ledgerId: failure.ledgerId,
        commandId: randomUUID(),
        researchSource: { kind: "market", scope: currentScope },
      });
      const failureSession = await readVerifiedTradingPaperEntrySession(
        db.prisma,
        owner,
        failure.ledgerId,
      );
      if (failureSession.status !== "active") throw new Error("failure session missing");
      await expect(
        handleManagedPaperWorkerWake(
          {
            ...workerDeps,
            resolveModel: async () => {
              throw new Error("fixture model unavailable");
            },
          },
          {
            ...wake,
            ledgerId: failure.ledgerId,
            gateRevision: failureSession.workerGateRevision,
            sessionRevision: failureSession.revision,
            scheduledFor: failureSession.startedAt,
          },
        ),
      ).rejects.toThrow("model unavailable");
      expect(
        await readOwnedTradingPaperWorkspace(db.prisma, owner, failure.ledgerId),
      ).toMatchObject({
        sessionStatus: "paused",
        phase: "attention_required",
        openPositions: 0,
        runtimeError: "market_research_unavailable",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
