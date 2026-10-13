import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PaperPerpetualEngineBatch, PaperPerpetualEngineConfig } from "@rakazo/contracts";
import {
  appendPerpetualEngineBatchInTransaction,
  createDb,
  createOwnedPerpetualExperimentAccounts,
  perpetualPaperHash,
  perpetualPaperJson,
  readOwnedPerpetualPaperJournal,
  readOwnedPerpetualWorkspace,
  recoverPerpetualEngineInTransaction,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NautilusPaperEngine } from "./nautilus-paper-engine.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL && process.env.PAPER_NAUTILUS_PYTHON
    ? describe.sequential
    : describe.skip;
suite("native futures simulator journal against PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  const suffix = randomUUID(),
    owner = { spaceId: "native-space-" + suffix, userId: "native-user-" + suffix };
  const orgId = "native-org-" + suffix;
  let ledgerId = "native.paper:" + suffix;
  let engine: NautilusPaperEngine;
  const config: PaperPerpetualEngineConfig = {
    version: "paper_engine_config_v1",
    engineId: "nautilus",
    engineVersion: "1.231.0",
    accountId: ledgerId,
    initialBalanceQuote: "1000",
    leverage: 20,
    instruments: [
      {
        instrument: "BTC-USDT-SWAP",
        priceIncrement: "0.01",
        quantityIncrement: "0.01",
        minimumBase: "0.01",
        maximumBase: "100.00",
        maintenanceRate: "0.005",
        makerFeeRate: "0.001",
        takerFeeRate: "0.001",
      },
    ],
  };
  const input = (
    sequence: number,
    commands: PaperPerpetualEngineBatch["commands"] = [],
    rate?: string,
  ): PaperPerpetualEngineBatch => {
    const at = 1704067200000000000n + BigInt(sequence) * 1000000000n;
    return {
      sequence,
      commands,
      quotes: [
        {
          instrument: "BTC-USDT-SWAP",
          atNs: String(at),
          bidQuote: "100.00",
          askQuote: "100.00",
          markPriceQuote: "100.00",
          bidAvailableBase: "100.00",
          askAvailableBase: "100.00",
        },
      ],
      funding: rate
        ? [{ instrument: "BTC-USDT-SWAP", atNs: String(at + 1n), rateSigned: rate }]
        : [],
    };
  };
  const order = (
    id: string,
    positionId: string,
    action: "buy" | "sell",
    reduceOnly = false,
    quantityBase = "1.00",
  ) => ({
    kind: "order" as const,
    orderId: id,
    positionId,
    instrument: "BTC-USDT-SWAP",
    action,
    quantityBase,
    reduceOnly,
    orderType: "market" as const,
    limitPriceQuote: null,
  });
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
    engine = new NautilusPaperEngine({
      pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
      scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
    });
    const createdAt = new Date();
    await db.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Native fixture",
        email: owner.userId + "@rakazo.test",
        emailVerified: false,
      },
    });
    await db.prisma.organization.create({
      data: { id: orgId, name: "Native fixture", slug: orgId, createdAt },
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
        name: "Native fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: "space-member-" + suffix,
        ...owner,
        organizationId: orgId,
        role: "owner",
        createdAt,
      },
    });
    ledgerId = (await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["aggressive"]))
      .accounts[0]!.ledgerId;
    config.accountId = ledgerId;
  });
  afterAll(async () => {
    engine?.dispose();
    if (db) {
      await db.prisma.organization.deleteMany({ where: { id: orgId } });
      await db.prisma.user.deleteMany({ where: { id: owner.userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  it("restores a multi-chunk native journal after process loss without skipped batches", async () => {
    const fresh = new NautilusPaperEngine({
      pythonCommand: process.env.PAPER_NAUTILUS_PYTHON!,
      scriptPath: fileURLToPath(new URL("../nautilus/paper_engine.py", import.meta.url)),
    });
    const standAlone = { ...config, accountId: "native-replay:" + suffix };
    const history: Array<{
      input: PaperPerpetualEngineBatch;
      output: Awaited<ReturnType<NautilusPaperEngine["apply"]>>;
    }> = [];
    try {
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        const next = input(sequence);
        const snapshot = await fresh.apply(standAlone, history, next);
        history.push({ input: next, output: snapshot });
      }
      fresh.invalidate(standAlone.accountId);
      expect(fresh.requiresRecovery(standAlone.accountId)).toBe(true);
      const restored = await fresh.apply(standAlone, history, input(21));
      expect(restored.sequence).toBe(21);
      expect(restored.balanceQuote).toBe(history.at(-1)!.output.balanceQuote);
      expect(restored.eventCount).toBe(history.at(-1)!.output.eventCount);
    } finally {
      fresh.dispose();
    }
  }, 60000);

  it("commits native money, replays after rollback/restart and rejects forks and tampering", async () => {
    const read = () =>
      db.prisma.$transaction((tx) => recoverPerpetualEngineInTransaction(tx, owner, ledgerId));
    const batches = [
      input(1, [order("one", "LONG", "buy")]),
      input(2, [order("two", "SHORT", "sell")]),
      input(3, [order("three", "LONG", "sell", true, "0.40")]),
      input(4, [], "0.001"),
    ];
    for (const batch of batches) {
      const prior = await read();
      const output = await engine.apply(config, prior?.transitions ?? [], batch);
      const write = {
        config,
        input: batch,
        output,
        batchId: "batch:" + batch.sequence,
        expectedHead: prior?.headSha256 ?? null,
      };
      if (batch.sequence === 2) {
        await expect(
          db.prisma.$transaction(async (tx) => {
            await appendPerpetualEngineBatchInTransaction(tx, owner, write);
            throw new Error("fixture rollback");
          }),
        ).rejects.toThrow("fixture rollback");
        engine.invalidate(ledgerId);
        expect((await read())?.transitions).toHaveLength(1);
        expect(await engine.apply(config, prior!.transitions, batch)).toEqual(output);
      }
      await db.prisma.$transaction(async (tx) => {
        const opts = { transactionScopedReuse: true };
        const preceding = await recoverPerpetualEngineInTransaction(tx, owner, ledgerId, opts);
        const beforeAgain = await recoverPerpetualEngineInTransaction(tx, owner, ledgerId, opts);
        if (preceding) expect(beforeAgain).toBe(preceding);
        await appendPerpetualEngineBatchInTransaction(tx, owner, write);
        const advanced = await recoverPerpetualEngineInTransaction(tx, owner, ledgerId, opts);
        expect(advanced?.snapshot).toEqual(output);
        expect(advanced?.transitions).toHaveLength(batch.sequence);
        const advancedAgain = await recoverPerpetualEngineInTransaction(tx, owner, ledgerId, opts);
        expect(advancedAgain).toBe(advanced);
      });
      expect(
        (
          await db.prisma.$transaction((tx) =>
            appendPerpetualEngineBatchInTransaction(tx, owner, write),
          )
        ).status,
      ).toBe("duplicate");
      await expect(
        db.prisma.$transaction((tx) =>
          appendPerpetualEngineBatchInTransaction(tx, owner, {
            ...write,
            input: { ...batch, commands: [] },
            output: { ...output, balanceQuote: "1000" },
          }),
        ),
      ).rejects.toThrow("Conflicting PAPER engine retry");
    }
    const actor = { ...owner, email: "native-fixture@rakazo.test", isDeploymentOwner: false };
    const journal = await readOwnedPerpetualPaperJournal(db.prisma, actor, ledgerId);
    expect(journal?.status).toBe("verified");
    expect(journal?.status === "verified" && journal.state.engine?.id).toBe("nautilus");
    const committed = await read();
    expect(committed?.snapshot?.balanceQuote).toBe("999.80000000");
    expect(await readOwnedPerpetualWorkspace(db.prisma, actor, ledgerId)).toMatchObject({
      executionFees: [
        { instrument: "BTC-USDT-SWAP", makerFeeRate: "0.001", takerFeeRate: "0.001" },
      ],
    });
    expect(committed?.snapshot?.positions).toHaveLength(2);
    expect(await db.prisma.tradingPaperPerpetualEvent.count({ where: { ledgerId } })).toBe(0);
    engine.invalidate(ledgerId);
    const fifth = input(5);
    const restored = await engine.apply(config, committed!.transitions, fifth);
    expect(restored.balanceQuote).toBe(committed!.snapshot!.balanceQuote);
    await expect(
      db.prisma.$transaction((tx) =>
        recoverPerpetualEngineInTransaction(
          tx,
          {
            ...owner,
            userId: "intruder",
          },
          ledgerId,
        ),
      ),
    ).rejects.toThrow("Owner PAPER engine unavailable");
    await db.prisma.tradingPaperPerpetualEngineBatch.update({
      where: { ledgerId_sequence: { ledgerId, sequence: 1 } },
      data: { outputSha256: "0".repeat(64) },
    });
    await expect(read()).rejects.toThrow("PAPER engine journal integrity failed");
  }, 60000);

  it.skipIf(!process.env.PAPER_LONG_JOURNAL_ROWS)(
    "audits long PAPER journal in PostgreSQL within the recovery budget",
    async () => {
      // This stress fixture synthesizes flat-account projections. It measures
      // persisted hash-chain verification, not native execution throughput.
      // Optional PAPER_LONG_JOURNAL_NATIVE=1 additionally measures true replay.
      const count = Number(process.env.PAPER_LONG_JOURNAL_ROWS);
      if (!Number.isSafeInteger(count) || count < 100 || count > 50000)
        throw new Error("Set PAPER_LONG_JOURNAL_ROWS to an integer from 100 to 50000");
      const accountId = (
        await createOwnedPerpetualExperimentAccounts(db.prisma, owner, ["conservative"])
      ).accounts[0]!.ledgerId;
      const setup = { ...config, accountId };
      const initialInput = input(1);
      const initialOutput = await engine.apply(setup, [], initialInput);
      if (initialOutput.positions.length || initialOutput.events.length)
        throw new Error("Stress fixture expected an empty native starting account");
      const first = await db.prisma.$transaction((tx) =>
        appendPerpetualEngineBatchInTransaction(tx, owner, {
          config: setup,
          input: initialInput,
          output: initialOutput,
          batchId: "load:1",
          expectedHead: null,
        }),
      );
      let head = first.headSha256;
      let lastOutput = initialOutput;
      const rows: Array<{
        ledgerId: string;
        sequence: number;
        batchId: string;
        input: ReturnType<typeof perpetualPaperJson>;
        output: ReturnType<typeof perpetualPaperJson>;
        inputSha256: string;
        outputSha256: string;
        previousSha256: string;
        chainSha256: string;
      }> = [];
      const seedStart = Date.now();
      for (let sequence = 2; sequence <= count; sequence++) {
        const event = input(sequence);
        // No orders, funding, fills, fee changes or position changes exist in
        // this fixture; only native clock and transition sequence advance.
        const result = {
          ...initialOutput,
          sequence,
          clockNs: event.quotes[0]!.atNs,
          events: [],
          eventCount: 0,
        };
        const inputHash = perpetualPaperHash(event);
        const outputHash = perpetualPaperHash(result);
        const nextHead = perpetualPaperHash([head, inputHash, outputHash]);
        rows.push({
          ledgerId: accountId,
          sequence,
          batchId: "load:" + sequence,
          input: perpetualPaperJson(event),
          output: perpetualPaperJson(result),
          inputSha256: inputHash,
          outputSha256: outputHash,
          previousSha256: head,
          chainSha256: nextHead,
        });
        head = nextHead;
        lastOutput = result;
        if (rows.length === 500 || sequence === count) {
          const insert = rows.splice(0, rows.length);
          await db.prisma.$transaction(async (tx) => {
            await tx.tradingPaperPerpetualEngineBatch.createMany({ data: insert });
            await tx.tradingPaperPerpetualEngine.update({
              where: { ledgerId: accountId },
              data: {
                sequence,
                headSha256: head,
                projection: perpetualPaperJson(lastOutput),
                projectionSha256: perpetualPaperHash(lastOutput),
              },
            });
          });
        }
      }
      const seededMs = Date.now() - seedStart;
      const scanStart = Date.now();
      const verified = await db.prisma.$transaction(
        (tx) => recoverPerpetualEngineInTransaction(tx, owner, accountId),
        { timeout: 60000 },
      );
      const verifiedMs = Date.now() - scanStart;
      expect(verified?.transitions).toHaveLength(count);
      expect(verified?.headSha256).toBe(head);
      expect(verified?.snapshot?.sequence).toBe(count);
      process.stdout.write(
        "PAPER_LONG_JOURNAL " +
          JSON.stringify({ rows: count, seededMs, verifiedMs, targetMs: 60000 }) +
          "\n",
      );
      expect(verifiedMs).toBeLessThan(60000);
      if (process.env.PAPER_LONG_JOURNAL_NATIVE === "1") {
        engine.invalidate(accountId);
        const replayStart = Date.now();
        await engine.prepare(setup, verified!.transitions);
        const replayMs = Date.now() - replayStart;
        process.stdout.write(
          "PAPER_LONG_JOURNAL_NATIVE " + JSON.stringify({ rows: count, replayMs }) + "\n",
        );
        expect(engine.requiresRecovery(accountId)).toBe(false);
      }
      engine.invalidate(accountId);
    },
    900000,
  );
});
