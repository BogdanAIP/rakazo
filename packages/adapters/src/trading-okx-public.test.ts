import { describe, expect, it, vi } from "vitest";
import { fetchOkxPublicCatalog, fetchOkxPublicPerpetualTickers, fetchOkxPublicSpotTickers } from "./trading-okx-public.js";

const now = new Date("2026-10-03T10:00:00.000Z");
const futureExpiry = "1798790400000";
function spot(data: Record<string, unknown> = {}) {
  return {
    instType: "SPOT",
    instId: "SOL-USDT",
    state: "live",
    ruleType: "normal",
    baseCcy: "SOL",
    quoteCcy: "USDT",
    tickSz: "0.01",
    lotSz: "0.001",
    minSz: "0.01",
    expTime: "",
    ...data,
  };
}
function swap(data: Record<string, unknown> = {}) {
  return {
    instType: "SWAP",
    instId: "DOGE-USDT-SWAP",
    instFamily: "DOGE-USDT",
    state: "live",
    ruleType: "normal",
    tickSz: "0.0001",
    lotSz: "1",
    expTime: "",
    ...data,
  };
}
function future(data: Record<string, unknown> = {}) {
  return {
    instType: "FUTURES",
    instId: "ETH-USDT-270101",
    instFamily: "ETH-USDT",
    state: "live",
    ruleType: "normal",
    tickSz: "0.01",
    lotSz: "0.1",
    expTime: futureExpiry,
    ...data,
  };
}
function wrap(data: unknown[], code = "0") {
  return { code, data };
}
function transport(responses: unknown[]) {
  const values = [...responses];
  const mock = vi.fn(async (_url: unknown, _opts: unknown) => {
    const value = values.shift();
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}
function run(responses: unknown[]) {
  return fetchOkxPublicCatalog({ now, fetchImpl: transport(responses).fetchImpl });
}

describe("read-only OKX public catalog", () => {
  it("discovers altcoin spot, perps and dated futures with three fixed GETs", async () => {
    const fake = transport([
      wrap([spot(), spot({ instId: "OLD-USDT", baseCcy: "OLD", state: "preopen", tickSz: "" })]),
      wrap([swap()]),
      wrap([future()]),
    ]);
    const result = await fetchOkxPublicCatalog({ now, fetchImpl: fake.fetchImpl });
    expect(result.markets.map((m) => [m.symbol, m.kind, m.status])).toEqual([
      ["SOL-USDT", "spot", "active"],
      ["OLD-USDT", "spot", "inactive"],
      ["DOGE-USDT-SWAP", "perpetual", "active"],
      ["ETH-USDT-270101", "dated_future", "active"],
    ]);
    expect(result.markets[3]?.expiryAt).toBe(new Date(Number(futureExpiry)).toISOString());
    expect(result.excluded).toEqual([]);
    expect(fake.mock).toHaveBeenCalledTimes(3);
    expect(fake.mock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://www.okx.com/api/v5/public/instruments?instType=SPOT",
      "https://www.okx.com/api/v5/public/instruments?instType=SWAP",
      "https://www.okx.com/api/v5/public/instruments?instType=FUTURES",
    ]);
    for (const call of fake.mock.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(JSON.stringify(options.headers)).not.toMatch(/key|secret|signature|authorization/i);
    }
    expect("tickers" in result).toBe(false);
  });

  it("separately rejects premarket X-perps, stale contracts and incomplete metadata", async () => {
    const result = await run([
      wrap([spot({ tickSz: "", state: "live" })]),
      wrap([swap({ instId: "DOGE-USDT-BROKEN" })]),
      wrap([
        future({ ruleType: "xperp" }),
        future({ expTime: "1700000000000", instId: "ETH-USDT-OLD" }),
        future({ instId: "ETH-USDT-NOEXP", expTime: "" }),
      ]),
    ]);
    expect(result.markets).toEqual([]);
    expect(result.excluded.map((x) => x.reason)).toEqual([
      "incomplete_metadata",
      "incomplete_metadata",
      "pre_market_or_special_contract",
      "expired_contract",
      "incomplete_metadata",
    ]);
  });

  it("fails closed on failed responses, mixed types and duplicate identifiers", async () => {
    await expect(run([wrap([], "50001")])).rejects.toThrow("API error");
    await expect(run([new Response("not-json")])).rejects.toThrow("not JSON");
    await expect(run([new Response("busy", { status: 503 })])).rejects.toThrow("HTTP error");
    const mismatch = await run([wrap([swap()]), wrap([]), wrap([])]);
    expect(mismatch.excluded.map((x) => x.reason)).toEqual(["incomplete_metadata"]);
    await expect(run([wrap([spot(), spot()]), wrap([]), wrap([])])).rejects.toThrow("Duplicate");
  });

  it("uses OKX spot quote-currency turnover and rejects derivative input", async () => {
    const catalog = await run([wrap([spot()]), wrap([swap()]), wrap([future()])]);
    const fake = transport([
      wrap([
        {
          instType: "SPOT",
          instId: "SOL-USDT",
          bidPx: "100",
          askPx: "100.1",
          volCcy24h: "1234567.89",
          vol24h: "1000",
          ts: String(now.getTime()),
        },
        {
          instType: "SPOT",
          instId: "UNKNOWN-USDT",
          bidPx: "1",
          askPx: "1.1",
          volCcy24h: "50",
          vol24h: "100",
          ts: String(now.getTime()),
        },
      ]),
    ]);
    const spotMarkets = catalog.markets.filter((market) => market.kind === "spot");
    const tickers = await fetchOkxPublicSpotTickers(spotMarkets, {
      fetchImpl: fake.fetchImpl,
      now,
    });
    expect(tickers).toHaveLength(1);
    expect(tickers[0]?.quoteVolume24h).toBe("1234567.89");
    expect(fake.mock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
    ]);
    await expect(
      fetchOkxPublicSpotTickers(catalog.markets, { fetchImpl: fake.fetchImpl, now }),
    ).rejects.toThrow("spot markets only");
  });

  it("excludes absent books and rejects duplicate spot ticker observations", async () => {
    const markets = (await run([wrap([spot()]), wrap([]), wrap([])])).markets;
    await expect(
      fetchOkxPublicSpotTickers(markets, {
        now,
        fetchImpl: transport([
          wrap([
            {
              instType: "SPOT",
              instId: "SOL-USDT",
              bidPx: "",
              askPx: "1",
              volCcy24h: "10",
              ts: String(now.getTime()),
            },
          ]),
        ]).fetchImpl,
      }),
    ).resolves.toEqual([]);
    const duplicate = {
      instType: "SPOT",
      instId: "SOL-USDT",
      bidPx: "1",
      askPx: "1.1",
      volCcy24h: "100",
      ts: String(now.getTime()),
    };
    await expect(
      fetchOkxPublicSpotTickers(markets, {
        now,
        fetchImpl: transport([wrap([duplicate, duplicate])]).fetchImpl,
      }),
    ).rejects.toThrow("Duplicate");
  });
});

