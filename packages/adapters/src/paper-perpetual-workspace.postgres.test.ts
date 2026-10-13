import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntime,
  BackgroundJobPayloads,
  JobPublisher,
  PaperPerpetualEngine,
} from "@rakazo/adapter-kit";
import type {
  PaperPerpetualCommand,
  PaperPerpetualDecision,
  PaperPerpetualSnapshot,
} from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import {
  commitPerpetualPaperWake,
  createDb,
  createOwnedPerpetualExperimentAccounts,
  parsePerpetualControl,
  perpetualMarketSource,
  perpetualPaperHash,
  perpetualPaperJson,
  readOwnedMarketPreparedResearch,
  readOwnedPerpetualPaperJournal,
  readOwnedPerpetualWorkspace,
  recordPerpetualResearchTick,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NautilusPaperEngine } from "./nautilus-paper-engine.js";
import {
  controlPerpetualPaperWorkspace,
  handlePerpetualPaperWake,
  reconcilePerpetualPaperWorkspaces,
} from "./paper-perpetual-workspace.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("owner-controlled PAPER futures execution against PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let owner: { spaceId: string; userId: string };
  let orgId: string;
  const owners: Array<{ orgId: string; userId: string }> = [];
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const deps = () => ({ prisma: db.prisma, jobs: { enqueue } as Pick<JobPublisher, "enqueue"> });
  let decision: PaperPerpetualDecision;
  let fundingNextAtOverride: string | null = null;
  let modelFails = false;
  let tierMaximumBase = "100";
  let observationShiftMs = 0;
  let price = "100",
    depth = "100",
    funding: PaperPerpetualSnapshot["funding"] = [];
  const calls: unknown[] = [];
  const runtime = {
    async *run(request: Parameters<AgentRuntime["run"]>[0]) {
      calls.push(request);
      if (modelFails) throw new Error("fixture model quota exceeded");
      yield { type: "text", text: JSON.stringify(decision) };
    },
  } as unknown as AgentRuntime;
  const snapshot = async (instrument: string): Promise<PaperPerpetualSnapshot> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = new Date(Date.now() + observationShiftMs),
      at = now.toISOString();
    return {
      market: {
        venue: "okx",
        kind: "perpetual",
        symbol: instrument,
        base: instrument.slice(0, -10),
        quote: "USDT",
        status: "active",
        priceIncrement: "0.01",
        quantityIncrement: "0.01",
        minNotional: null,
        expiryAt: null,
      },
      fetchedAt: at,
      leverageLimits: {
        venue: "okx",
        instrument,
        marginMode: "cross",
        sourceId: "public-tier-fixture",
        observedAt: at,
        tiers:
          tierMaximumBase === "100"
            ? [{ id: "1", minQuantityBase: "0", maxQuantityBase: "100", maxLeverage: 20 }]
            : [
                {
                  id: "1",
                  minQuantityBase: "0",
                  maxQuantityBase: tierMaximumBase,
                  maxLeverage: 20,
                },
                {
                  id: "2",
                  minQuantityBase: tierMaximumBase,
                  maxQuantityBase: "100",
                  maxLeverage: 20,
                },
              ],
      },
      book: {
        venue: "okx",
        instrument,
        sourceId: "public-test:" + at,
        observedAt: at,
        bidQuote: price,
        askQuote: price,
        bidAvailableBase: depth,
        askAvailableBase: depth,
      },
      rules: {
        basePerContract: "0.1",
        lotIncrementBase: "0.01",
        minimumBase: "0.01",
        maxTierBase: tierMaximumBase,
        maintenanceMarginBps: 50,
        maxLeverage: 20,
      },
      markPriceQuote: price,
      markObservedAt: at,
      fundingNextAt: fundingNextAtOverride ?? new Date(now.getTime() + 8 * 3600000).toISOString(),
      funding,
      history: [
        {
          venue: "okx",
          kind: "perpetual",
          symbol: instrument,
          openedAt: new Date(Math.floor(now.getTime() / 3600000) * 3600000 - 3600000).toISOString(),
          durationMs: 3600000,
          open: "99",
          high: "101",
          low: "98",
          close: "100",
          quoteVolume: "100000",
          confirmed: true,
        },
      ],
    };
  };
  const worker = () => ({
    ...deps(),
    runtime,
    resolveModel: async () => ({ provider: "fixture", id: "fixture-model" }),
    fetchSnapshot: snapshot,
  });
  const proposal = (
    side: "long" | "short",
    instrument = "BTC-USDT-SWAP",
  ): Extract<PaperPerpetualDecision, { kind: "proposal" }> => ({
    kind: "proposal",
    instrument,
    side,
    leverage: 2,
    quantityBase: "1",
    orderType: "market",
    limitPriceQuote: null,
    stopPriceQuote: side === "long" ? "97" : "103",
    takeProfitPriceQuote: side === "long" ? "110" : "90",
    rationale: "Independent public fixture strategy",
  });
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
  });
  beforeEach(async () => {
    enqueue.mockClear();
    calls.length = 0;
    modelFails = false;
    tierMaximumBase = "100";
    observationShiftMs = 0;
    price = "100";
    depth = "100";
    funding = [];
    fundingNextAtOverride = null;
    decision = proposal("long");
    const suffix = randomUUID();
    orgId = "futures-org-" + suffix;
    owner = { userId: "futures-user-" + suffix, spaceId: "futures-space-" + suffix };
    owners.push({ orgId, userId: owner.userId });
    const createdAt = new Date();
    await db.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Futures fixture",
        email: owner.userId + "@rakazo.test",
        emailVerified: false,
      },
    });
    await db.prisma.organization.create({
      data: { id: orgId, name: "Futures fixture", slug: orgId, createdAt },
    });
    await db.prisma.member.create({
      data: {
        id: "member-" + suffix,
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
        name: "Futures fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: "space-member-" + suffix,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
    });
    const ref = "a".repeat(40);
    const source = {
      ...owner,
      repository: "okx/agent-trade-kit",
      sourceUrl: "https://github.com/okx/agent-trade-kit/blob/" + ref + "/fixture",
      sourceRef: ref,
      license: "MIT",
      trust: "curated",
      metrics: {},
      metadata: {},
      preferredVariant: "original",
    };
    const original = buildSkillMd({
      name: "perpetual-research",
      description: "Public futures research",
      body: "Use only the supplied public market snapshot to propose a virtual long, short, close, or no_trade.",
    });
    await db.prisma.marketEntry.create({
      data: {
        ...source,
        kind: "skill",
        key: "okx/agent-trade-kit:skills/perpetual-research/SKILL.md@" + ref,
        name: "perpetual-research",
        description: "Read-only",
        tags: ["trading"],
        sourcePath: "skills/perpetual-research/SKILL.md",
        originalContent: original,
        digest: createHash("sha256").update(original).digest("hex"),
      },
    });
    const resolver = JSON.stringify({
      semanticKey: "futures.data",
      implementations: [
        {
          name: "Public OKX futures Skill",
          kind: "api",
          reference: "market:okx/agent-trade-kit:perpetual-research",
          priority: 1,
          readOnly: true,
          constraints: ["Public data only"],
        },
      ],
    });
    await db.prisma.marketEntry.create({
      data: {
        ...source,
        kind: "resolver",
        key: "futures.data@" + ref,
        name: "Futures data",
        description: "Public futures",
        tags: ["futures.data"],
        sourcePath: "resolver.json",
        originalContent: resolver,
        digest: createHash("sha256").update(resolver).digest("hex"),
      },
    });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      for (const row of owners) {
        await db.prisma.organization.deleteMany({ where: { id: row.orgId } });
        await db.prisma.user.deleteMany({ where: { id: row.userId } });
      }
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function account(strategy: "conservative" | "moderate" | "aggressive" = "moderate") {
    const accounts = await createOwnedPerpetualExperimentAccounts(db.prisma, owner);
    return accounts.accounts.find((a) => a.strategy === strategy)!.ledgerId;
  }
  async function start(
    ledgerId: string,
    engine?: PaperPerpetualEngine,
    instruments = ["BTC-USDT-SWAP", "SOL-USDT-SWAP"],
  ) {
    const prepared = await readOwnedMarketPreparedResearch(db.prisma, owner, {
      semanticKey: "futures.data",
      limit: 50,
    });
    const status = await readOwnedPerpetualWorkspace(db.prisma, owner, ledgerId);
    const command = {
      action: "start" as const,
      ledgerId,
      commandId: randomUUID(),
      expectedRevision: status!.revision,
      venue: "okx" as const,
      instruments,
      durationMinutes: 15,
      protectionMinutes: 1440,
      source: perpetualMarketSource(prepared),
    };
    await controlPerpetualPaperWorkspace({ ...deps(), engine }, owner, command);
    return command;
  }
  async function state(ledgerId: string) {
    const result = await readOwnedPerpetualPaperJournal(db.prisma, owner, ledgerId);
    if (result?.status !== "verified") throw new Error("Unverified fixture ledger");
    return result.state;
  }
  async function payload(
    ledgerId: string,
    researchDue = false,
  ): Promise<BackgroundJobPayloads["paper.worker-preflight"]> {
    const row = await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
      where: { ledgerId },
    });
    const control = parsePerpetualControl(row);
    if (researchDue) control.lastResearchAt = null;
    const [clockRow] = await db.prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const now = clockRow!.now;
    await db.prisma.tradingPaperPerpetualWorkspace.update({
      where: { ledgerId },
      data: {
        nextScheduledFor: now,
        control: perpetualPaperJson(control),
        controlSha256: perpetualPaperHash(control),
      },
    });
    return {
      ...owner,
      ledgerId,
      gateRevision: row.revision,
      sessionRevision: row.revision,
      marketKind: "perpetual",
      scheduledFor: now.toISOString(),
    };
  }

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "reuses protection-only observations but captures fresh quotes for pending and new entries",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["moderate"]))
          .accounts[0]!.ledgerId;
        await start(id, engine, ["BTC-USDT-SWAP"]);
        const fetchSnapshot = vi.fn(snapshot);
        const run = { ...worker(), engine, fetchSnapshot };
        decision = { kind: "no_trade", reason: "No supported entry" };
        await handlePerpetualPaperWake(run, await payload(id, true));
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);

        // The already-protected non-research wake must not issue a redundant
        // second public request which could spuriously pause a healthy account.
        fetchSnapshot.mockReset();
        fetchSnapshot
          .mockImplementationOnce(snapshot)
          .mockRejectedValue(new Error("Redundant public request unavailable"));
        await handlePerpetualPaperWake(run, await payload(id));
        expect(fetchSnapshot).toHaveBeenCalledTimes(1);
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          sessionStatus: "active",
          runtimeError: null,
        });

        fetchSnapshot.mockReset();
        fetchSnapshot.mockImplementation(snapshot);
        decision = { ...proposal("long"), orderType: "limit", limitPriceQuote: "99" };
        await handlePerpetualPaperWake(run, await payload(id, true));
        expect(fetchSnapshot).toHaveBeenCalledTimes(3);
        expect((await state(id)).openPositions).toHaveLength(0);

        fetchSnapshot.mockClear();
        price = "98";
        await handlePerpetualPaperWake(run, await payload(id));
        expect(fetchSnapshot).toHaveBeenCalledTimes(2);
        expect((await state(id)).openPositions).toHaveLength(1);
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "accepts bounded clock skew in native observations and pauses on excessive skew",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        observationShiftMs = 1500;
        decision = { ...proposal("long"), leverage: 20 };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(1);
        observationShiftMs = 6000;
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(1);
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          sessionStatus: "paused",
        });
      } finally {
        await engine.dispose();
      }
    },
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "runs the production futures worker through native long/short, pause, replay and protective exits",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20, quantityBase: "1.00" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        expect(journal?.status).toBe("verified");
        expect(
          await readOwnedPerpetualWorkspace(db.prisma, owner, id),
          JSON.stringify(journal),
        ).toMatchObject({ runtimeError: null, lastDecision: { outcome: "filled" } });
        expect((await state(id)).openPositions).toHaveLength(1);
        expect((await state(id)).openPositions[0]!.leverage).toBe(20);
        const modelContext = JSON.parse(
          (calls[0] as Parameters<AgentRuntime["run"]>[0]).prompt,
        ).publicMarketData;
        expect(modelContext).toMatchObject({
          executionFees: expect.arrayContaining([
            { instrument: "BTC-USDT-SWAP", makerFeeRate: "0.0002", takerFeeRate: "0.0005" },
          ]),
          slippageReserveBpsPerSide: 10,
        });
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          executionFees: expect.arrayContaining([
            { instrument: "BTC-USDT-SWAP", makerFeeRate: "0.0002", takerFeeRate: "0.0005" },
          ]),
        });
        expect((await state(id)).engine).toEqual({ id: "nautilus", version: "1.231.0" });
        expect(
          journal?.status === "verified" && journal.events.every((e) => e.kind === "engine"),
        ).toBe(true);
        expect(await db.prisma.tradingPaperPerpetualEvent.count({ where: { ledgerId: id } })).toBe(
          0,
        );
        decision = { ...proposal("short"), leverage: 20, quantityBase: "1.00" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect(
          (await state(id)).openPositions.map((p) => p.side).sort(),
          JSON.stringify({
            workspace: await readOwnedPerpetualWorkspace(db.prisma, owner, id),
            journal: await readOwnedPerpetualPaperJournal(db.prisma, owner, id),
          }),
        ).toEqual(["long", "short"]);
        expect((await state(id)).bookBalanceQuote).toBe("999.90000000");
        engine.invalidate(id);
        await reconcilePerpetualPaperWorkspaces({ ...deps(), engine }, true);
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          sessionStatus: "paused",
        });
        price = "96.00";
        modelFails = true;
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const remaining = (await state(id)).openPositions;
        expect(remaining).toHaveLength(1);
        expect(remaining[0]!.side).toBe("short");
        const status = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
        await controlPerpetualPaperWorkspace({ ...deps(), engine }, owner, {
          ledgerId: id,
          commandId: randomUUID(),
          expectedRevision: status!.revision,
          action: "close_all",
        });
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        expect((await state(id)).openPositions).toHaveLength(0);
        expect((await state(id)).bookBalanceQuote).toBe("999.80400000");
        modelFails = false;
        price = "100.00";
        await start(id, engine, ["ETH-USDT-SWAP"]);
        decision = { ...proposal("long", "ETH-USDT-SWAP"), leverage: 20, quantityBase: "1" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions[0]!.instrument).toBe("ETH-USDT-SWAP");
        expect((await state(id)).bookBalanceQuote).toBe("999.75400000");
        engine.invalidate(id);
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        expect((await state(id)).bookBalanceQuote).toBe("999.75400000");
      } finally {
        engine.dispose();
      }
    },
    120000,
  );
  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "final prelaunch smoke: starts all three isolated 1000-USDT accounts, journals native fills, pauses and safely exits after replay",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const profiles = [
          { strategy: "conservative", ceiling: 5, instrument: "BTC-USDT-SWAP" },
          { strategy: "moderate", ceiling: 10, instrument: "SOL-USDT-SWAP" },
          { strategy: "aggressive", ceiling: 20, instrument: "ETH-USDT-SWAP" },
        ] as const;
        const accounts = (
          await createOwnedPerpetualExperimentAccounts(
            db.prisma,
            owner,
            profiles.map((p) => p.strategy),
          )
        ).accounts;
        expect(accounts).toHaveLength(3);
        const ids = profiles.map((p) => accounts.find((a) => a.strategy === p.strategy)!.ledgerId);
        expect(new Set(ids).size).toBe(3);

        // A real owner Start is mandatory even in this isolated test.
        for (const [idx, profile] of profiles.entries()) {
          const id = ids[idx]!;
          const before = await state(id);
          expect(before.initialBalanceQuote).toBe("1000");
          expect(before.openPositions).toHaveLength(0);
          const unstarted = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
          expect(unstarted).toMatchObject({ sessionStatus: "idle" });
          await start(id, engine, [profile.instrument]);
          decision = {
            ...proposal("long", profile.instrument),
            leverage: profile.ceiling,
            quantityBase: "1.00",
            recoverySteps: [
              { stepId: "r1", triggerPriceQuote: "98.5", allocationPercent: 60 },
              { stepId: "r2", triggerPriceQuote: "97.5", allocationPercent: 40 },
            ],
            // Both stages strictly above hard stop of 97 and below entry of 100.
          };
          await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
          const journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
          expect(journal?.status, profile.strategy).toBe("verified");
          if (journal?.status !== "verified") throw new Error("Unverified account journal");
          expect(journal?.state.openPositions, profile.strategy).toHaveLength(1);
          expect(journal?.state.openPositions[0]).toMatchObject({
            instrument: profile.instrument,
            leverage: profile.ceiling,
          });
          expect(Number(journal?.state.bookBalanceQuote)).toBeGreaterThan(990);
          const ws = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
          expect(ws).toMatchObject({
            sessionStatus: "active",
            runtimeError: null,
            lastDecision: { outcome: "filled" },
          });
          expect(ws?.recoveryReservations?.[0]?.stages).toHaveLength(2);
          expect(ws?.recoveryReservations?.[0]?.stages?.[0]?.activatedAt).toBeNull();
        }

        // No shared wallet or unintended cross-ledger entries.
        for (const id of ids) {
          const journal = await state(id);
          expect(journal.openPositions).toHaveLength(1);
          expect(journal.openPositions[0]!.positionId).toBeTruthy();
          expect(Number(journal.bookBalanceQuote)).toBeGreaterThan(990);
        }

        // Crash/restart forces safe pause, retaining the positions and hash journals.
        for (const id of ids) engine.invalidate(id);
        await reconcilePerpetualPaperWorkspaces({ ...deps(), engine }, true);
        for (const id of ids) {
          expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
            sessionStatus: "paused",
          });
          const journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
          expect(journal?.status).toBe("verified");
          if (journal?.status !== "verified") throw new Error("Unverified replay journal");
          expect(journal?.state.openPositions).toHaveLength(1);
        }

        // Owner-driven drain; never let research generate a new entry while stopping.
        modelFails = true;
        for (const id of ids) {
          const status = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
          await controlPerpetualPaperWorkspace({ ...deps(), engine }, owner, {
            ledgerId: id,
            commandId: randomUUID(),
            expectedRevision: status!.revision,
            action: "close_all",
          });
          await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
          const journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
          expect(journal?.status).toBe("verified");
          if (journal?.status !== "verified") throw new Error("Unverified replay journal");
          expect(journal?.state.openPositions).toHaveLength(0);
          expect(journal?.state.liquidations).toBe(0);
          expect(Number(journal?.state.bookBalanceQuote)).toBeGreaterThan(990);
        }
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "scales into a verified lot and rotates a fully closed lot into an opposite-side hedge",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20 };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        let positions = (await state(id)).openPositions;
        expect(positions).toHaveLength(1);
        const originalId = positions[0]!.positionId;

        decision = {
          ...proposal("long"),
          leverage: 20,
          quantityBase: "0.50",
          addToPositionId: originalId,
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        positions = (await state(id)).openPositions;
        expect(positions).toHaveLength(1);
        expect(positions[0]!.positionId).toBe(originalId);
        expect(Number(positions[0]!.quantityBase)).toBe(1.5);

        // The native worker must reject a scale-in that tries to change old protective exits.
        decision = {
          ...proposal("long"),
          leverage: 20,
          quantityBase: "0.50",
          addToPositionId: originalId,
          stopPriceQuote: "94",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect(Number((await state(id)).openPositions[0]!.quantityBase)).toBe(1.5);
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          lastDecision: { outcome: "denied_add_plan_mismatch" },
        });

        decision = {
          ...proposal("short"),
          leverage: 20,
          replacePositionId: originalId,
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        positions = (await state(id)).openPositions;
        expect(positions).toHaveLength(1);
        expect(positions[0]!.side).toBe("short");
        expect(positions[0]!.positionId).not.toBe(originalId);
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "permits a hedge rotation at four occupied slots only after a real full exit",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        for (const [instrument, side] of [
          ["BTC-USDT-SWAP", "long"],
          ["BTC-USDT-SWAP", "short"],
          ["SOL-USDT-SWAP", "long"],
          ["SOL-USDT-SWAP", "short"],
        ] as const) {
          decision = { ...proposal(side, instrument), leverage: 20, quantityBase: "0.50" };
          await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        }
        const before = (await state(id)).openPositions;
        expect(before).toHaveLength(4);
        const replacedPositionId = before.find((pos) => pos.side === "long")!.positionId;
        decision = {
          ...proposal("short", "SOL-USDT-SWAP"),
          leverage: 20,
          quantityBase: "0.50",
          replacePositionId: replacedPositionId,
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const after = (await state(id)).openPositions;
        expect(after).toHaveLength(4);
        expect(after.some((pos) => pos.positionId === replacedPositionId)).toBe(false);
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "tightens a protective stop without widening risk and replays the updated plan",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20 };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const positionId = (await state(id)).openPositions[0]!.positionId;
        const control = async () =>
          parsePerpetualControl(
            await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
              where: { ledgerId: id },
            }),
          );
        const initialRisk = (await control()).plans[0]!.stopRiskQuote;
        decision = {
          kind: "tighten_stop",
          positionId,
          stopPriceQuote: "96.00",
          reason: "Do not increase risk by widening the original stop",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await control()).plans[0]!.stopPriceQuote).toBe("97");
        expect((await control()).lastDecision?.outcome).toBe("denied_stop_not_tighter");

        decision = {
          kind: "tighten_stop",
          positionId,
          stopPriceQuote: "98.00",
          reason: "Tighten protection after confirmation",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const updated = await control();
        expect(updated.plans[0]!.stopPriceQuote).toBe("98.00");
        expect(updated.plans[0]!.stopRiskQuote).toBe(initialRisk);
        expect(updated.lastDecision?.outcome).toBe("protective_stop_tightened");

        engine.invalidate(id);
        price = "97.50";
        modelFails = true; // Protection must commit even if research fails after replay.
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(0);
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "gapped stop with thin then zero liquidity persists residual without reversing or phantom fills",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20, quantityBase: "1.00" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(1);
        const original = (await state(id)).openPositions[0]!.positionId;

        // A sharp 10% price gap skips the chosen stop: fill ONLY displayed depth.
        price = "90";
        depth = "0.25";
        modelFails = true;
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        let after = await state(id);
        expect(after.openPositions).toHaveLength(1);
        expect(after.openPositions[0]!.positionId).toBe(original);
        expect(Number(after.openPositions[0]!.quantityBase)).toBe(0.75);
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          sessionStatus: "paused",
          runtimeError: "model_unavailable",
        });

        // Zero exit liquidity must NOT fabricate a stop fill or reverse into a short.
        depth = "0";
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        after = await state(id);
        expect(after.openPositions).toHaveLength(1);
        expect(Number(after.openPositions[0]!.quantityBase)).toBe(0.75);
        expect(after.openPositions[0]!.side).toBe("long");

        // On later public depth, the independently protected remainder exits.
        engine.invalidate(id);
        depth = "100";
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        after = await state(id);
        expect(after.openPositions).toHaveLength(0);
        expect(after.closedPositions).toBe(1);
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "reports an underwater position as recovered ONLY after net-positive native close",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20, quantityBase: "1.00" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(1);

        price = "98";
        decision = { kind: "no_trade", reason: "Observe a losing position without buying the dip" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const underwater = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        expect(underwater?.status).toBe("verified");
        if (underwater?.status !== "verified") return;
        expect(underwater.recovery).toMatchObject({
          status: "verified",
          scope: "position_only",
          completedUnderwater: 0,
          openUnderwater: 1,
          recovered: 0,
          recoveryRatePercent: null,
        });

        // Exits are the independent protective cycle, not an AI-generated profit claim.
        price = "110";
        modelFails = true;
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(0);
        const settled = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        expect(settled?.status).toBe("verified");
        if (settled?.status !== "verified") return;
        expect(settled.recovery).toMatchObject({
          status: "verified",
          scope: "position_only",
          completedUnderwater: 1,
          recovered: 1,
          recoveryRatePercent: "100.00",
          openUnderwater: 0,
        });
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "charges short marketable-limit scale-ins against the actual native fill price",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["moderate"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("short"), leverage: 10, quantityBase: "1.00" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const initial = await state(id);
        expect(initial.openPositions).toHaveLength(1);
        const positionId = initial.openPositions[0]!.positionId;
        const plan = async () =>
          parsePerpetualControl(
            await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
              where: { ledgerId: id },
            }),
          ).plans.find((p) => p.positionId === positionId)!;
        expect(Number((await plan()).recoveryReserveQuote)).toBe(50);

        // Sell limit 95 crosses the public bid 100. The native exchange
        // simulation fills at 100; consuming only 95 would leave phantom capacity.
        decision = {
          ...proposal("short"),
          leverage: 10,
          quantityBase: "0.50",
          orderType: "limit",
          limitPriceQuote: "95.00",
          addToPositionId: positionId,
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect(Number((await state(id)).openPositions[0]!.quantityBase)).toBe(1.5);
        expect(Number((await plan()).recoveryReserveQuote)).toBe(0);
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "books a recovery reserve on initial fill, prevents over-addition and consumes on approved scale-in",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["moderate"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 10, quantityBase: "1.00" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const initial = await state(id);
        expect(initial.openPositions).toHaveLength(1);
        const positionId = initial.openPositions[0]!.positionId;
        const readPlan = async () =>
          parsePerpetualControl(
            await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
              where: { ledgerId: id },
            }),
          );
        const firstPlan = (await readPlan()).plans.find((x) => x.positionId === positionId)!;
        expect(Number(firstPlan.recoveryReserveQuote)).toBeGreaterThanOrEqual(50);
        expect(Number(firstPlan.recoveryReservedRiskQuote)).toBeGreaterThan(0);
        const workspace = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
        expect(workspace?.recoveryReservations?.[0]?.reservedNotionalQuote).toBe(
          firstPlan.recoveryReserveQuote,
        );

        // Model cannot consume more scale-in notional than planned for this position.
        decision = {
          ...proposal("long"),
          leverage: 10,
          quantityBase: "0.75",
          addToPositionId: positionId,
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await readPlan()).lastDecision?.outcome).toBe("denied_add_unreserved");
        expect(Number((await state(id)).openPositions[0]!.quantityBase)).toBe(1);

        decision = {
          ...proposal("long"),
          leverage: 10,
          quantityBase: "0.50",
          addToPositionId: positionId,
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect(Number((await state(id)).openPositions[0]!.quantityBase)).toBe(1.5);
        const later = (await readPlan()).plans.find((x) => x.positionId === positionId)!;
        expect(Number(later.recoveryReserveQuote)).toBeLessThan(
          Number(firstPlan.recoveryReserveQuote),
        );
        expect(Number(later.recoveryReservedRiskQuote)).toBeLessThan(
          Number(firstPlan.recoveryReservedRiskQuote),
        );
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "persists two price-triggered recovery stages and rejects unconfirmed knife-catching",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["moderate"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = {
          ...proposal("long"),
          leverage: 10,
          quantityBase: "1.00",
          stopPriceQuote: "96",
          recoverySteps: [
            { stepId: "first-retest", triggerPriceQuote: "98.5", allocationPercent: 60 },
            { stepId: "second-retest", triggerPriceQuote: "97", allocationPercent: 40 },
          ],
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const held = (await state(id)).openPositions;
        expect(held).toHaveLength(1);
        const positionId = held[0]!.positionId;
        const currentControl = async () =>
          parsePerpetualControl(
            await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
              where: { ledgerId: id },
            }),
          );
        const original = (await currentControl()).plans.find((x) => x.positionId === positionId)!;
        expect(original.recoverySteps).toHaveLength(2);
        expect(original.recoverySteps[0]!.activatedAt).toBeNull();
        expect(original.recoverySteps[1]!.activatedAt).toBeNull();
        expect(Number(original.recoverySteps[0]!.remainingNotionalQuote)).toBeGreaterThan(0);

        // The first level is visited after entry, but a price drop is not
        // automatically a buy signal; the second level has NOT been visited.
        price = "98";
        decision = { kind: "no_trade", reason: "Do not buy into an unconfirmed decline" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        const triggered = (await currentControl()).plans.find((x) => x.positionId === positionId)!;
        expect(triggered.recoverySteps[0]!.activatedAt).not.toBeNull();
        expect(triggered.recoverySteps[1]!.activatedAt).toBeNull();

        decision = {
          ...proposal("long"),
          leverage: 10,
          stopPriceQuote: "96",
          quantityBase: "0.10",
          addToPositionId: positionId,
          recoveryStepId: "second-retest",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await currentControl()).lastDecision?.outcome).toBe(
          "denied_recovery_step_not_triggered",
        );

        decision = {
          ...proposal("long"),
          leverage: 10,
          stopPriceQuote: "96",
          quantityBase: "0.10",
          addToPositionId: positionId,
          recoveryStepId: "first-retest",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await currentControl()).lastDecision?.outcome).toBe(
          "denied_recovery_step_no_reversal",
        );
        expect(Number((await state(id)).openPositions[0]!.quantityBase)).toBe(1);
        expect((await readOwnedPerpetualPaperJournal(db.prisma, owner, id))?.status).toBe(
          "verified",
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "cancels native GTC entries on an owner leverage change before a crossed quote",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = {
          ...proposal("long"),
          leverage: 20,
          quantityBase: "1.00",
          orderType: "limit",
          limitPriceQuote: "99.00",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        let journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        expect(
          journal?.status === "verified" &&
            journal.events[0]?.kind === "engine" &&
            journal.events[0].output.openOrders,
        ).toHaveLength(1);
        const old = await payload(id),
          status = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
        const leverageCommand: PaperPerpetualCommand = {
          ledgerId: id,
          commandId: randomUUID(),
          expectedRevision: status!.revision,
          action: "set_leverage",
          venue: "okx",
          instruments: ["BTC-USDT-SWAP"],
          maxLeverage: 5,
        };
        await controlPerpetualPaperWorkspace(
          { ...deps(), engine, fetchSnapshot: snapshot },
          owner,
          leverageCommand,
        );
        journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        expect(
          journal?.status === "verified" &&
            journal.events[0]?.kind === "engine" &&
            journal.events[0].output.openOrders,
        ).toHaveLength(0);
        price = "98.00";
        await handlePerpetualPaperWake({ ...worker(), engine }, old);
        expect((await state(id)).openPositions).toHaveLength(0);
        expect((await state(id)).bookBalanceQuote).toBe("1000.00000000");
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "does not cancel later native orders on a stale idempotent Pause retry",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = {
          ...proposal("long"),
          leverage: 20,
          orderType: "limit",
          limitPriceQuote: "99.00",
        };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))?.openOrders).toHaveLength(
          1,
        );

        const status = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
        const oldPause: PaperPerpetualCommand = {
          ledgerId: id,
          expectedRevision: status!.revision,
          commandId: randomUUID(),
          action: "pause",
        };
        await controlPerpetualPaperWorkspace({ ...deps(), engine }, owner, oldPause);
        expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))?.openOrders).toHaveLength(0);

        await start(id, engine);
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))?.openOrders).toHaveLength(
          1,
        );
        const before = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        if (before?.status !== "verified") throw new Error("Unverified native journal");

        // An identical old command receipt cannot affect a newer active session.
        await controlPerpetualPaperWorkspace({ ...deps(), engine }, owner, oldPause);
        const after = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        if (after?.status !== "verified") throw new Error("Native journal changed after retry");
        expect(after.events).toHaveLength(before.events.length);
        expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))?.openOrders).toHaveLength(
          1,
        );
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "uses an owner leverage ceiling and exact wire quantity through native bootstrap",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (
          await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["conservative"])
        ).accounts[0]!.ledgerId;
        const actor = { ...owner, email: "owner-fixture@rakazo.test", isDeploymentOwner: false };
        const status = await readOwnedPerpetualWorkspace(db.prisma, actor, id);
        await controlPerpetualPaperWorkspace(
          { ...deps(), engine, fetchSnapshot: snapshot },
          actor,
          {
            ledgerId: id,
            commandId: randomUUID(),
            expectedRevision: status!.revision,
            action: "set_leverage",
            venue: "okx",
            instruments: ["BTC-USDT-SWAP"],
            maxLeverage: 3,
          },
        );
        await start(id, engine, ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"]);
        decision = { ...proposal("long"), leverage: 1, quantityBase: "1" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect(await readOwnedPerpetualWorkspace(db.prisma, actor, id)).toMatchObject({
          runtimeError: null,
          lastDecision: { outcome: "filled" },
        });
        expect((await state(id)).openPositions).toHaveLength(1);
        expect((await state(id)).openPositions[0]!.leverage).toBe(1);
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "blocks an oversized entry before native submission",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20, quantityBase: "20" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(0);
        expect((await state(id)).bookBalanceQuote).toBe("1000.00000000");
        const journal = await readOwnedPerpetualPaperJournal(db.prisma, owner, id);
        expect(
          journal?.status === "verified" &&
            journal.events.every(
              (e) =>
                e.kind === "engine" &&
                e.input.commands.every((c) => c.kind === "cancel" || c.reduceOnly),
            ),
        ).toBe(true);
      } finally {
        engine.dispose();
      }
    },
    120000,
  );
  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "waits for final funding before advancing held positions and settles it only once",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20, quantityBase: "1" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(1);
        const boundary = Date.now() + 1000;
        fundingNextAtOverride = new Date(boundary).toISOString();
        decision = { kind: "no_trade", reason: "Funding boundary fixture" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, boundary - Date.now() + 30)),
        );
        fundingNextAtOverride = null;
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          sessionStatus: "paused",
          runtimeError: "protection_unavailable",
        });
        expect((await state(id)).bookBalanceQuote).toBe("999.95000000");
        funding = [
          {
            settledAt: new Date(boundary).toISOString(),
            rateSigned: "0.001",
            priceBasis: "latest_observed_mark_simulation",
          },
        ];
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        expect((await state(id)).bookBalanceQuote).toBe("999.85000000");
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id));
        expect((await state(id)).bookBalanceQuote).toBe("999.85000000");
        expect((await state(id)).fundingNetQuote).toBe("-0.10000000");
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it.skipIf(!process.env.PAPER_NAUTILUS_PYTHON)(
    "caps gross hedge quantity at the registered maintenance tier before native submission",
    async () => {
      const engine = new NautilusPaperEngine({
        pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
        scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
      });
      try {
        tierMaximumBase = "1";
        const id = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
          .accounts[0]!.ledgerId;
        await start(id, engine);
        decision = { ...proposal("long"), leverage: 20, quantityBase: "1" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect((await state(id)).openPositions).toHaveLength(1);
        decision = { ...proposal("short"), leverage: 20, quantityBase: "1" };
        await handlePerpetualPaperWake({ ...worker(), engine }, await payload(id, true));
        expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
          runtimeError: null,
          lastDecision: { outcome: "denied_contract" },
        });
        expect((await state(id)).openPositions).toHaveLength(1);
        expect((await state(id)).bookBalanceQuote).toBe("999.95000000");
      } finally {
        engine.dispose();
      }
    },
    120000,
  );

  it("creates a single account when one strategy is selected", async () => {
    const created = await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]);
    expect(created.accounts).toHaveLength(1);
    expect(
      await readOwnedPerpetualWorkspace(db.prisma, owner, created.accounts[0]!.ledgerId),
    ).toMatchObject({ maxLeverage: 20, sessionStatus: "idle" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("journals owner leverage changes, rejects venue excess, and fences old entries", async () => {
    const id = await account();
    await start(id);
    const old = await payload(id);
    const before = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
    expect(before!.maxLeverage).toBe(10);
    const command = {
      ledgerId: id,
      commandId: randomUUID(),
      expectedRevision: before!.revision,
      action: "set_leverage" as const,
      venue: "okx" as const,
      instruments: ["BTC-USDT-SWAP"],
      maxLeverage: 21,
    };
    const settingsDeps = { ...deps(), fetchSnapshot: snapshot };
    await expect(controlPerpetualPaperWorkspace(settingsDeps, owner, command)).rejects.toThrow();
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.revision).toBe(
      before!.revision,
    );
    command.maxLeverage = 5;
    await controlPerpetualPaperWorkspace(settingsDeps, owner, command);
    const after = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
    expect(after).toMatchObject({ maxLeverage: 5, revision: before!.revision + 1 });
    await controlPerpetualPaperWorkspace(settingsDeps, owner, command);
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.revision).toBe(
      after!.revision,
    );
    await handlePerpetualPaperWake(worker(), old);
    expect((await state(id)).openPositions).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(await db.prisma.tradingPaperPerpetualCommand.count({ where: { ledgerId: id } })).toBe(2);
  });

  it("creates three idle accounts once, never resets funds, and pins idempotent Start deadlines", async () => {
    const id = await account();
    const created = await createOwnedPerpetualExperimentAccounts(db.prisma, owner);
    expect(created.accounts).toHaveLength(3);
    expect(enqueue).not.toHaveBeenCalled();
    for (const a of created.accounts) expect((await state(a.ledgerId)).availableQuote).toBe("1000");
    const command = await start(id);
    const first = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
    await controlPerpetualPaperWorkspace(deps(), owner, command);
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.expiresAt).toBe(
      first!.expiresAt,
    );
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).openPositions).toHaveLength(1);
    expect((await state(id)).availableQuote).not.toBe("1000");
    await createOwnedPerpetualExperimentAccounts(db.prisma, owner);
    expect((await state(id)).openPositions).toHaveLength(1);
    await expect(
      controlPerpetualPaperWorkspace(
        deps(),
        { ...owner, userId: "foreign" },
        { ...command, commandId: randomUUID() },
      ),
    ).rejects.toThrow();
  });

  it("executes independent long/short hedge legs and multiple pairs without duplicate fills on retry", async () => {
    const id = await account();
    await start(id);
    const first = await payload(id);
    await handlePerpetualPaperWake(worker(), first);
    const sequence = (await state(id)).nextSequence;
    await handlePerpetualPaperWake(worker(), first);
    expect((await state(id)).nextSequence).toBe(sequence);
    expect(calls).toHaveLength(1);
    decision = proposal("short");
    await handlePerpetualPaperWake(worker(), await payload(id, true));
    decision = proposal("long", "SOL-USDT-SWAP");
    await handlePerpetualPaperWake(worker(), await payload(id, true));
    const s = await state(id);
    expect(s.openPositions).toHaveLength(3);
    expect(s.openPositions.map((p) => p.side).sort()).toEqual(["long", "long", "short"]);
    expect(new Set(s.openPositions.map((p) => p.hedgeBucket)).size).toBe(3);
    expect(calls).toHaveLength(3);
    const request = calls[0] as Parameters<AgentRuntime["run"]>[0];
    expect(request.tools!.map((t) => t.name)).toEqual(["paper_market_context"]);
    expect(request.prompt).toContain("perpetual-research");
    expect(request.model).toMatchObject({ provider: "fixture", id: "fixture-model" });
  });

  it("rejects excessive risk and leverage instead of using a fallback strategy", async () => {
    const id = await account("conservative");
    await start(id);
    decision = { ...proposal("long"), leverage: 6 };
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).openPositions).toHaveLength(0);
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.lastDecision?.outcome).toBe(
      "denied_leverage_exceeded",
    );
    decision = { ...proposal("long"), leverage: 1, quantityBase: "100" };
    depth = "0.01";
    await handlePerpetualPaperWake(worker(), await payload(id, true));
    expect((await state(id)).openPositions).toHaveLength(0);
    expect(
      (await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.lastDecision?.outcome,
    ).toMatch(/^denied_/);
  });

  it("pauses entries on model failure while funded protection can still close an existing position", async () => {
    const id = await account();
    await start(id);
    await handlePerpetualPaperWake(worker(), await payload(id));
    modelFails = true;
    await handlePerpetualPaperWake(worker(), await payload(id, true));
    expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
      sessionStatus: "paused",
      runtimeError: "model_unavailable",
    });
    expect((await state(id)).openPositions).toHaveLength(1);
    const modelCalls = calls.length;
    price = "96";
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).openPositions).toHaveLength(0);
    expect(calls).toHaveLength(modelCalls);
    expect((await state(id)).closedPositions).toBe(1);
  });

  it("books settlement funding once and closes only available depth without reversing a hedge leg", async () => {
    const id = await account();
    await start(id);
    await handlePerpetualPaperWake(worker(), await payload(id));
    await new Promise((resolve) => setTimeout(resolve, 10));
    funding = [
      {
        settledAt: new Date().toISOString(),
        rateSigned: "0.001",
        priceBasis: "latest_observed_mark_simulation",
      },
    ];
    decision = { kind: "no_trade", reason: "No new setup" };
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).fundingNetQuote).toBe("-0.1");
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).fundingNetQuote).toBe("-0.1");
    const status = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
    expect(status?.status, JSON.stringify(status)).toBe("verified");
    await controlPerpetualPaperWorkspace(deps(), owner, {
      action: "close_all",
      ledgerId: id,
      commandId: randomUUID(),
      expectedRevision: status!.revision,
    });
    depth = "0.4";
    await handlePerpetualPaperWake(worker(), await payload(id));
    const partial = await state(id);
    expect(partial.openPositions).toHaveLength(1);
    expect(partial.openPositions[0]!.quantityBase).toBe("0.6");
    expect(partial.closedPositions).toBe(0);
    depth = "100";
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).openPositions).toHaveLength(0);
    expect((await state(id)).closedPositions).toBe(1);
    expect((await state(id)).lockedMarginQuote).toBe("0");
  });

  it("fences old queued entries on Pause and pauses active entries on process restart", async () => {
    const id = await account();
    await start(id);
    const old = await payload(id);
    await controlPerpetualPaperWorkspace(deps(), owner, {
      action: "pause",
      ledgerId: id,
      expectedRevision: 1,
      commandId: randomUUID(),
    });
    await handlePerpetualPaperWake(worker(), old);
    expect((await state(id)).openPositions).toHaveLength(0);
    expect(calls).toHaveLength(0);
    await start(id);
    const before = await payload(id);
    await reconcilePerpetualPaperWorkspaces(deps(), true);
    expect(await readOwnedPerpetualWorkspace(db.prisma, owner, id)).toMatchObject({
      sessionStatus: "paused",
      runtimeError: "restart_paused",
    });
    await handlePerpetualPaperWake(worker(), before);
    expect(calls).toHaveLength(0);
  });

  it("denies a fresh fill after expiry even if analysis was previously recorded", async () => {
    const id = await account();
    await start(id);
    const wake = await payload(id),
      key = {
        ledgerId: id,
        revision: wake.sessionRevision!,
        scheduledFor: wake.scheduledFor,
        stage: "research" as const,
      };
    await recordPerpetualResearchTick(
      db.prisma,
      owner,
      key,
      [await snapshot("BTC-USDT-SWAP")],
      proposal("long"),
      { provider: "fixture", modelId: "fixture-model" },
    );
    const row = await db.prisma.tradingPaperPerpetualWorkspace.findUniqueOrThrow({
      where: { ledgerId: id },
    });
    const control = parsePerpetualControl(row);
    control.expiresAt = new Date(Date.now() - 1000).toISOString();
    await db.prisma.tradingPaperPerpetualWorkspace.update({
      where: { ledgerId: id },
      data: { control: perpetualPaperJson(control), controlSha256: perpetualPaperHash(control) },
    });
    await commitPerpetualPaperWake(db.prisma, owner, key, [await snapshot("BTC-USDT-SWAP")]);
    expect((await state(id)).openPositions).toHaveLength(0);
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.sessionStatus).toBe(
      "expired",
    );
  });

  it("waits for a limit crossing and cancels pending entries on Pause", async () => {
    const id = await account();
    await start(id);
    decision = { ...proposal("long"), orderType: "limit", limitPriceQuote: "99" };
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect((await state(id)).openPositions).toHaveLength(0);
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.openOrders).toHaveLength(1);
    price = "98.5";
    await handlePerpetualPaperWake(worker(), await payload(id));
    expect(
      (await state(id)).openPositions,
      JSON.stringify({
        workspace: await readOwnedPerpetualWorkspace(db.prisma, owner, id),
        ticks: await db.prisma.tradingPaperPerpetualTick.findMany({
          where: { ledgerId: id },
          select: { outcome: true, stage: true },
        }),
      }),
    ).toHaveLength(1);
    const status = await readOwnedPerpetualWorkspace(db.prisma, owner, id);
    await controlPerpetualPaperWorkspace(deps(), owner, {
      action: "pause",
      ledgerId: id,
      expectedRevision: status!.revision,
      commandId: randomUUID(),
    });
    expect((await readOwnedPerpetualWorkspace(db.prisma, owner, id))!.openOrders).toHaveLength(0);
  });
});
