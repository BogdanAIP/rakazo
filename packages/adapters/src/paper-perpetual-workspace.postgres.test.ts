import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntime,
  BackgroundJobPayloads,
  JobPublisher,
  PaperPerpetualEngine,
} from "@rakazo/adapter-kit";
import type { PaperPerpetualDecision, PaperPerpetualSnapshot } from "@rakazo/contracts";
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
        await controlPerpetualPaperWorkspace(
          { ...deps(), engine, fetchSnapshot: snapshot },
          owner,
          {
            ledgerId: id,
            commandId: randomUUID(),
            expectedRevision: status!.revision,
            action: "set_leverage",
            venue: "okx",
            instruments: ["BTC-USDT-SWAP"],
            maxLeverage: 5,
          },
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
