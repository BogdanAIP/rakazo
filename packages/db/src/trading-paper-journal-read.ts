import type {
  TradingPaperJournalListOutput,
  TradingPaperJournalReadOutput,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  auditTradingPaperLifecycleInTransaction,
  PaperLifecycleAuditError,
} from "./trading-paper-lifecycle-audit.js";
import { PaperStopGuardIntegrityError } from "./trading-paper-stop-guard.js";
import {
  PaperLedgerIntegrityError,
  recoverTradingPaperLedgerInTransaction,
} from "./trading-paper-store.js";

type Owner = { spaceId: string; userId: string };
const PAGE_SIZE = 100;

/**
 * Display metadata only; no unverified monetary fields are ever returned in
 * this overview. Scope by BOTH the authenticated user's id and active space.
 */
export async function listOwnedTradingPaperJournals(
  prisma: PrismaClient,
  owner: Owner,
): Promise<TradingPaperJournalListOutput> {
  const ledgers = await prisma.tradingPaperLedger.findMany({
    where: { spaceId: owner.spaceId, ownerUserId: owner.userId },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 50,
    select: {
      id: true,
      openedAt: true,
      updatedAt: true,
      quoteCurrency: true,
      version: true,
    },
  });
  return {
    mode: "paper_only",
    ledgers: ledgers.map((ledger) => ({
      ledgerId: ledger.id,
      openedAt: ledger.openedAt.toISOString(),
      updatedAt: ledger.updatedAt.toISOString(),
      quoteCurrency: ledger.quoteCurrency,
      eventsCount: ledger.version,
    })),
  };
}

/**
 * Dedicated read-only human dashboard projection, NOT a trading tool.
 * Never exposes raw DB helper, write actions, permissions or order endpoints.
 * On failed hash-chain/lifecycle audit, suppress ALL financial and event data.
 * No verification bypass, repair, reconciliation, or write side effect.
 */
export async function readOwnedTradingPaperJournal(
  prisma: PrismaClient,
  owner: Owner,
  ledgerId: string,
  beforeSequence?: number,
  now: Date = new Date(),
): Promise<TradingPaperJournalReadOutput | null> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid paper journal read clock");
  return prisma.$transaction(
    async (tx): Promise<TradingPaperJournalReadOutput | null> => {
      // Enforce the owner boundary BEFORE attempting the integrity classification.
      const scoped = await tx.tradingPaperLedger.findFirst({
        where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
        select: { id: true, openedAt: true, updatedAt: true },
      });
      if (!scoped) return null;

      try {
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, now);
        const verified = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
        const eligible =
          beforeSequence === undefined
            ? verified.events
            : verified.events.filter((event) => event.sequence < beforeSequence);
        const page = eligible.slice(-PAGE_SIZE);
        const oldest = page[0]?.sequence;
        const nextBeforeSequence =
          oldest !== undefined && eligible.length > page.length ? oldest : null;
        return {
          status: "verified",
          mode: "paper_only",
          ledgerId,
          openedAt: scoped.openedAt.toISOString(),
          updatedAt: scoped.updatedAt.toISOString(),
          state: verified.state,
          events: [...page].reverse(),
          nextBeforeSequence,
        };
      } catch (error) {
        if (
          error instanceof PaperLifecycleAuditError ||
          error instanceof PaperLedgerIntegrityError ||
          error instanceof PaperStopGuardIntegrityError
        ) {
          return {
            status: "integrity_blocked",
            mode: "paper_only",
            ledgerId,
            message: "Journal integrity verification failed",
          };
        }
        throw error;
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
