import {
  TradingCandleSchema,
  TradingHistoryCaptureSchema,
  TradingInstrumentSchema,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildVerifiedTradingHistoryDataset,
  captureOkxClosedHistoryDataset,
  replayVerifiedSpotDataset,
  verifyTradingHistoryDataset,
} from "./trading-history-dataset.js";

const retrievedAt = "2026-10-04T08:00:00.000Z";
const opened0 = Date.UTC(2026, 9, 2, 12);
const market = TradingInstrumentSchema.parse({
  venue: "okx",
  kind: "spot",
  symbol: "SOL-USDT",
  base: "SOL",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.01",
  quantityIncrement: "0.01",
  minNotional: "5",
  expiryAt: null,
});
function candles() {
  return Array.from({ length: 22 }, (_, i) =>
    TradingCandleSchema.parse({
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      openedAt: new Date(opened0 + i * 3_600_000).toISOString(),
      durationMs: 3_600_000,
      ...(i < 20
        ? { open: "97", high: "100", low: "95", close: "98", quoteVolume: "100" }
        : i === 20
          ? { open: "99", high: "110", low: "98", close: "108", quoteVolume: "200" }
          : { open: "108", high: "125", low: "99", close: "115", quoteVolume: "100" }),
      confirmed: true,
    }),
  );
}
const capture = (change: Record<string, unknown> = {}) =>
  TradingHistoryCaptureSchema.parse({
    source: "okx_public_history_candles",
    market,
    retrievedAt,
    candles: candles(),
    ...change,
  });
const settings = {
  initialBalanceQuote: "2000",
  fixedNotionalQuote: "1000",
  feeBpsPerSide: 10,
  adverseSlippageBpsPerSide: 10,
  maxEntryGapBps: 100,
};

describe("normalized historical snapshot integrity", () => {
  it("computes stable SHA from canonical parsed values regardless of object field order", () => {
    const a = buildVerifiedTradingHistoryDataset(capture());
    const b = buildVerifiedTradingHistoryDataset(
      capture({
        market: Object.fromEntries(Object.entries(market).reverse()),
        candles: candles().map((bar) => Object.fromEntries(Object.entries(bar).reverse())),
      }),
    );
    expect(a.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.datasetSha256).toBe(b.datasetSha256);
    expect(a.canonicalByteLength).toBe(b.canonicalByteLength);
    expect(a.eligibleForSpotWalkforward).toBe(true);
    expect(a.totalMissingBars).toBe(0);
    expect(verifyTradingHistoryDataset(a)).toEqual(a);
  });

  it("detects raw candle/provenance changes and forged computed coverage", () => {
    const a = buildVerifiedTradingHistoryDataset(capture());
    const altered = candles();
    altered[0] = TradingCandleSchema.parse({ ...altered[0], close: "99" });
    const b = buildVerifiedTradingHistoryDataset(capture({ candles: altered }));
    expect(a.datasetSha256).not.toBe(b.datasetSha256);
    expect(() => verifyTradingHistoryDataset({ ...a, candles: altered })).toThrow("integrity");
    expect(() =>
      verifyTradingHistoryDataset({ ...a, retrievedAt: "2026-10-04T08:01:00.000Z" }),
    ).toThrow("integrity");
    expect(() => verifyTradingHistoryDataset({ ...a, totalMissingBars: 3 })).toThrow("integrity");
    expect(() => verifyTradingHistoryDataset({ ...a, eligibleForSpotWalkforward: false })).toThrow(
      "integrity",
    );
  });

  it("preserves holes rather than filling candles or emitting backtest results", () => {
    const missing = candles().filter((_, i) => i !== 9);
    const dataset = buildVerifiedTradingHistoryDataset(capture({ candles: missing }));
    expect(dataset.candles).toHaveLength(21);
    expect(dataset.gapRanges).toEqual([
      {
        afterOpenedAt: new Date(opened0 + 8 * 3_600_000).toISOString(),
        beforeOpenedAt: new Date(opened0 + 10 * 3_600_000).toISOString(),
        missingBars: 1,
      },
    ]);
    expect(dataset.totalMissingBars).toBe(1);
    expect(dataset.eligibleForSpotWalkforward).toBe(false);
    expect(() => replayVerifiedSpotDataset(dataset, settings)).toThrow("not eligible");
  });

  it("rejects duplicate/reordered, foreign, future and incomplete records", () => {
    const dup = candles();
    dup[10] = dup[9]!;
    expect(() => buildVerifiedTradingHistoryDataset(capture({ candles: dup }))).toThrow(
      "uniquely ascending",
    );
    const mixed = candles();
    mixed[4] = TradingCandleSchema.parse({ ...mixed[4], symbol: "BTC-USDT" });
    expect(() => buildVerifiedTradingHistoryDataset(capture({ candles: mixed }))).toThrow(
      "identity",
    );
    expect(() =>
      buildVerifiedTradingHistoryDataset(capture({ retrievedAt: new Date(opened0).toISOString() })),
    ).toThrow("Unclosed");
    expect(() => capture({ candles: [{ ...candles()[0], confirmed: false }] })).toThrow();
  });

  it("retains an inactive/delisted-at-capture archive but never silently treats it as tradable", () => {
    const archived = buildVerifiedTradingHistoryDataset(
      capture({ market: { ...market, status: "inactive" } }),
    );
    const active = buildVerifiedTradingHistoryDataset(capture());
    expect(archived.market.status).toBe("inactive");
    expect(archived.eligibleForSpotWalkforward).toBe(false);
    expect(archived.datasetSha256).not.toBe(active.datasetSha256);
    expect(() => replayVerifiedSpotDataset(archived, settings)).toThrow("not eligible");
  });

  it("feeds verified digest through the existing conservative candle backtester", () => {
    const dataset = buildVerifiedTradingHistoryDataset(capture());
    const result = replayVerifiedSpotDataset(dataset, settings);
    expect(result.datasetSha256).toBe(dataset.datasetSha256);
    expect(result.replay?.datasetSha256).toBe(dataset.datasetSha256);
    expect(result.executions[0]?.exitReason).toBe("stop");
    expect(result.replay?.netPnlQuote).toBeLessThan(0);
  });

  it("constructs a dataset via exactly one keyless public OKX history GET", async () => {
    const data = candles()
      .reverse()
      .map((c) => [
        String(Date.parse(c.openedAt)),
        c.open,
        c.high,
        c.low,
        c.close,
        "1",
        "1",
        c.quoteVolume,
        "1",
      ]);
    const mock = vi.fn(
      async (_url: unknown, _options: unknown) =>
        new Response(JSON.stringify({ code: "0", data }), { status: 200 }),
    );
    const result = await captureOkxClosedHistoryDataset(market, {
      fetchImpl: mock as unknown as typeof fetch,
      now: new Date(retrievedAt),
    });
    expect(result.candles).toHaveLength(22);
    expect(result.source).toBe("okx_public_history_candles");
    expect(result.datasetSha256).toBe(verifyTradingHistoryDataset(result).datasetSha256);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0]?.[0])).toBe(
      "https://www.okx.com/api/v5/market/history-candles?instId=SOL-USDT&bar=1H&limit=100",
    );
    const req = mock.mock.calls[0]?.[1] as RequestInit;
    expect(req.method).toBe("GET");
    expect(req.redirect).toBe("error");
    expect(JSON.stringify(req.headers)).not.toMatch(/authorization|api.?key|signature/i);
  });
});
