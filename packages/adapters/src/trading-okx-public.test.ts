import { describe, expect, it, vi } from "vitest";
import { fetchOkxPublicCatalog, fetchOkxPublicSpotTickers } from "./trading-okx-public.js";

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

  it("rejects malformed known-market quotes and duplicate spot ticker observations", async () => {
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
    ).rejects.toThrow();
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