describe("OKX public book availability", () => {
  it("keeps the selected market when another active instrument has an empty or zero book", async () => {
    const markets = (
      await run([
        wrap([
          spot(),
          spot({ instId: "EMPTY-USDT", baseCcy: "EMPTY" }),
          spot({ instId: "ZERO-USDT", baseCcy: "ZERO" }),
        ]),
        wrap([]),
        wrap([]),
      ])
    ).markets;
    const base = { instType: "SPOT", volCcy24h: "100", ts: String(now.getTime()) };
    const result = await fetchOkxPublicSpotTickers(markets, {
      now,
      fetchImpl: transport([
        wrap([
          { ...base, instId: "EMPTY-USDT", bidPx: "", askPx: "" },
          { ...base, instId: "ZERO-USDT", bidPx: "0", askPx: "0.00" },
          { ...base, instId: "SOL-USDT", bidPx: "100", askPx: "100.1" },
        ]),
      ]).fetchImpl,
    });
    expect(result.map((ticker) => ticker.symbol)).toEqual(["SOL-USDT"]);
  });

  it("does not turn negative or malformed prices into an available quote", async () => {
    const markets = (await run([wrap([spot()]), wrap([]), wrap([])])).markets;
    for (const bidPx of ["-1", "not-a-price"]) {
      await expect(
        fetchOkxPublicSpotTickers(markets, {
          now,
          fetchImpl: transport([
            wrap([
              {
                instType: "SPOT",
                instId: "SOL-USDT",
                bidPx,
                askPx: "100.1",
                volCcy24h: "100",
                ts: String(now.getTime()),
              },
            ]),
          ]).fetchImpl,
        }),
      ).rejects.toThrow();
    }
  });
});

describe("OKX USDT perpetual liquidity prefilter", () => {
  it("reuses public SWAP tickers and converts base turnover to estimated quote turnover", async () => {
    const markets = (await run([wrap([]), wrap([swap()]), wrap([])])).markets;
    const fake = transport([
      wrap([
        {
          instType: "SWAP",
          instId: "DOGE-USDT-SWAP",
          bidPx: "0.10",
          askPx: "0.101",
          volCcy24h: "2000000",
          ts: String(now.getTime()),
        },
        {
          instType: "SWAP",
          instId: "UNKNOWN-USDT-SWAP",
          bidPx: "1",
          askPx: "1.1",
          volCcy24h: "10",
          ts: String(now.getTime()),
        },
      ]),
    ]);
    const result = await fetchOkxPublicPerpetualTickers(markets, {
      now,
      fetchImpl: fake.fetchImpl,
    });
    expect(result).toMatchObject([
      { venue: "okx", kind: "perpetual", symbol: "DOGE-USDT-SWAP", quoteVolume24h: "201000.00" },
    ]);
    expect(fake.mock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://www.okx.com/api/v5/market/tickers?instType=SWAP",
    ]);
    await expect(
      fetchOkxPublicPerpetualTickers(
        [...markets, { ...markets[0]!, quote: "USD", symbol: "BTC-USD-SWAP" }],
        { now, fetchImpl: fake.fetchImpl },
      ),
    ).rejects.toThrow("USDT perpetuals only");
  });

  it("skips unusable books and rejects duplicates or incompatible ticker types", async () => {
    const markets = (await run([wrap([]), wrap([swap()]), wrap([])])).markets;
    const base = {
      instType: "SWAP",
      instId: "DOGE-USDT-SWAP",
      volCcy24h: "10000",
      ts: String(now.getTime()),
    };
    await expect(
      fetchOkxPublicPerpetualTickers(markets, {
        now,
        fetchImpl: transport([wrap([{ ...base, bidPx: "", askPx: "0.1" }])]).fetchImpl,
      }),
    ).resolves.toEqual([]);
    await expect(
      fetchOkxPublicPerpetualTickers(markets, {
        now,
        fetchImpl: transport([
          wrap([
            { ...base, bidPx: "0.1", askPx: "0.11" },
            { ...base, bidPx: "0.1", askPx: "0.11" },
          ]),
        ]).fetchImpl,
      }),
    ).rejects.toThrow("Duplicate");
    await expect(
      fetchOkxPublicPerpetualTickers(markets, {
        now,
        fetchImpl: transport([wrap([{ ...base, instType: "SPOT", bidPx: "0.1", askPx: "0.11" }])])
          .fetchImpl,
      }),
    ).rejects.toThrow("Mismatched OKX ticker type");
  });
});
