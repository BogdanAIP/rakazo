import { TradingInstrumentSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { fetchOkxPublicPerpContext } from "./trading-okx-perp.js";

const now = new Date("2026-10-03T10:15:00.000Z");
const market = TradingInstrumentSchema.parse({
  venue: "okx",
  kind: "perpetual",
  symbol: "SOL-USDT-SWAP",
  base: "SOL",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.01",
  quantityIncrement: "1",
  minNotional: null,
  expiryAt: null,
});
const funding = {
  instType: "SWAP",
  instId: market.symbol,
  fundingRate: "-0.0001",
  fundingTime: String(now.getTime() + 8 * 3_600_000),
  nextFundingRate: "0.00005",
  nextFundingTime: String(now.getTime() + 16 * 3_600_000),
};
const interest = {
  instType: "SWAP",
  instId: market.symbol,
  oi: "1200",
  oiCcy: "120",
  oiUsd: "14876543.21",
  ts: String(now.getTime()),
};
const marked = {
  instType: "SWAP",
  instId: market.symbol,
  markPx: "108.50",
  ts: String(now.getTime()),
};
const wrap = (data: unknown, code = "0") => ({ code, data: [data] });
function mocked(rows: unknown[]) {
  const list = [...rows];
  const mock = vi.fn(async (_url: unknown, _opts: unknown) => {
    const value = list.shift();
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}
function call(
  rows: unknown[],
  requested = market,
) {
  return fetchOkxPublicPerpContext(requested, {
    now,
    fetchImpl: mocked(rows).fetchImpl,
  });
}

describe("keyless OKX perpetual risk telemetry", () => {
  it("preserves signed funding, OI units and mark timestamps in only three fixed GETs", async () => {
    const fake = mocked([wrap(funding), wrap(interest), wrap(marked)]);
    const result = await fetchOkxPublicPerpContext(market, {
      now,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.funding.ratePerSettlement).toBe("-0.0001");
    expect(result.funding.nextIndicativeRate).toBe("0.00005");
    expect(result.openInterest.contracts).toBe("1200");
    expect(result.openInterest.baseUnits).toBe("120");
    expect(result.openInterest.usdNotional).toBe("14876543.21");
    expect(result.mark.price).toBe("108.50");
    expect(fake.mock.mock.calls.map((row) => String(row[0]))).toEqual([
      "https://www.okx.com/api/v5/public/funding-rate?instId=SOL-USDT-SWAP",
      "https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=SOL-USDT-SWAP",
      "https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=SOL-USDT-SWAP",
    ]);
    for (const row of fake.mock.mock.calls) {
      const options = row[1] as RequestInit;
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(JSON.stringify(options.headers)).not.toMatch(/api.?key|authorization|signature/i);
    }
    expect("order" in result).toBe(false);
  });

  it("treats unavailable next-period funding as unknown, not zero", async () => {
    const result = await call([
      wrap({ ...funding, nextFundingRate: "", nextFundingTime: "" }),
      wrap(interest),
      wrap(marked),
    ]);
    expect(result.funding.nextIndicativeRate).toBeNull();
    expect(result.funding.nextSettlementAt).toBeNull();
  });

  it("refuses mismatched, stale and implausible telemetry", async () => {
    await expect(call([
      wrap(funding),
      wrap({ ...interest, instId: "BTC-USDT-SWAP" }),
      wrap(marked),
    ])).rejects.toThrow("mismatch");
    await expect(call([
      wrap(funding),
      wrap({ ...interest, ts: String(now.getTime() - 300_000) }),
      wrap(marked),
    ])).rejects.toThrow("Stale");
    await expect(call([
      wrap(funding),
      wrap({ ...interest, oiUsd: "-10" }),
      wrap(marked),
    ])).rejects.toThrow();
    await expect(call([
      wrap({ ...funding, fundingTime: String(now.getTime() - 300_000) }),
      wrap(interest),
      wrap(marked),
    ])).rejects.toThrow("Stale");
    await expect(call([
      wrap(funding),
      wrap(interest),
      wrap({ ...marked, markPx: "0" }),
    ])).rejects.toThrow();
  });

  it("rejects API failure and non-perpetual instruments before account access", async () => {
    await expect(call([wrap(funding, "50001")])).rejects.toThrow("API error");
    await expect(call([new Response("not-json")])).rejects.toThrow("not JSON");
    await expect(call([new Response("busy", { status: 503 })])).rejects.toThrow("HTTP error");
    await expect(call([wrap(funding)], { ...market, kind: "spot" })).rejects.toThrow("perpetuals");
  });
});
