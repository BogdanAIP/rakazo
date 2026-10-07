import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import type { TradingInstrument, TradingResearchOutput } from "@rakazo/contracts";
import { researchClosedHourBreakout } from "@rakazo/core";
import {
  type PaperWorkerResearchRecord,
  type PrismaClient,
  readVerifiedPublicPaperQuoteEvidence,
  readVerifiedTradingPaperWorkerResearchOutputIfPresent,
  recordTradingPaperWorkerResearchOutput,
} from "@rakazo/db";
import type { PaperWorkerMarketObservationResult } from "./paper-worker-market-observation.js";
import { fetchBingxClosedOneHourHistory } from "./trading-bingx-history.js";
import { fetchOkxClosedOneHourHistory } from "./trading-okx-history.js";

type CompletedObservation = Extract<PaperWorkerMarketObservationResult, { status: "observed" }>;
type ReadEvidence = typeof readVerifiedPublicPaperQuoteEvidence;
type ReadExistingResearch = typeof readVerifiedTradingPaperWorkerResearchOutputIfPresent;
type ClosedHistory = Awaited<ReturnType<typeof fetchOkxClosedOneHourHistory>>;
type FetchHistory = (market: TradingInstrument, options: { now?: Date }) => Promise<ClosedHistory>;
type Research = typeof researchClosedHourBreakout;
type RecordResearch = typeof recordTradingPaperWorkerResearchOutput;

export type PaperWorkerResearchResult =
  | {
      status: "history_unavailable";
      venue: "okx" | "bingx";
      symbol: string;
    }
  | {
      status: "researched";
      output: TradingResearchOutput;
      record: PaperWorkerResearchRecord;
    };

async function fetchClosedOneHourHistory(
  market: TradingInstrument,
  options: { now?: Date },
): Promise<ClosedHistory> {
  return market.venue === "bingx"
    ? fetchBingxClosedOneHourHistory(market, options)
    : fetchOkxClosedOneHourHistory(market, options);
}

/** P11E-6 research-only composition. It consumes only an already durable E3
 * observation, fetches venue-matching fixed-endpoint closed 1H history and
 * runs the same deterministic breakout baseline for OKX or BingX spot. */
export async function researchObservedPaperWorkerMarket(
  prisma: PrismaClient,
  payload: BackgroundJobPayloads["paper.worker-preflight"],
  observation: CompletedObservation,
  now: Date = new Date(),
  readEvidence: ReadEvidence = readVerifiedPublicPaperQuoteEvidence,
  readExistingResearch: ReadExistingResearch = readVerifiedTradingPaperWorkerResearchOutputIfPresent,
  fetchHistory: FetchHistory = fetchClosedOneHourHistory,
  research: Research = researchClosedHourBreakout,
  recordResearch: RecordResearch = recordTradingPaperWorkerResearchOutput,
): Promise<PaperWorkerResearchResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid paper worker research clock");
  }
  const owner = { spaceId: payload.spaceId, userId: payload.userId };
  const existing = await readExistingResearch(prisma, owner, payload.ledgerId, {
    sourceScheduledFor: payload.scheduledFor,
    gateRevision: payload.gateRevision,
    targetRevision: observation.targetPreflight.targetRevision,
  });
  if (existing) {
    return { status: "researched", ...existing };
  }

  const evidence = await readEvidence(prisma, owner, payload.ledgerId, observation.evidence.id);
  if (
    evidence.market.venue !== observation.target.venue ||
    evidence.market.symbol !== observation.target.symbol ||
    evidence.market.kind !== "spot"
  ) {
    throw new Error("Observed paper market evidence no longer matches the approved target");
  }

  let history: ClosedHistory;
  try {
    history = await fetchHistory(evidence.market, { now });
  } catch {
    return {
      status: "history_unavailable",
      venue: observation.target.venue,
      symbol: observation.target.symbol,
    };
  }
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
