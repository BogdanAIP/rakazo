import { randomUUID } from "node:crypto";
import { TradingResearchOutputSchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  readVerifiedPublicPaperQuoteEvidence,
  recordIdempotentPublicAdapterPaperQuoteEvidence,
} from "./trading-paper-quote-evidence.js";
import { createTradingPaperLedger } from "./trading-paper-store.js";
import {
  PaperWorkerResearchIntegrityError,
  readVerifiedTradingPaperWorkerResearchOutput,
  recordTradingPaperWorkerResearchOutput,
} from "./trading-paper-worker-research.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("paper worker research PostgreSQL persistence", () => {
  const suffix = randomUUID();
  const owner = {
    userId: `paper-research-user-${suffix}`,
    spaceId: `paper-research-space-${suffix}`,
  };
  const orgId = `paper-research-org-${suffix}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-research-first" });
    second = createDb(databaseUrl!, { poolMax: 2, applicationName: "paper-research-second" });
    const createdAt = new Date();
    await first.prisma.user.create({
      data: {
        id: owner.userId,
        name: "Paper Research Fixture",
        email: `${owner.userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await first.prisma.organization.create({
      data: { id: orgId, name: "Paper Research Fixture", slug: orgId, createdAt },
    });
    await first.prisma.member.create({
      data: {
        id: `paper-research-member-${suffix}`,
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
        name: "Paper Research Fixture",
        isDefault: false,
        createdByUserId: owner.userId,
      },
    });
    await first.prisma.spaceMember.create({
      data: {
        id: `paper-research-space-member-${suffix}`,
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

  it("records one verified research result and rejects conflicting replay", async () => {
    const ledgerId = `paper-research-ledger-${suffix}`;
    await createTradingPaperLedger(first.prisma, owner, {
      ledgerId,
      openedAt: new Date(Date.now() - 60_000).toISOString(),
      quoteCurrency: "USDT",
      initialBalanceQuote: "500",
    });
    const at = new Date().toISOString();
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
    };
    const ticker = {
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      bid: "100",
      ask: "100.1",
      quoteVolume24h: "100000",
      observedAt: at,
      fetchedAt: at,
    };
    const quoteEvidenceId = `paper-worker:${"b".repeat(64)}`;
    await recordIdempotentPublicAdapterPaperQuoteEvidence(
      first.prisma,
      owner,
      ledgerId,
      quoteEvidenceId,
      market,
      ticker,
    );
    await expect(
      readVerifiedPublicPaperQuoteEvidence(second.prisma, owner, ledgerId, quoteEvidenceId),
    ).resolves.toMatchObject({ market: { symbol: "SOL-USDT" } });

    const sourceScheduledFor = new Date(Date.now() - 15_000).toISOString();
    const output = TradingResearchOutputSchema.parse({
      algorithm: "breakout_20_1h_v1",
      venue: "okx",
      market,
      fetchedAt: at,
      candleCount: 0,
      latestClosedAt: null,
      signal: {
        kind: "no_trade",
        signalId: "okx:SOL-USDT:1H:no-bars:abstain",
        strategyId: "breakout_20_1h_v1",
        strategyVersion: "1",
        createdAt: at,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        evidenceIds: ["okx:SOL-USDT:1H:no-bars"],
        reason: "At least 21 and at most 100 confirmed 1H bars are required.",
      },
    });
    const input = {
      sourceScheduledFor,
      gateRevision: 3,
      targetRevision: 2,
      quoteEvidenceId,
      output,
    };

    await expect(
      recordTradingPaperWorkerResearchOutput(first.prisma, owner, ledgerId, input),
    ).resolves.toMatchObject({
      status: "recorded",
      signalKind: "no_trade",
      signalId: output.signal.signalId,
    });
    await expect(
      recordTradingPaperWorkerResearchOutput(second.prisma, owner, ledgerId, input),
    ).resolves.toMatchObject({ status: "duplicate", signalId: output.signal.signalId });
    expect(
      await first.prisma.tradingPaperWorkerResearch.count({
        where: { ledgerId, sourceScheduledFor: new Date(sourceScheduledFor) },
      }),
    ).toBe(1);

    await expect(
      readVerifiedTradingPaperWorkerResearchOutput(first.prisma, owner, ledgerId, {
        sourceScheduledFor,
        gateRevision: 3,
        targetRevision: 2,
      }),
    ).resolves.toMatchObject({
      record: { signalId: output.signal.signalId },
      output: { signal: { kind: "no_trade" } },
    });

    const conflicting = {
      ...output,
      signal: { ...output.signal, reason: "changed after retry" },
    };
    await expect(
      recordTradingPaperWorkerResearchOutput(second.prisma, owner, ledgerId, {
        ...input,
        output: conflicting,
      }),
    ).rejects.toBeInstanceOf(PaperWorkerResearchIntegrityError);
    expect(
      await first.prisma.tradingPaperWorkerResearch.count({ where: { ledgerId } }),
    ).toBe(1);
  });
});
