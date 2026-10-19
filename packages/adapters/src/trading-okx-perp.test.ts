import { TradingInstrumentSchema } from "@rakazo/contracts";
import { evaluatePaperLeverage } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { fetchOkxPaperPerpetualSnapshot, fetchOkxPublicPerpContext } from "./trading-okx-perp.js";

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
function call(rows: unknown[], requested = market) {
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
    await expect(
      call([wrap(funding), wrap({ ...interest, instId: "BTC-USDT-SWAP" }), wrap(marked)]),
    ).rejects.toThrow("mismatch");
    await expect(
      call([
        wrap(funding),
        wrap({ ...interest, ts: String(now.getTime() - 300_000) }),
        wrap(marked),
      ]),
    ).rejects.toThrow("Stale");
    await expect(
      call([wrap(funding), wrap({ ...interest, oiUsd: "-10" }), wrap(marked)]),
    ).rejects.toThrow();
    await expect(
      call([
        wrap({ ...funding, fundingTime: String(now.getTime() - 300_000) }),
        wrap(interest),
        wrap(marked),
      ]),
    ).rejects.toThrow("Stale");
    await expect(
      call([wrap(funding), wrap(interest), wrap({ ...marked, markPx: "0" })]),
    ).rejects.toThrow();
  });

  it("rejects API failure and non-perpetual instruments before account access", async () => {
    await expect(call([wrap(funding, "50001")])).rejects.toThrow("API error");
    await expect(call([new Response("not-json")])).rejects.toThrow("not JSON");
    await expect(call([new Response("busy", { status: 503 })])).rejects.toThrow("HTTP error");
    await expect(call([wrap(funding)], { ...market, kind: "spot" })).rejects.toThrow("perpetuals");
  });
});

