import type {
  TradingResearchOutput,
  TradingSweepRequest,
  TradingSweepOutput,
} from "@rakazo/contracts";
import { TradingSweepOutputSchema } from "@rakazo/contracts";
import { researchClosedHourBreakout, scanTradingMarkets } from "@rakazo/core";
import { fetchOkxClosedOneHourHistory } from "./trading-okx-history.js";
import { fetchOkxPublicCatalog, fetchOkxPublicSpotTickers } from "./trading-okx-public.js";

/**
 * One explicit, keyless market sweep; no Worker schedule, trade execution or
 * API credentials. Five consecutive 1H history GETs at most (NOT a bulk DDoS).
 *
 * Spot only for now: perpetual turnover, funding, margin and liquidation risk
 * must be validated separately rather than silently treated as spot values.
 */
export async function sweepOkxSpotResearch(
  policy: TradingSweepRequest,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TradingSweepOutput> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid sweep clock");
  if (!Number.isInteger(policy.maxInstruments) || policy.maxInstruments < 1 || policy.maxInstruments > 5) {
    throw new Error("Sweep must analyze one to five instruments only");
  }
  const fetchImpl = options.fetchImpl;
  const catalog = await fetchOkxPublicCatalog({ fetchImpl, now: options.now });
  const spot = catalog.markets.filter((market) => market.kind === "spot");
  const tickers = await fetchOkxPublicSpotTickers(spot, { fetchImpl, now: options.now });
  const scan = scanTradingMarkets(spot, tickers, policy, options.now ?? new Date());

  // Shortlist is ordered by observed quote-volume ONLY as a bounded research
  // sampling strategy; no profitability or 'best coin' inference is made.
  const selected = scan.candidates.slice(0, policy.maxInstruments);
  const analyzed: TradingResearchOutput[] = [];
  const unavailable: TradingSweepOutput["unavailable"] = [];
  for (const candidate of selected) {
    try {
      const history = await fetchOkxClosedOneHourHistory(candidate.market, {
        fetchImpl,
        now: options.now,
      });
      // Read-only output; the research function has no order/account handles.
      const result = researchClosedHourBreakout({
        market: candidate.market,
        candles: history.candles,
        fetchedAt: history.fetchedAt,
        now: options.now ?? new Date(),
      });
      // A current ticker materially different from a historic close should not
      // be presented as a current entry level. Abstain from this candidate.
      const last = history.candles.at(-1);
      if (result.signal.kind === "proposal" && last) {
        const mid = (Number(candidate.ticker.bid) + Number(candidate.ticker.ask)) / 2;
        const close = Number(last.close);
        if (!Number.isFinite(mid) || close <= 0 || Math.abs(mid / close - 1) > 0.05) {
          unavailable.push({
            symbol: candidate.market.symbol,
            reason: "history_unavailable_or_invalid",
          });
          continue;
        }
      }
      analyzed.push(result);
    } catch {
      // Never fabricate an AI signal or substitute another instrument when a
      // provider is down or its history violates strict input validation.
      unavailable.push({
        symbol: candidate.market.symbol,
        reason: "history_unavailable_or_invalid",
      });
    }
  }

  const completedAt = options.now ?? new Date();
  if (now.getTime() !== completedAt.getTime()) {
    const tickerFetch = Math.max(...tickers.map((ticker) => Date.parse(ticker.fetchedAt)));
    if (Number.isFinite(tickerFetch) && completedAt.getTime() - tickerFetch > policy.maxDataAgeMs) {
      throw new Error("Market sweep ticker snapshot expired during analysis");
    }
  }
  return TradingSweepOutputSchema.parse({
    venue: "okx",
    fetchedAt: completedAt.toISOString(),
    universeCount: spot.length,
    shortlistCount: scan.candidates.length,
    filteredOutCount: scan.excluded.length,
    analyzed,
    unavailable,
  });
}
