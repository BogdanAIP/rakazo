import type { TradingInstrument, TradingTicker } from "@rakazo/contracts";

export type MarketExclusionReason =
  | "inactive"
  | "quote_not_allowed"
  | "missing_ticker"
  | "stale_or_future_data"
  | "invalid_book"
  | "insufficient_volume"
  | "excessive_spread";

export type MarketScanPolicy = {
  allowedQuotes: readonly string[];
  minQuoteVolume24h: number;
  maxSpreadBps: number;
  maxDataAgeMs: number;
};

export type MarketScanResult = {
  /** Discovery shortlist, NOT trade recommendations or permission to place orders. */
  candidates: Array<{ market: TradingInstrument; ticker: TradingTicker; spreadBps: number }>;
  excluded: Array<{ market: TradingInstrument; reason: MarketExclusionReason }>;
};

const key = (value: Pick<TradingInstrument, "venue" | "kind" | "symbol">) =>
  JSON.stringify([value.venue, value.kind, value.symbol]);

/** Deterministic, read-only prefilter over dynamically discovered markets. */
export function scanTradingMarkets(
  markets: readonly TradingInstrument[],
  tickers: readonly TradingTicker[],
  policy: MarketScanPolicy,
  now: Date,
): MarketScanResult {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(policy.minQuoteVolume24h) ||
    policy.minQuoteVolume24h < 0 ||
    !Number.isFinite(policy.maxSpreadBps) ||
    policy.maxSpreadBps < 0 ||
    policy.maxSpreadBps > 10_000 ||
    !Number.isSafeInteger(policy.maxDataAgeMs) ||
    policy.maxDataAgeMs <= 0 ||
    policy.allowedQuotes.length === 0
  ) {
    throw new Error("Invalid trading scan policy");
  }

  const byKey = new Map(tickers.map((ticker) => [key(ticker), ticker] as const));
  if (byKey.size !== tickers.length || new Set(markets.map(key)).size !== markets.length) {
    throw new Error("Duplicate trading market or ticker");
  }
  const allowed = new Set(policy.allowedQuotes);
  const result: MarketScanResult = { candidates: [], excluded: [] };
  const reject = (market: TradingInstrument, reason: MarketExclusionReason) => {
    result.excluded.push({ market, reason });
  };

  for (const market of markets) {
    if (market.status !== "active") {
      reject(market, "inactive");
      continue;
    }
    if (!allowed.has(market.quote)) {
      reject(market, "quote_not_allowed");
      continue;
    }
    const ticker = byKey.get(key(market));
    if (!ticker) {
      reject(market, "missing_ticker");
      continue;
    }
    const received = Date.parse(ticker.fetchedAt);
    const observed = Date.parse(ticker.observedAt);
    // Reject clock drift, old exchange observations and cached/replayed responses.
    if (
      !Number.isFinite(received) ||
      !Number.isFinite(observed) ||
      received > now.getTime() + 2_000 ||
      observed > received + 2_000 ||
      now.getTime() - received > policy.maxDataAgeMs ||
      now.getTime() - observed > policy.maxDataAgeMs
    ) {
      reject(market, "stale_or_future_data");
      continue;
    }
    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);
    const volume = Number(ticker.quoteVolume24h);
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0 ||
      bid > ask ||
      !Number.isFinite(volume) ||
      volume < 0
    ) {
      reject(market, "invalid_book");
      continue;
    }
    if (volume < policy.minQuoteVolume24h) {
      reject(market, "insufficient_volume");
      continue;
    }
    const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
    if (spreadBps > policy.maxSpreadBps) {
      reject(market, "excessive_spread");
      continue;
    }
    result.candidates.push({ market, ticker, spreadBps });
  }
  // Stable deterministic ordering; volume is a prefilter metric, not a profitability score.
  result.candidates.sort(
    (a, b) =>
      Number(b.ticker.quoteVolume24h) - Number(a.ticker.quoteVolume24h) ||
      key(a.market).localeCompare(key(b.market)),
  );
  return result;
}
