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

  it("researches every officially classified liquid crypto and ranks aggressive ideas by relative range", () => {
    const liquid = Array.from({ length: 12 }, (_, i) => {
      const value = candidate("ALT" + i, String(50_000_000 + i));
      value.market.underlyingClass = "crypto";
      value.ticker.range24hPercent = i;
      return value;
    });
    const disguised = candidate("BTC", "900000000");
    disguised.market.underlyingClass = "equity";
    const unknown = candidate("ETH", "800000000");
    unknown.market.underlyingClass = "unknown";
    const out = suggestPaperPerpetualCryptoUniverse(
      scan([...liquid, disguised, unknown]),
      "aggressive",
      NOW,
    );
    expect(out.eligibleCount).toBe(12);
    expect(out.researchSymbols).toHaveLength(12);
    expect(out.symbols).toHaveLength(8);
    expect(out.researchSymbols[0]).toBe("ALT11-USDT-SWAP");
    expect(out.researchSymbols.at(-1)).toBe("ALT0-USDT-SWAP");
    expect(out.unclassifiedCount).toBe(2);
    expect(
      suggestPaperPerpetualCryptoUniverse(scan(liquid), "conservative", NOW).eligibleCount,
    ).toBe(12);
    liquid[0]!.ticker.quoteVolume24h = "4999999";
    liquid[1]!.spreadBps = 21;
    expect(
      suggestPaperPerpetualCryptoUniverse(scan(liquid), "aggressive", NOW).qualityExcludedCount,
    ).toBe(2);
  });

  it("rejects stale or mismatched ticker evidence even inside a fresh scan", () => {
    const stale = candidate("BTC", "90000000");
    stale.ticker.observedAt = new Date(NOW.getTime() - 91_000).toISOString();
    const foreign = candidate("ETH", "90000000");
    foreign.ticker.venue = "other";
    expect(
      suggestPaperPerpetualCryptoUniverse(scan([stale, foreign]), "aggressive", NOW),
    ).toMatchObject({ symbols: [], qualityExcludedCount: 2 });
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
