import type { TradingScanOutput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { suggestPaperPerpetualCryptoUniverse } from "./trading-paper-perpetual-market-shortlist.js";

const NOW = new Date("2026-10-14T10:00:00.000Z");

function candidate(
  base: string,
  turnover: string,
  spreadBps = 1,
  quote = "USDT",
): TradingScanOutput["candidates"][number] {
  const symbol = `${base}-${quote}-SWAP`;
  return {
    market: {
      venue: "okx",
      kind: "perpetual",
      symbol,
      base,
      quote,
      status: "active",
      priceIncrement: "0.01",
      quantityIncrement: "0.001",
      minNotional: null,
      expiryAt: null,
    },
    ticker: {
      venue: "okx",
      kind: "perpetual",
      symbol,
      observedAt: NOW.toISOString(),
      fetchedAt: NOW.toISOString(),
      bid: "10",
      ask: "10.01",
      quoteVolume24h: turnover,
    },
    spreadBps,
  };
}
const scan = (
  candidates: TradingScanOutput["candidates"],
  fetchedAt = NOW.toISOString(),
): Pick<TradingScanOutput, "candidates" | "fetchedAt"> => ({ fetchedAt, candidates });

describe("safe PAPER futures pre-session crypto shortlist", () => {
  it("limits proposals by strategy without automatically trading non-crypto swaps", () => {
    const markets = [
      candidate("SNDK", "500000000"),
      candidate("SOXL", "400000000"),
      candidate("PEPE", "100000000", 9),
      candidate("ETH", "90000000", 2),
      candidate("BTC", "80000000", 1),
      candidate("SUI", "60000000", 6),
      candidate("DOGE", "50000000", 11),
      candidate("XRP", "40000000", 7),
    ];
    expect(suggestPaperPerpetualCryptoUniverse(scan(markets), "conservative", NOW)).toMatchObject({
      symbols: ["ETH-USDT-SWAP", "BTC-USDT-SWAP", "XRP-USDT-SWAP"],
      unclassifiedCount: 5,
    });
    expect(suggestPaperPerpetualCryptoUniverse(scan(markets), "moderate", NOW).symbols).toEqual([
      "ETH-USDT-SWAP",
      "BTC-USDT-SWAP",
      "SUI-USDT-SWAP",
      "DOGE-USDT-SWAP",
      "XRP-USDT-SWAP",
    ]);
    expect(suggestPaperPerpetualCryptoUniverse(scan(markets), "aggressive", NOW).symbols).toEqual([
      "PEPE-USDT-SWAP",
      "ETH-USDT-SWAP",
      "BTC-USDT-SWAP",
      "SUI-USDT-SWAP",
      "DOGE-USDT-SWAP",
      "XRP-USDT-SWAP",
    ]);
  });

  it("rejects stale or future discovery and never falls back to all symbols", () => {
    const markets = [candidate("BTC", "200000000")];
    expect(
      suggestPaperPerpetualCryptoUniverse(
        scan(markets, new Date(NOW.getTime() - 91_000).toISOString()),
        "aggressive",
        NOW,
      ),
    ).toMatchObject({ symbols: [], stale: true });
    expect(
      suggestPaperPerpetualCryptoUniverse(
        scan(markets, new Date(NOW.getTime() + 3_000).toISOString()),
        "aggressive",
        NOW,
      ),
    ).toMatchObject({ symbols: [], stale: true });
    expect(suggestPaperPerpetualCryptoUniverse(scan([]), "conservative", NOW)).toMatchObject({
      symbols: [],
      stale: false,
    });
  });

  it("enforces quote and market identity, rate caps, volume and spread thresholds", () => {
    const markets = [
      candidate("BTC", "30000000", 8),
      candidate("ETH", "30000000", 8.1),
      candidate("SOL", "29999999", 2),
      candidate("ADA", "40000000", 1, "USD"),
      {
        ...candidate("XRP", "60000000"),
        ticker: { ...candidate("XRP", "60000000").ticker, symbol: "ETH-USDT-SWAP" },
      },
      candidate("BTC", "30000000", 8),
    ];
    const out = suggestPaperPerpetualCryptoUniverse(scan(markets), "conservative", NOW);
    expect(out).toMatchObject({ symbols: ["BTC-USDT-SWAP"], eligibleCount: 1 });
    expect(out.qualityExcludedCount).toBe(4);
  });

  it("caps an ample universe at eight and ties are stable by symbol", () => {
    const bases = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "AVAX", "DOT"];
    const markets = bases.reverse().map((base) => candidate(base, "50000000"));
    const out = suggestPaperPerpetualCryptoUniverse(scan(markets), "conservative", NOW);
    expect(out.symbols).toEqual([
      "ADA-USDT-SWAP",
      "AVAX-USDT-SWAP",
      "BNB-USDT-SWAP",
      "BTC-USDT-SWAP",
      "DOT-USDT-SWAP",
      "ETH-USDT-SWAP",
      "LINK-USDT-SWAP",
      "LTC-USDT-SWAP",
    ]);
    expect(out.eligibleCount).toBe(10);
  });
});
