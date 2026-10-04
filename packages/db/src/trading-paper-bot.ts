import { randomUUID } from "node:crypto";
import type { TradingPaperLedgerState } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  createTradingPaperLedgerInTransaction,
  PaperLedgerIntegrityError,
} from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Db = Pick<PrismaClient, "$transaction">;
type Owner = { spaceId: string; userId: string };

export class TradingBotPaperBindingError extends Error {
  constructor(message = "Native trading Bot / paper ledger binding unavailable") {
    super(message);
    this.name = "TradingBotPaperBindingError";
  }
}

/**
 * Internal-only authorization predicate for a Bot-bound paper ledger.
 * Must be used INSIDE the caller's serializable transaction before any future
 * Bot-facing virtual-money write. Do not infer a binding from a name/prompt.
 * Archive bypass is only for owner recovery/kill-switch, never new trades.
 */
export async function requireTradingBotPaperBindingInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  botId: string,
  ledgerId: string,
  options: { allowArchived?: boolean; runId?: string } = {},
): Promise<void> {
  const member = await tx.spaceMember.findFirst({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true },
  });
  if (!member) throw new TradingBotPaperBindingError();
  const bot = await tx.bot.findFirst({
    where: {
      id: botId,
      spaceId: owner.spaceId,
      userId: owner.userId,
      ...(options.allowArchived ? {} : { archivedAt: null }),
    },
    select: { id: true },
  });
  if (!bot) throw new TradingBotPaperBindingError();
  const ledger = await tx.tradingPaperLedger.findFirst({
    where: {
      id: ledgerId,
      botId,
      spaceId: owner.spaceId,
      ownerUserId: owner.userId,
    },
    select: { id: true },
  });
  if (!ledger) throw new TradingBotPaperBindingError();
  if (options.runId) {
    const run = await tx.run.findFirst({
      where: {
        id: options.runId,
        botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
      },
      select: { id: true },
    });
    if (!run) throw new TradingBotPaperBindingError("Approved Run belongs to a different Bot");
  }
}

/**
 * Creates one inert paper ledger for an existing, active, owner-scoped native
 * Rakazo Bot, using the same P10 journal factory and transaction.
 * This is NOT a bot.create/Routine/public tool or a paper capability grant.
 * Ledger ID and openedAt come from trusted server code, not an AI proposal.
 */
export async function createTradingBotPaperLedger(
  prisma: Db,
  owner: Owner,
  botId: string,
  input: { quoteCurrency: string; initialBalanceQuote: string },
): Promise<{ botId: string; ledgerId: string; state: TradingPaperLedgerState }> {
  if (!botId.trim()) throw new TradingBotPaperBindingError();
  const ledgerId = `paper-bot-${randomUUID()}`;
  const openedAt = new Date().toISOString();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const state = await createTradingPaperLedgerInTransaction(
          tx,
          owner,
          { ledgerId, openedAt, ...input },
          botId,
        );
        return { botId, ledgerId, state };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * Only returns an identity binding, NOT cached or unaudited money values.
 * C3 + C6 strict lifecycle and policy verification remain obligatory for any
 * future Bot-facing financial status. Legacy unbound journals fail closed.
 */
export async function readTradingBotPaperBinding(
  prisma: Db,
  owner: Owner,
  botId: string,
  ledgerId: string,
  allowArchived = false,
): Promise<{ botId: string; ledgerId: string; mode: "paper_only" }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireTradingBotPaperBindingInTransaction(tx, owner, botId, ledgerId, {
          allowArchived,
        });
        return { botId, ledgerId, mode: "paper_only" as const };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

// Retain the existing P10 failure type for genuine replay errors; binding
// errors are intentionally distinct so callers cannot mistake them for PnL.
export { PaperLedgerIntegrityError };