describe("PAPER OKX contract units and funding history", () => {
  function publicFixture(change?: (path: string, rows: unknown[]) => unknown[]) {
    const mock = vi.fn(async (url: unknown, opts: RequestInit) => {
      const u = new URL(String(url));
      expect(u.origin).toBe("https://www.okx.com");
      expect(opts.method).toBe("GET");
      expect(JSON.stringify(opts.headers)).not.toMatch(/authorization|signature|api.?key/i);
      const path = u.pathname;
      let rows: unknown[];
      if (path.endsWith("/instruments"))
        rows = [
          {
            instId: market.symbol,
            instType: "SWAP",
            state: "live",
            ruleType: "normal",
            settleCcy: "USDT",
            ctType: "linear",
            ctValCcy: "SOL",
            ctVal: "0.1",
            ctMult: "1",
            lotSz: "0.01",
            minSz: "0.01",
            tickSz: "0.01",
          },
        ];
      else if (path.endsWith("/books"))
        rows = [
          {
            ts: String(now.getTime()),
            bids: [["108", "2", "0", "1"]],
            asks: [["109", "3", "0", "1"]],
          },
        ];
      else if (path.endsWith("/position-tiers"))
        rows = [{ tier: "1", minSz: "0", maxSz: "10000", mmr: "0.004", maxLever: "100" }];
      else if (path.endsWith("/funding-rate-history"))
        rows = [
          {
            instId: market.symbol,
            instType: "SWAP",
            fundingTime: String(now.getTime() - 3600000),
            fundingRate: "0.9",
            realizedRate: "-0.000000001",
          },
        ];
      else if (path.endsWith("/funding-rate")) rows = [funding];
      else if (path.endsWith("/open-interest")) rows = [interest];
      else if (path.endsWith("/mark-price")) rows = [marked];
      else if (path.endsWith("/history-candles"))
        rows = [
          [
            String(Math.floor(now.getTime() / 3600000) * 3600000 - 3600000),
            "100",
            "110",
            "99",
            "108",
            "10",
            "1",
            "1000",
            "1",
          ],
        ];
      else throw new Error("Unexpected public fixture");
      return Response.json({ code: "0", data: change ? change(path, rows) : rows });
    });
    return { mock, fetchImpl: mock as unknown as typeof fetch };
  }
  it("keeps protective prices, terms and funding available without requesting research history", async () => {
    const fake = publicFixture();
    let historyRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/history-candles")) {
        historyRequests++;
        return new Response("rate limited", { status: 429 });
      }
      return fake.fetchImpl(url, init);
    };
    const result = await fetchOkxPaperPerpetualSnapshot(market.symbol, {
      now,
      fetchImpl,
      history: "omit",
    });
    expect(result.history).toEqual([]);
    expect(result.book).toMatchObject({ bidQuote: "108", askQuote: "109" });
    expect(result.markPriceQuote).toBe(marked.markPx);
    expect(result.funding).toHaveLength(1);
    expect(historyRequests).toBe(0);
    await expect(
      fetchOkxPaperPerpetualSnapshot(market.symbol, {
        now,
        fetchImpl,
      }),
    ).rejects.toThrow("history HTTP error: 429");
    expect(historyRequests).toBe(1);
  });

  it("still rejects stale executable observations when research history is omitted", async () => {
    const fake = publicFixture((path, rows) =>
      path.endsWith("/books")
        ? [{ ...(rows[0] as object), ts: String(now.getTime() - 300_000) }]
        : rows,
    );
    await expect(
      fetchOkxPaperPerpetualSnapshot(market.symbol, {
        now,
        fetchImpl: fake.fetchImpl,
        history: "omit",
      }),
    ).rejects.toThrow("Stale");
  });

  it("converts lot, minimum and visible depth from contracts to base; uses final realized funding", async () => {
    const fake = publicFixture();
    const result = await fetchOkxPaperPerpetualSnapshot(market.symbol, {
      now,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.rules).toMatchObject({
      basePerContract: "0.1",
      lotIncrementBase: "0.001",
      minimumBase: "0.001",
      maxTierBase: "1000",
      maintenanceMarginBps: 40,
    });
    expect(result.book.bidAvailableBase).toBe("0.2");
    expect(result.book.askAvailableBase).toBe("0.3");
    expect(result.funding[0]).toMatchObject({
      rateSigned: "-0.000000001",
      priceBasis: "latest_observed_mark_simulation",
    });
    expect(result.history).toHaveLength(1);
    expect(fake.mock.mock.calls).toHaveLength(8);
  });
  it("normalizes inclusive OKX tiers separated by exactly one tradable lot", async () => {
    const fake = publicFixture((path, rows) =>
      path.endsWith("/position-tiers")
        ? [rows[0], { tier: "2", minSz: "10000.01", maxSz: "50000", mmr: "0.01", maxLever: "50" }]
        : rows,
    );
    const result = await fetchOkxPaperPerpetualSnapshot(market.symbol, {
      now,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.leverageLimits!.tiers[1]!.minQuantityBase).toBe("1000");
    const input = {
      venue: "okx" as const,
      instrument: market.symbol,
      marginMode: "cross" as const,
      requestedLeverage: 20,
      ownerMaxLeverage: 100,
      existingQuantityBase: "0",
      proposedQuantityBase: "0.1",
      limits: result.leverageLimits ?? null,
      now: now.toISOString(),
    };
    expect(evaluatePaperLeverage(input)).toMatchObject({ status: "allowed" });
    expect(
      evaluatePaperLeverage({ ...input, requestedLeverage: 51, proposedQuantityBase: "1000" }),
    ).toEqual({ status: "deny", reason: "leverage_exceeded" });
  });
  it("rejects tier gaps larger than one lot and overlapping tier ranges", async () => {
    for (const minSz of ["10000.02", "9999.99"]) {
      const fake = publicFixture((path, rows) =>
        path.endsWith("/position-tiers")
          ? [rows[0], { tier: "2", minSz, maxSz: "50000", mmr: "0.01", maxLever: "50" }]
          : rows,
      );
      await expect(
        fetchOkxPaperPerpetualSnapshot(market.symbol, { now, fetchImpl: fake.fetchImpl }),
      ).rejects.toThrow("Non-contiguous perpetual position tiers");
    }
  });
  it("retries one transient public transport failure with a fresh timeout signal", async () => {
    for (const endpoint of ["/books", "/history-candles", "/mark-price"]) {
      const fake = publicFixture();
      const signals: Array<AbortSignal | null | undefined> = [];
      const fetchImpl: typeof fetch = async (url, init) => {
        if (new URL(String(url)).pathname.endsWith(endpoint)) {
          signals.push(init?.signal);
          if (signals.length === 1)
            throw new DOMException("Transient public timeout", "TimeoutError");
        }
        return fake.fetchImpl(url, init);
      };
      const result = await fetchOkxPaperPerpetualSnapshot(market.symbol, { now, fetchImpl });
      expect(result.market.symbol).toBe(market.symbol);
      expect(signals).toHaveLength(2);
      expect(signals[1]).not.toBe(signals[0]);
    }
  });
  it("bounds persistent transport failures to two attempts", async () => {
    const fake = publicFixture();
    let attempts = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/books")) {
        attempts += 1;
        throw new DOMException("Public timeout", "TimeoutError");
      }
      return fake.fetchImpl(url, init);
    };
    await expect(fetchOkxPaperPerpetualSnapshot(market.symbol, { now, fetchImpl })).rejects.toThrow(
      "Public timeout",
    );
    expect(attempts).toBe(2);
  });
  it("accepts bounded public book/mark skew and rejects the exact out-of-range boundaries", async () => {
    for (const shift of [1500, 2000, -30000]) {
      const fake = publicFixture((path, rows) =>
        path.endsWith("/books") || path.endsWith("/mark-price")
          ? [{ ...(rows[0] as object), ts: String(now.getTime() + shift) }]
          : rows,
      );
      const result = await fetchOkxPaperPerpetualSnapshot(market.symbol, {
        now,
        fetchImpl: fake.fetchImpl,
      });
      expect(result.book.observedAt).toBe(new Date(now.getTime() + shift).toISOString());
      expect(result.markObservedAt).toBe(new Date(now.getTime() + shift).toISOString());
    }
    for (const shift of [2001, -30001]) {
      for (const endpoint of ["/books", "/mark-price"]) {
        const fake = publicFixture((path, rows) =>
          path.endsWith(endpoint)
            ? [{ ...(rows[0] as object), ts: String(now.getTime() + shift) }]
            : rows,
        );
        await expect(
          fetchOkxPaperPerpetualSnapshot(market.symbol, { now, fetchImpl: fake.fetchImpl }),
        ).rejects.toThrow("Stale or future");
      }
    }
  });
  it("rejects inverse/mismatched metadata, unsupported precision, stale quotes and duplicate funding", async () => {
    for (const patch of [
      { ctType: "inverse" },
      { ctValCcy: "BTC" },
      { ctVal: "0.00000001", lotSz: "0.01" },
    ]) {
      const fake = publicFixture((path, rows) =>
        path.endsWith("/instruments") ? [{ ...(rows[0] as object), ...patch }] : rows,
      );
      await expect(
        fetchOkxPaperPerpetualSnapshot(market.symbol, { now, fetchImpl: fake.fetchImpl }),
      ).rejects.toThrow();
    }
    for (const duplicate of [false, true]) {
      const fake = publicFixture((path, rows) =>
        duplicate && path.endsWith("/funding-rate-history")
          ? [...rows, ...rows]
          : !duplicate && path.endsWith("/books")
            ? [{ ...(rows[0] as object), ts: String(now.getTime() - 31000) }]
            : rows,
      );
      await expect(
        fetchOkxPaperPerpetualSnapshot(market.symbol, { now, fetchImpl: fake.fetchImpl }),
      ).rejects.toThrow();
    }
  });
});
