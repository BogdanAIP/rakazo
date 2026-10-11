import { describe, expect, it, vi } from "vitest";
import { fetchBingxPublicSpotSnapshot } from "./trading-bingx-public.js";

const now = new Date("2026-10-03T10:00:00.000Z");
const symbols = {
  code: 0,
  data: {
    symbols: [
      { symbol: "SOL-USDT", status: 1, tickSize: "0.01", stepSize: "0.001", minNotional: "5" },
      { symbol: "DOGE-USDT", status: 1, tickSize: "0.0001", stepSize: "1", minNotional: "5" },
      { symbol: "OLD-USDT", status: 0, tickSize: "0.01", stepSize: "1", minNotional: "5" },
    ],
  },
};
const tickers = {
  code: 0,
  data: [
    {
      symbol: "SOL-USDT",
      bidPrice: "99.9",
      askPrice: "100",
      quoteVolume: "2500000",
      closeTime: now.getTime(),
    },
    {
      symbol: "DOGE-USDT",
      bidPrice: "0.21",
      askPrice: "0.22",
      quoteVolume: "900000",
      closeTime: now.getTime(),
    },
    {
      symbol: "OLD-USDT",
      bidPrice: "1",
      askPrice: "1.1",
      quoteVolume: "200",
      closeTime: now.getTime(),
    },
    {
      symbol: "UNKNOWN-USDT",
      bidPrice: "1",
      askPrice: "1.1",
      quoteVolume: "200",
      closeTime: now.getTime(),
    },
  ],
};

function transport(responses: unknown[]) {
  const remaining = [...responses];
  const mock = vi.fn(async (_url: unknown, _options: unknown) => {
    const next = remaining.shift();
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}

function callWith(responses: unknown[]) {
  return fetchBingxPublicSpotSnapshot({ now, fetchImpl: transport(responses).fetchImpl });
}

describe("BingX public spot snapshot", () => {
  it("discovers altcoins using exactly two public GETs without credentials", async () => {
    const fake = transport([symbols, tickers]);
    const snapshot = await fetchBingxPublicSpotSnapshot({ fetchImpl: fake.fetchImpl, now });
    expect(snapshot.markets.map((market) => market.symbol)).toEqual([
      "SOL-USDT",
      "DOGE-USDT",
      "OLD-USDT",
    ]);
    expect(snapshot.markets[2]?.status).toBe("inactive");
    expect(snapshot.tickers.map((ticker) => ticker.symbol)).toEqual([
      "SOL-USDT",
      "DOGE-USDT",
      "OLD-USDT",
    ]);
    expect(snapshot.tickers[0]?.quoteVolume24h).toBe("2500000");
    expect(snapshot.fetchedAt).toBe(now.toISOString());
    expect(fake.mock).toHaveBeenCalledTimes(2);
    const calls = fake.mock.mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      "https://open-api.bingx.com/openApi/spot/v1/common/symbols?timestamp=" + now.getTime(),
    );
    expect(String(calls[1]?.[0])).toBe(
      "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?timestamp=" + now.getTime(),
    );
    for (const call of calls) {
      const options = call[1] as RequestInit;
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(JSON.stringify(options.headers)).not.toMatch(/api.?key|authorization|signature/i);
    }
  });

  it("rejects exchange errors, malformed status values and negative prices", async () => {
    await expect(callWith([{ code: 100410, msg: "rate limit", data: null }])).rejects.toThrow(
      "API error",
    );
    await expect(
      callWith([{ code: 0, data: { symbols: [{ symbol: "SOL-USDT", status: "unknown" }] } }]),
    ).rejects.toThrow();
    await expect(
      callWith([symbols, { code: 0, data: [{ ...tickers.data[0], bidPrice: "-5" }] }]),
    ).rejects.toThrow();
  });

  it("fails closed on HTTP errors, non-JSON and duplicate tickers", async () => {
    await expect(callWith([new Response("Unavailable", { status: 503 })])).rejects.toThrow(
      "HTTP error",
    );
    await expect(callWith([new Response("not-json", { status: 200 })])).rejects.toThrow("not JSON");
    await expect(
      callWith([symbols, { code: 0, data: [tickers.data[0], tickers.data[0]] }]),
    ).rejects.toThrow("Duplicate");
  });
});

describe("BingX catalog lifecycle and JSON float representation", () => {
  it("keeps unknown numeric lifecycle states inactive and excludes unsupported delisted aliases", async () => {
    const fixture = {
      code: 0,
      data: {
        symbols: [
          ...symbols.data.symbols,
          { ...symbols.data.symbols[0], symbol: "FUTURE-USDT", status: 5 },
          { ...symbols.data.symbols[0], symbol: "PAUSED-USDT", status: "10" },
          { ...symbols.data.symbols[0], symbol: "OTHER-USDT", status: 25 },
          { ...symbols.data.symbols[0], symbol: "TOKEN_OLD-USDT", status: 0 },
          { ...symbols.data.symbols[0], symbol: "S-USDT", status: 1 },
        ],
      },
    };
    const snapshot = await callWith([fixture, tickers]);
    expect(snapshot.markets.filter((m) => m.status === "active").map((m) => m.symbol)).toEqual([
      "SOL-USDT",
      "DOGE-USDT",
    ]);
    expect(
      snapshot.markets.filter((m) =>
        ["FUTURE-USDT", "PAUSED-USDT", "OTHER-USDT"].includes(m.symbol),
      ),
    ).toHaveLength(3);
    expect(snapshot.markets.some((m) => m.symbol.includes("_OLD") || m.symbol === "S-USDT")).toBe(
      false,
    );
  });

  it("preserves exponent notation as exact canonical decimals for metadata and quotes", async () => {
    const snapshot = await callWith([
      {
        code: 0,
        data: { symbols: [{ ...symbols.data.symbols[0], tickSize: 1e-8, stepSize: 1e-7 }] },
      },
      {
        code: 0,
        data: [{ ...tickers.data[0], bidPrice: 1.25e-8, askPrice: "1.26e-8", quoteVolume: 1e21 }],
      },
    ]);
    expect(snapshot.markets[0]).toMatchObject({
      priceIncrement: "0.00000001",
      quantityIncrement: "0.0000001",
    });
    expect(snapshot.tickers[0]).toMatchObject({
      bid: "0.0000000125",
      ask: "0.0000000126",
      quoteVolume24h: "1000000000000000000000",
    });
  });

  it("excludes absent books while still rejecting ambiguous duplicate observations", async () => {
    const empty = { ...tickers.data[0], bidPrice: null, askPrice: null };
    const snapshot = await callWith([symbols, { code: 0, data: [empty, tickers.data[1]] }]);
    expect(snapshot.tickers.map((m) => m.symbol)).toEqual(["DOGE-USDT"]);
    await expect(callWith([symbols, { code: 0, data: [empty, tickers.data[0]] }])).rejects.toThrow(
      "Duplicate",
    );
  });
});
