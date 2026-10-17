import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyTradingPaperOpenFillInTransaction } from "./trading-paper-fill.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { readTradingPaperWorkerFillUseInTransaction } from "./trading-paper-worker-fill-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export class PaperWorkerAutomaticStopPreflightIntegrityError extends Error {
  constructor(message = "Automatic PAPER stop candidate integrity mismatch") {
    super(message);
    this.name = "PaperWorkerAutomaticStopPreflightIntegrityError";
  }
}

export type TradingPaperWorkerAutomaticStopCandidate = {
  mode: "paper_only";
  ledgerId: string;
  positionId: string;
  signalId: string;
  venue: "okx" | "bingx";
  symbol: string;
  quantityBase: string;
  stopPriceQuote: string;
  policyRevision: number;
  gateRevision: number;
  signalRevision: number;
  fillRevision: number;
  targetRevision: number;
  fillApprovalEffectId: string;
  targetApprovalEffectId: string;
  fillEventSequence: number;
};

export type TradingPaperWorkerAutomaticStopPreflight = {
  status: "ready";
  mode: "paper_only";
  ledgerId: string;
  positions: TradingPaperWorkerAutomaticStopCandidate[];
};

/** P11F-4 read-only provenance gate for future automatic protective stops.
 *
 * This does not read a market, trigger a close or mutate any PAPER money. It
 * first runs the strict managed lifecycle audit, then returns only currently
 * open positions whose buy fill has verified F3 automatic-fill provenance.
 * Manual/C1 positions without F3 provenance are deliberately excluded.
 *
 * Historical F2/target revisions are preserved as provenance only. A future
 * stop executor must separately require a live D2 worker preflight and fresh
 * public evidence, and the existing C2 close transaction must still revalidate
 * the enabled paper policy. A latched kill switch therefore cannot be weakened
 * by this read-only helper.
 */
export async function readVerifiedTradingPaperWorkerAutomaticStopCandidates(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<TradingPaperWorkerAutomaticStopPreflight> {
  if (!Number.isFinite(now.getTime())) {
    throw new PaperWorkerAutomaticStopPreflightIntegrityError(
      "Invalid automatic PAPER stop preflight clock",
    );
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, now);
        const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
        const positions: TradingPaperWorkerAutomaticStopCandidate[] = [];

        for (const position of recovered.state.positions) {
          const use = await readTradingPaperWorkerFillUseInTransaction(
            tx,
            owner,
            ledgerId,
            position.positionId,
          );
          if (!use) continue;

          const opened = await verifyTradingPaperOpenFillInTransaction(
            tx,
            owner,
            ledgerId,
            position.positionId,
          );
          if (!opened) {
            throw new PaperWorkerAutomaticStopPreflightIntegrityError(
              "F3 provenance exists without a verified open fill",
            );
          }
          if (
            use.signalId !== opened.signalId ||
            use.policyRevision !== opened.policyRevision ||
            use.fillEventSequence !== opened.fillEventSequence ||
            use.venue !== opened.market.venue ||
            use.symbol !== opened.market.symbol ||
            use.reservationId !== opened.positionId ||
            opened.quantityBase !== position.quantityBase
          ) {
            throw new PaperWorkerAutomaticStopPreflightIntegrityError(
              "F3 provenance disagrees with the verified open position",
            );
          }

          positions.push({
            mode: "paper_only",
            ledgerId,
            positionId: opened.positionId,
            signalId: opened.signalId,
            venue: use.venue,
            symbol: use.symbol,
            quantityBase: opened.quantityBase,
            stopPriceQuote: opened.stopPriceQuote,
            policyRevision: use.policyRevision,
            gateRevision: use.gateRevision,
            signalRevision: use.signalRevision,
            fillRevision: use.fillRevision,
            targetRevision: use.targetRevision,
            fillApprovalEffectId: use.fillApprovalEffectId,
            targetApprovalEffectId: use.targetApprovalEffectId,
            fillEventSequence: opened.fillEventSequence,
          });
        }

        positions.sort((left, right) => left.fillEventSequence - right.fillEventSequence);
        return {
          status: "ready" as const,
          mode: "paper_only" as const,
          ledgerId,
          positions,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
