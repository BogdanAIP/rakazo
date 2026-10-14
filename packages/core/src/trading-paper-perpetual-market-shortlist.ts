import type { TradingScanOutput } from "@rakazo/contracts";
import type { PaperExperimentStrategy } from "./trading-paper-experiments.js";

/**
 * Locally maintained, deliberately conservative categorization for PAPER research.
 * The public OKX SWAP catalog can contain non-crypto underlyings (equities/ETFs).
 * Unknown symbols remain DISCOVERABLE in the scanner but are NEVER auto-selected.
 * This list does not assert listing, tradability, profitability or risk suitability.
 */
const CORE_CRYPTO = new Set([
  "BTC", "ETH", "SOL", "XRP", "BNB", "LTC", "LINK", "ADA",
  "AVAX", "DOT", "BCH", "TRX", "XLM",
]);
const GENERAL_CRYPTO = new Set([
  ...CORE_CRYPTO,
  "DOGE", "SUI", "NEAR", "APT", "UNI", "ATOM", "AAVE", "FIL",
  "HBAR", "ETC", "ICP", "INJ", "OP", "ARB", "SEI", "TIA",
  "ALGO", "VET", "STX", "GRT", "LDO", "ENS", "CRV",
  "DYDX", "JUP", "PENDLE", "TAO", "ONDO",
]);
const HIGH_VARIANCE_CRYPTO = new Set([
  ...GENERAL_CRYPTO,
  "PEPE", "SHIB", "WIF", "BONK", "FLOKI", "BOME",
  "POPCAT", "FARTCOIN",
]);

const POLICIES = {
  conservative: { assets: CORE_CRYPTO, minTurnover: 30_000_000, maxSpread: 8 },
  moderate: { assets: GENERAL_CRYPTO, minTurnover: 10_000_000, maxSpread: 15 },
  aggressive: { assets: HIGH_VARIANCE_CRYPTO, minTurnover: 5_000_000, maxSpread: 20 },
} as const;

/** No orders, signals, model calls or trading authorization. Only pre-session suggestions. */
export function suggestPaperPerpetualCryptoUniverse(
  snapshot: Pick<TradingScanOutput, "fetchedAt" | "candidates">,
  strategy: PaperExperimentStrategy,
  now: Date = new Date(),
): {
  symbols: string[];
  eligibleCount: number;
  unclassifiedCount: number;
  qualityExcludedCount: number;
  stale: boolean;
} {
  const blank = (stale: boolean) => ({
    symbols: [] as string[],
    eligibleCount: 0,
    unclassifiedCount: 0,
    qualityExcludedCount: 0,
    stale,
  });
  const at = Date.parse(snapshot.fetchedAt);
  const today = now.getTime();
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(today) ||
    at > today + 2_000 ||
    today - at > 90_000
  ) return blank(true);

  const policy = POLICIES[strategy];
  if (!policy) return blank(true);
  const results = new Map<string, { turnover: number; spread: number }>();
  let unclassifiedCount = 0;
  let qualityExcludedCount = 0;
  for (const candidate of snapshot.candidates) {
    const { market, ticker, spreadBps } = candidate;
    if (
      market.venue !== "okx" ||
      market.kind !== "perpetual" ||
      market.quote !== "USDT" ||
      market.status !== "active" ||
      market.symbol !== ticker.symbol ||
      !/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(market.symbol) ||
      market.symbol !== `${market.base}-USDT-SWAP`
    ) {
      qualityExcludedCount++;
      continue;
    }
    if (!policy.assets.has(market.base)) {
      unclassifiedCount++;
      continue;
    }
    const turnover = Number(ticker.quoteVolume24h);
    if (
      !Number.isFinite(turnover) ||
      turnover < policy.minTurnover ||
      !Number.isFinite(spreadBps) ||
      spreadBps < 0 ||
      spreadBps > policy.maxSpread
    ) {
      qualityExcludedCount++;
      continue;
    }
    if (!results.has(market.symbol)) results.set(market.symbol, { turnover, spread: spreadBps });
  }
  const symbols = [...results]
    .sort((a, b) =>
      b[1].turnover - a[1].turnover ||
      a[1].spread - b[1].spread ||
      a[0].localeCompare(b[0]),
    )
    .slice(0, 8)
    .map(([symbol]) => symbol);
  return {
    symbols,
    eligibleCount: results.size,
    unclassifiedCount,
    qualityExcludedCount,
    stale: false,
  };
}
