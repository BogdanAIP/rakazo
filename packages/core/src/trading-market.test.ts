import { TradingInstrumentSchema, TradingTickerSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { scanTradingMarkets } from "./trading-market.js";

const NOW = new Date("2026-10-03T10:00:00.000Z");
const policy = {
  allowedQuotes: ["USDT"],
  minQuoteVolume24h: 100_000,
  maxSpreadBps: 40,
  maxDataAgeMs: 60_000,
};

function market(base: string, changes: Record<string, unknown> = {}) {
  return TradingInstrumentSchema.parse({
    venue: "bingx",
    kind: "spot",
    symbol: base + "-USDT",
    base,
    quote: "USDT",
    status: "active",
    priceIncrement: "0.01",
    quantityIncrement: "0.01",
    minNotional: "5",
    expiryAt: null,
    ...changes,
  });
}
function ticker(symbol: string, changes: Record<string, unknown> = {}) {
  return TradingTickerSchema.parse({
    venue: "bingx",
    kind: "spot",
    symbol,
    observedAt: NOW.toISOString(),
    fetchedAt: NOW.toISOString(),
    bid: "99.9",
    ask: "100",
    quoteVolume24h: "1000000",
    ...changes,
  });
}

describe("read-only trading scanner", () => {
  it("discovers multiple altcoins instead of hardcoding BTC, without creating orders", () => {
    const markets = [market("DOGE"), market("SOL"), market("ADA")];
    const ticks = [
      ticker("DOGE-USDT", { quoteVolume24h: "200000" }),
      ticker("SOL-USDT", { quoteVolume24h: "400000" }),
      ticker("ADA-USDT", { quoteVolume24h: "300000" }),
    ];
    const result = scanTradingMarkets(markets, ticks, policy, NOW);
    expect(result.candidates.map((item) => item.market.symbol)).toEqual([
      "SOL-USDT",
      "ADA-USDT",
      "DOGE-USDT",
    ]);
    expect(result.excluded).toEqual([]);
    expect("orders" in result).toBe(false);
  });

  it("fails closed with explicit reasons for inactive, stale, missing and illiquid data", () => {
    const markets = [
      market("SOL", { status: "inactive" }),
      market("DOGE"),
      market("ADA"),
      market("LINK"),
      market("TRX", { quote: "BTC" }),
      market("XRP"),
    ];
    const ticks = [
      ticker("DOGE-USDT", { observedAt: "2026-10-03T09:55:00.000Z" }),
      ticker("ADA-USDT", { quoteVolume24h: "1" }),
      ticker("TRX-USDT"),
      ticker("XRP-USDT", { bid: "101", ask: "100" }),
    ];
    const result = scanTradingMarkets(markets, ticks, policy, NOW);
    expect(result.candidates).toEqual([]);
    expect(result.excluded.map((item) => item.reason)).toEqual([
      "inactive",
      "stale_or_future_data",
      "insufficient_volume",
      "missing_ticker",
      "quote_not_allowed",
      "invalid_book",
    ]);
  });

  it("excludes costly spread and future or cached observations", () => {
    const markets = [market("A"), market("B"), market("C"), market("D")];
    const ticks = [
      ticker("A-USDT", { ask: "110" }),
      ticker("B-USDT", { fetchedAt: "2026-10-03T09:58:00.000Z" }),
      ticker("C-USDT", { fetchedAt: "2026-10-03T10:01:00.000Z" }),
      ticker("D-USDT", { observedAt: "2026-10-03T10:01:00.000Z" }),
    ];
    const result = scanTradingMarkets(markets, ticks, policy, NOW);
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded.map((item) => item.reason)).toEqual([
      "excessive_spread",
      "stale_or_future_data",
      "stale_or_future_data",
      "stale_or_future_data",
    ]);
  });

  it("rejects duplicated observations or market identities instead of selecting the last one", () => {
    expect(() =>
      scanTradingMarkets(
        [market("SOL")],
        [ticker("SOL-USDT"), ticker("SOL-USDT", { bid: "1", ask: "2" })],
        policy,
        NOW,
      ),
    ).toThrow("Duplicate");
    expect(() =>
      scanTradingMarkets([market("SOL"), market("SOL")], [ticker("SOL-USDT")], policy, NOW),
    ).toThrow("Duplicate");
  });

  it("rejects unsafe policy instead of silently weakening filters", () => {
    expect(() => scanTradingMarkets([], [], { ...policy, maxDataAgeMs: 0 }, NOW)).toThrow();
    expect(() => scanTradingMarkets([], [], { ...policy, maxSpreadBps: NaN }, NOW)).toThrow();
    expect(() => scanTradingMarkets([], [], { ...policy, allowedQuotes: [] }, NOW)).toThrow();
  });
});
