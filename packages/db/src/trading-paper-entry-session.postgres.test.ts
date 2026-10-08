import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma } from "./client.js";
import {
  applyApprovedTradingPaperEntrySessionControl,
  assessTradingPaperEntrySessionInTransaction,
  readVerifiedTradingPaperEntrySession,
} from "./trading-paper-entry-session.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger } from "./trading-paper-store.js";
import { applyApprovedTradingPaperWorkerControl } from "./trading-paper-worker-gate.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("H1 finite PAPER entry session PostgreSQL owner/fence", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-session-user-${suffix}`,
    spaceId: `paper-session-space-${suffix}`,
  };
  const orgId = `paper-session-org-${suffix}`;
  const ledgerId = `paper-session-ledger-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let counter = 0;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-session-h1-a" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-session-h1-b" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: { id: owner.userId, name: "PAPER Session Fixture", email: `${owner.userId}@rakazo.test`, emailVerified: false },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "PAPER Session Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-session-member-${suffix}`,
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
        name: "PAPER Session Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-session-space-member-${suffix}`,
        spaceId: owner.spaceId,
        organizationId: orgId,
        userId: owner.userId,
        role: "owner",
        createdAt,
      },
    });
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

  const effect = async (kind: string, request: Prisma.InputJsonValue) => {
    counter += 1;
    const id = `paper-session-e${counter}-${suffix}`;
    const botId = `paper-session-b${counter}-${suffix}`;
    const threadId = `paper-session-th${counter}-${suffix}`;
    const taskId = `paper-session-t${counter}-${suffix}`;
    const runId = `paper-session-r${counter}-${suffix}`;
    await first.prisma.bot.create({
      data: { id: botId, spaceId: owner.spaceId, userId: owner.userId, name: "Session", color: "#000000" },
    });
    await first.prisma.thread.create({
      data: { id: threadId, spaceId: owner.spaceId, botId, userId: owner.userId },
    });
    await first.prisma.task.create({
      data: {
        id: taskId, spaceId: owner.spaceId, botId, threadId,
        userId: owner.userId, prompt: "paper session integration", status: "running",
      },
    });
    await first.prisma.run.create({
      data: {
        id: runId, spaceId: owner.spaceId, botId, threadId, taskId,
        userId: owner.userId, status: "running", trigger: "user",
      },
    });
    return first.prisma.externalEffect.create({
      data: {
        id, spaceId: owner.spaceId, runId, kind, idempotencyKey: id,
        status: "executing", request,
      },
    });
  };

  it("requires a new explicit approval, denies before Start, fences Pause/End and never creates trades", async () => {
    const absent = await readVerifiedTradingPaperEntrySession(first.prisma, owner, ledgerId);
    expect(absent).toMatchObject({ status: "absent", revision: 0 });

    const policy = await effect("paper_trading_control", {
      action: "enable", ledger_id: ledgerId, expected_policy_revision: 0,
    });
    await applyApprovedTradingPaperControl(first.prisma, owner, policy.id);
    const worker = await effect("paper_worker_control", {
      action: "enable", ledger_id: ledgerId, expected_policy_revision: 1, cadence_minutes: 15,
    });
    await applyApprovedTradingPaperWorkerControl(first.prisma, owner, worker.id);

    const preStart = await first.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId),
    );
    expect(preStart).toMatchObject({ status: "deny", reason: "session_absent" });

    const start = await effect("paper_session_control", {
      action: "start", ledger_id: ledgerId, expected_revision: 0, duration_minutes: 30,
    });
    const started = await applyApprovedTradingPaperEntrySessionControl(
      second.prisma, owner, start.id,
    );
    expect(started).toMatchObject({ ok: true, status: "active", revision: 1 });
    expect(await readVerifiedTradingPaperEntrySession(first.prisma, owner, ledgerId)).toMatchObject({
      status: "active", revision: 1,
    });

    const active = await second.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(active).toMatchObject({ status: "ready", sessionRevision: 1 });

    const duplicate = await effect("paper_session_control", {
      action: "start", ledger_id: ledgerId, expected_revision: 1, duration_minutes: 30,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(first.prisma, owner, duplicate.id),
    ).toMatchObject({ ok: false, reason: "already_active", currentRevision: 1 });

    const crossOwner = { ...owner, userId: `different-${suffix}` };
    await expect(
      readVerifiedTradingPaperEntrySession(second.prisma, crossOwner, ledgerId),
    ).rejects.toThrow("PAPER ledger unavailable");

    const pause = await effect("paper_session_control", {
      action: "pause", ledger_id: ledgerId, expected_revision: 1,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(first.prisma, owner, pause.id),
    ).toMatchObject({ ok: true, status: "paused", revision: 2 });
    const paused = await first.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(paused).toMatchObject({ status: "deny", reason: "session_paused_or_ended" });

    const staleEnd = await effect("paper_session_control", {
      action: "end", ledger_id: ledgerId, expected_revision: 1,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(second.prisma, owner, staleEnd.id),
    ).toMatchObject({ ok: false, reason: "stale_revision", currentRevision: 2 });

    const end = await effect("paper_session_control", {
      action: "end", ledger_id: ledgerId, expected_revision: 2,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(second.prisma, owner, end.id),
    ).toMatchObject({ ok: true, status: "ended", revision: 3 });
    expect(await readVerifiedTradingPaperEntrySession(first.prisma, owner, ledgerId)).toMatchObject({
      status: "ended", revision: 3,
    });

    const newStart = await effect("paper_session_control", {
      action: "start", ledger_id: ledgerId, expected_revision: 3, duration_minutes: 5,
    });
    expect(
      await applyApprovedTradingPaperEntrySessionControl(first.prisma, owner, newStart.id),
    ).toMatchObject({ ok: true, status: "active", revision: 4 });
    const staleWake = await second.prisma.$transaction((tx) =>
      assessTradingPaperEntrySessionInTransaction(tx, owner, ledgerId, 1),
    );
    expect(staleWake).toMatchObject({ status: "deny", reason: "worker_gate_changed" });
    expect(await first.prisma.tradingPaperLedgerEvent.count({ where: { ledgerId } })).toBe(0);
    expect(await first.prisma.tradingPaperLedgerOutbox.count({ where: { ledgerId } })).toBe(0);
  });
});
