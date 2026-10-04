import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  createTradingBotPaperLedger,
  readTradingBotPaperBinding,
  requireTradingBotPaperBindingInTransaction,
  TradingBotPaperBindingError,
} from "./trading-paper-bot.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
  PaperRiskPolicyIntegrityError,
  readVerifiedTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger, readVerifiedTradingPaperLedger } from "./trading-paper-store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/** Runs ONLY in the disposable testkit PostgreSQL. Two independent clients. */
describePostgres("P12-1A native Bot / paper ledger immutable scope", () => {
  const suffix = randomUUID();
  const owner = { userId: `bot-ledger-owner-${suffix}`, spaceId: `bot-ledger-space-${suffix}` };
  const orgId = `bot-ledger-org-${suffix}`;
  const botA = `bot-trading-A-${suffix}`;
  const botB = `bot-trading-B-${suffix}`;
  const legacyId = `bot-ledger-legacy-${suffix}`;
  let ledgerA = "";
  let ledgerB = "";
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "bot-ledger-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "bot-ledger-second" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Native Bot Paper Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Native Bot Paper Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `bot-ledger-member-${suffix}`,
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
        name: "Native Bot Paper Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `bot-ledger-space-member-${suffix}`,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
    });
    for (const botId of [botA, botB]) {
      await first.prisma.bot.create({
        data: {
          id: botId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          name: "Paper Research Bot",
          color: "#000000",
        },
      });
    }
  });

  afterAll(async () => {
    if (!first || !second) return;
    try {
      // Strict FK intentionally blocks deleting Bots whose journal still exists.
      await first.prisma.tradingPaperLedger.deleteMany({
        where: { spaceId: owner.spaceId, ownerUserId: owner.userId },
      });
      await first.prisma.organization.deleteMany({ where: { id: orgId } });
      await first.prisma.user.deleteMany({ where: { id: owner.userId } });
    } finally {
      await Promise.allSettled([first.prisma.$disconnect(), second.prisma.$disconnect()]);
      await Promise.allSettled([first.pool.end(), second.pool.end()]);
    }
  });

  it("locks a native Bot and permits at most one newly bound ledger across two clients", async () => {
    const attempted = await Promise.allSettled([
      createTradingBotPaperLedger(first.prisma, owner, botA, {
        quoteCurrency: "USDT",
        initialBalanceQuote: "1000",
      }),
      createTradingBotPaperLedger(second.prisma, owner, botA, {
        quoteCurrency: "USDT",
        initialBalanceQuote: "2000",
      }),
    ]);
    const wins = attempted.filter((x) => x.status === "fulfilled");
    expect(wins).toHaveLength(1);
    expect(attempted.filter((x) => x.status === "rejected")).toHaveLength(1);
    if (wins[0]?.status !== "fulfilled") throw new Error("Missing bound ledger");
    ledgerA = wins[0].value.ledgerId;
    expect(wins[0].value.state.acceptedEvents).toBe(0);
    expect(wins[0].value.botId).toBe(botA);
    expect(await first.prisma.tradingPaperLedger.count({ where: { botId: botA } })).toBe(1);
    expect(await readTradingBotPaperBinding(second.prisma, owner, botA, ledgerA)).toEqual({
      botId: botA,
      ledgerId: ledgerA,
      mode: "paper_only",
    });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId: ledgerA } })).toBe(
      0,
    );
  });

  it("isolates two Bots and rejects wrong owners, spaces, cross-Bot reads and allocations", async () => {
    const b = await createTradingBotPaperLedger(second.prisma, owner, botB, {
      quoteCurrency: "USDT",
      initialBalanceQuote: "600",
    });
    ledgerB = b.ledgerId;
    expect(ledgerB).not.toBe(ledgerA);
    await expect(
      readTradingBotPaperBinding(first.prisma, owner, botA, ledgerB),
    ).rejects.toBeInstanceOf(TradingBotPaperBindingError);
    await expect(
      readTradingBotPaperBinding(second.prisma, owner, botB, ledgerA),
    ).rejects.toBeInstanceOf(TradingBotPaperBindingError);
    await expect(
      readTradingBotPaperBinding(first.prisma, { ...owner, userId: "foreign" }, botA, ledgerA),
    ).rejects.toBeInstanceOf(TradingBotPaperBindingError);
    await expect(
      createTradingBotPaperLedger(second.prisma, { ...owner, spaceId: "foreign-space" }, botA, {
        quoteCurrency: "USDT",
        initialBalanceQuote: "5",
      }),
    ).rejects.toThrow();
    expect(await first.prisma.tradingPaperLedger.count({ where: { botId: botA } })).toBe(1);
    expect(await second.prisma.tradingPaperLedger.count({ where: { botId: botB } })).toBe(1);
  });

  const makeEffect = async (
    label: string,
    botId: string,
    action: "enable" | "disable",
    revision: number,
  ) => {
    const threadId = `bot-ledger-thread-${label}-${suffix}`;
    const taskId = `bot-ledger-task-${label}-${suffix}`;
    const runId = `bot-ledger-run-${label}-${suffix}`;
    const existingThread = await first.prisma.thread.findUnique({ where: { botId } });
    const resolvedThreadId = existingThread?.id ?? threadId;
    if (!existingThread) {
      await first.prisma.thread.create({
        data: { id: resolvedThreadId, spaceId: owner.spaceId, botId, userId: owner.userId },
      });
    }
    await first.prisma.task.create({
      data: {
        id: taskId,
        spaceId: owner.spaceId,
        botId,
        threadId: resolvedThreadId,
        userId: owner.userId,
        prompt: "fixture only",
        status: "running",
      },
    });
    await first.prisma.run.create({
      data: {
        id: runId,
        spaceId: owner.spaceId,
        botId,
        threadId: resolvedThreadId,
        taskId,
        userId: owner.userId,
        status: "running",
        trigger: "user",
      },
    });
    return first.prisma.externalEffect.create({
      data: {
        id: `bot-ledger-effect-${label}-${suffix}`,
        idempotencyKey: `bot-ledger-effect-key-${label}-${suffix}`,
        status: "executing",
        request: { action, ledger_id: ledgerA, expected_policy_revision: revision },
      },
    });
  };

  it("binds explicit paper approval to its originating Bot Run, not just shared owner", async () => {
    const policy = await createDisabledTradingPaperRiskPolicy(first.prisma, owner, ledgerA, {
      allowedVenues: ["okx"],
      quoteCurrency: "USDT",
      maxAgeMs: 60_000, maxSpreadBps: 40, maxTriggerDeviationBps: 50,
      maxPositions: 2, maxPerIdeaRiskQuote: "20", maxDailyLossQuote: "100",
      maxOpenRiskQuote: "40", maxTotalExposureQuote: "900",
      assumedFeeBpsPerSide: 10, assumedSlippageBpsPerSide: 10,
    });
    expect(policy).toMatchObject({ enabled: false, killSwitch: true });
    const wrong = await makeEffect("cross-bot", botB, "enable", 0);
    await expect(applyApprovedTradingPaperControl(first.prisma, owner, wrong.id))
      .rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    expect((await first.prisma.externalEffect.findUniqueOrThrow({ where: { id: wrong.id } })).status)
      .toBe("executing");
    expect((await readVerifiedTradingPaperRiskPolicy(second.prisma, owner, ledgerA)).revision).toBe(0);
    await first.prisma.$transaction(async (tx) => {
      await expect(requireTradingBotPaperBindingInTransaction(
        tx, owner, botA, ledgerA, { runId: `bot-ledger-run-cross-bot-${suffix}` },
      )).rejects.toBeInstanceOf(TradingBotPaperBindingError);
    });
    const right = await makeEffect("own-bot", botA, "enable", 0);
    await expect(applyApprovedTradingPaperControl(second.prisma, owner, right.id))
      .resolves.toMatchObject({
        ok: true, ledgerId: ledgerA, policyRevision: 1, enabled: true, killSwitch: false,
      });
  });

  it("archive denies new Bot-scoped actions but retains owner recovery and approved disable", async () => {
    await first.prisma.bot.update({ where: { id: botA }, data: { archivedAt: new Date() } });
    await expect(readTradingBotPaperBinding(second.prisma, owner, botA, ledgerA))
      .rejects.toBeInstanceOf(TradingBotPaperBindingError);
    expect(await readTradingBotPaperBinding(second.prisma, owner, botA, ledgerA, true))
      .toMatchObject({ botId: botA, ledgerId: ledgerA });
    const deniedEnable = await makeEffect("archived-enable", botA, "enable", 1);
    await expect(applyApprovedTradingPaperControl(first.prisma, owner, deniedEnable.id))
      .rejects.toBeInstanceOf(PaperRiskPolicyIntegrityError);
    const disable = await makeEffect("archived-disable", botA, "disable", 1);
    await expect(applyApprovedTradingPaperControl(second.prisma, owner, disable.id))
      .resolves.toMatchObject({ ok: true, policyRevision: 2, enabled: false, killSwitch: true });
    expect((await readVerifiedTradingPaperRiskPolicy(first.prisma, owner, ledgerA)).policy.enabled)
      .toBe(false);
    await first.prisma.bot.update({ where: { id: botA }, data: { archivedAt: null } });
  });

  it("preserves legacy P11 journals unbound, and blocks Bot deletion and SQL rebinding", async () => {
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId: legacyId, openedAt: "2026-10-04T08:00:00.000Z",
      quoteCurrency: "USDT", initialBalanceQuote: "50",
    });
    expect((await first.prisma.tradingPaperLedger.findUniqueOrThrow({
      where: { id: legacyId }, select: { botId: true },
    })).botId).toBeNull();
    await expect(readTradingBotPaperBinding(second.prisma, owner, botA, legacyId))
      .rejects.toBeInstanceOf(TradingBotPaperBindingError);
    await expect(first.prisma.tradingPaperLedger.update({
      where: { id: legacyId }, data: { botId: botA },
    })).rejects.toThrow();
    await expect(first.prisma.tradingPaperLedger.update({
      where: { id: ledgerA }, data: { botId: botB },
    })).rejects.toThrow();
    await expect(first.prisma.bot.delete({ where: { id: botA } })).rejects.toThrow();
    expect((await readVerifiedTradingPaperLedger(second.prisma, owner, legacyId)).availableQuote)
      .toBe("50");
    expect(await readTradingBotPaperBinding(first.prisma, owner, botA, ledgerA))
      .toMatchObject({ botId: botA, ledgerId: ledgerA });
    expect(await first.prisma.tradingPaperLedger.count({ where: { botId: botA } })).toBe(1);
  });
});
