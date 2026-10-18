import type { TradingScanOutput } from "@rakazo/contracts";
import { scanTradingMarkets } from "@rakazo/core";
import { fetchOkxPublicCatalog, fetchOkxPublicPerpetualTickers } from "./trading-okx-public.js";

/** Bulk public discovery for research; no per-symbol history fan-out or orders. */
export async function fetchOkxPaperPerpetualResearchScan(
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<Pick<TradingScanOutput, "fetchedAt" | "candidates">> {
  const catalog = await fetchOkxPublicCatalog(options);
  const markets = catalog.markets.filter(
    (market) =>
      market.kind === "perpetual" && market.quote === "USDT" && market.status === "active",
  );
  const tickers = await fetchOkxPublicPerpetualTickers(markets, options);
  const now = options.now ?? new Date();
  const scan = scanTradingMarkets(
    markets,
    tickers,
    {
      allowedQuotes: ["USDT"],
      minQuoteVolume24h: 5_000_000,
      maxSpreadBps: 20,
      maxDataAgeMs: 90_000,
    },
    now,
  );
  return { fetchedAt: now.toISOString(), candidates: scan.candidates };
}
