import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingResearchOutput } from "@rakazo/contracts";
import { researchClosedHourBreakout } from "@rakazo/core";
import {
  type PaperWorkerResearchRecord,
  type PrismaClient,
  readVerifiedPublicPaperQuoteEvidence,
  recordTradingPaperWorkerResearchOutput,
} from "@rakazo/db";
import {
  fetchOkxClosedOneHourHistory,
  type OkxClosedHistory,
} from "./trading-okx-history.js";
import type { PaperWorkerMarketObservationResult } from "./paper-worker-market-observation.js";

type CompletedObservation = Extract<PaperWorkerMarketObservationResult, { status: "observed" }>;
type ReadEvidence = typeof readVerifiedPublicPaperQuoteEvidence;
type FetchHistory = typeof fetchOkxClosedOneHourHistory;
type Research = typeof researchClosedHourBreakout;
type RecordResearch = typeof recordTradingPaperWorkerResearchOutput;

export type PaperWorkerResearchResult =
  | {
      status: "unsupported_target";
      venue: "bingx";
      symbol: string;
    }
  | {
      status: "researched";
      output: TradingResearchOutput;
      record: PaperWorkerResearchRecord;
    };

/** P11E-5 research-only composition. It consumes only an already durable E3
 * observation. OKX history uses the fixed public 1H adapter and the existing
 * deterministic breakout baseline. BingX is intentionally abstained until a
 * venue-matching closed-candle adapter is separately reviewed. */
export async function researchObservedPaperWorkerMarket(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  observation: CompletedObservation,
  now: Date = new Date(),
  readEvidence: ReadEvidence = readVerifiedPublicPaperQuoteEvidence,
  fetchHistory: FetchHistory = fetchOkxClosedOneHourHistory,
  research: Research = researchClosedHourBreakout,
  recordResearch: RecordResearch = recordTradingPaperWorkerResearchOutput,
): Promise<PaperWorkerResearchResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid paper worker research clock");
  }
  if (observation.target.venue === "bingx") {
    return {
      status: "unsupported_target",
      venue: "bingx",
      symbol: observation.target.symbol,
    };
  }

  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const evidence = await readEvidence(prisma, owner, payload.ledgerId, observation.evidence.id);
  if (
    evidence.market.venue !== "okx" ||
    evidence.market.symbol !== observation.target.symbol ||
    evidence.market.kind !== "spot"
  ) {
    throw new Error("Observed paper market evidence no longer matches the approved OKX target");
  }

  const history: OkxClosedHistory = await fetchHistory(evidence.market, { now });
  const output = research({
    market: evidence.market,
    candles: history.candles,
    fetchedAt: history.fetchedAt,
    now,
  });
  const record = await recordResearch(prisma, owner, payload.ledgerId, {
    sourceScheduledFor: payload.scheduledFor,
    gateRevision: payload.gateRevision,
    targetRevision: observation.targetPreflight.targetRevision,
    quoteEvidenceId: observation.evidence.id,
    output,
  });
  return { status: "researched", output, record };
}
