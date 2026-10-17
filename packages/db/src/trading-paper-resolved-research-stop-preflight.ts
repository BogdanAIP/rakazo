import type { TradingResolvedResearchApprovalScope } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyTradingPaperOpenFillInTransaction } from "./trading-paper-fill.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { readTradingPaperResolvedResearchFillUseInTransaction } from "./trading-paper-resolved-research-fill-gate.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;

export class PaperResolvedResearchAutomaticStopPreflightIntegrityError extends Error {
  constructor(message = "Resolved research automatic PAPER stop candidate integrity mismatch") {
    super(message);
    this.name = "PaperResolvedResearchAutomaticStopPreflightIntegrityError";
  }
}

export type TradingPaperResolvedResearchAutomaticStopCandidate = {
  mode: "paper_only";
  ledgerId: string;
  positionId: string;
  signalId: string;
  venue: string;
  symbol: string;
  quantityBase: string;
  stopPriceQuote: string;
  scope: TradingResolvedResearchApprovalScope;
  policyRevision: number;
  gateRevision: number;
  researchRevision: number;
  fillRevision: number;
  fillApprovalEffectId: string;
  researchApprovalEffectId: string;
  fillEventSequence: number;
};

export type TradingPaperResolvedResearchAutomaticStopPreflight = {
  status: "ready";
  mode: "paper_only";
  ledgerId: string;
  positions: TradingPaperResolvedResearchAutomaticStopCandidate[];
};

/** G5 read-only candidate provenance for automatic protective stops.
 *
 * Returns only currently open positions whose buy fill has verified G4
 * Resolver/Skill provenance. It performs the strict lifecycle audit first and
 * never reads a public market, creates evidence, closes a position or mutates
 * PAPER money.
 *
 * G5 intentionally preserves the historical G1/G3 scope as provenance only.
 * Any executor must separately require live D2 authority, fresh trusted public
 * evidence for the opened market and the existing C2 enabled-policy/kill-switch
 * checks. Unsupported public-capture venues must therefore fail closed in the
 * executor instead of being guessed or substituted.
 */
export async function readVerifiedTradingPaperResolvedResearchAutomaticStopCandidates(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  now: Date = new Date(),
): Promise<TradingPaperResolvedResearchAutomaticStopPreflight> {
  if (!Number.isFinite(now.getTime())) {
    throw new PaperResolvedResearchAutomaticStopPreflightIntegrityError(
      "Invalid resolved research automatic PAPER stop preflight clock",
    );
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await auditTradingPaperLifecycleInTransaction(tx, owner, ledgerId, now);
        const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
        const positions: TradingPaperResolvedResearchAutomaticStopCandidate[] = [];

        for (const position of recovered.state.positions) {
          const use = await readTradingPaperResolvedResearchFillUseInTransaction(
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
            throw new PaperResolvedResearchAutomaticStopPreflightIntegrityError(
              "G4 provenance exists without a verified open fill",
            );
          }
          if (
            use.signalId !== opened.signalId ||
            use.policyRevision !== opened.policyRevision ||
            use.fillEventSequence !== opened.fillEventSequence ||
            use.reservationId !== opened.positionId ||
            opened.quantityBase !== position.quantityBase ||
            use.scope.venue !== opened.market.venue ||
            use.scope.marketKind !== opened.market.kind ||
            use.scope.action !== "spot_buy" ||
            opened.market.kind !== "spot"
          ) {
            throw new PaperResolvedResearchAutomaticStopPreflightIntegrityError(
              "G4 provenance disagrees with the verified open position",
            );
          }

          positions.push({
            mode: "paper_only",
            ledgerId,
            positionId: opened.positionId,
            signalId: opened.signalId,
            venue: opened.market.venue,
            symbol: opened.market.symbol,
            quantityBase: opened.quantityBase,
            stopPriceQuote: opened.stopPriceQuote,
            scope: use.scope,
            policyRevision: use.policyRevision,
            gateRevision: use.gateRevision,
            researchRevision: use.researchRevision,
            fillRevision: use.fillRevision,
            fillApprovalEffectId: use.fillApprovalEffectId,
            researchApprovalEffectId: use.researchApprovalEffectId,
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
