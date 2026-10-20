import type { TradingCandle } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { reviewPaperOfflineH1 } from "./trading-paper-offline-gap.js";

const clock = "2026-10-19T00:00:00.000Z";
const ts = (hour: number) => new Date(Date.parse(clock) + hour * 3_600_000).toISOString();
function candle(hour: number, high = "105", low = "101"): TradingCandle {
  return {
    venue: "okx",
    kind: "perpetual",
    symbol: "SOL-USDT-SWAP",
    openedAt: ts(hour),
    durationMs: 3_600_000,
    open: "103",
    high,
    low,
    close: "103",
    quoteVolume: "50000",
    confirmed: true,
  };
}
const sample = (candles: readonly TradingCandle[], onlineAt = ts(3), offlineAt = ts(0)) => ({
  offlineAt,
  onlineAt,
  instrument: "SOL-USDT-SWAP",
  side: "short" as const,
  stopPriceQuote: "106.80",
  takeProfitPriceQuote: "98.80",
  candles,
});

describe("PAPER offline H1 historical evidence is NOT virtual execution", () => {
  it("reports complete untouched history without claiming a stop or funding", () => {
    const result = reviewPaperOfflineH1(sample([candle(0), candle(1), candle(2)]));
    expect(result).toMatchObject({
      status: "no_threshold_observed",
      barsReviewed: 3,
      executionVerified: false,
      fundingReviewRequired: true,
      newEntriesAuthorized: false,
    });
  });
  it("flags a possible stop crossing but does not invent fill price", () => {
    const r = reviewPaperOfflineH1(sample([candle(0), candle(1, "108"), candle(2)]));
    expect(r.status).toBe("stop_possible");
    expect(r.executionVerified).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/fillPrice|executedAt/);
  });
  it("flags stop and target in the same closed hour as ambiguous", () => {
    expect(
      reviewPaperOfflineH1(sample([candle(0), candle(1, "108", "97"), candle(2)])).status,
    ).toBe("both_possible");
  });
  it("treats partial-window wick crossing as ambiguous timing", () => {
    expect(
      reviewPaperOfflineH1(
        sample(
          [candle(0, "109"), candle(1), candle(2)],
          ts(3),
          new Date(Date.parse(ts(0)) + 20_000).toISOString(),
        ),
      ).status,
    ).toBe("window_ambiguous");
  });
  it("fails closed for a missing hour, unconfirmed candle or wrong instrument", () => {
    expect(reviewPaperOfflineH1(sample([candle(0), candle(2)])).status).toBe("history_incomplete");
    expect(
      reviewPaperOfflineH1(
        sample([
          candle(0),
          { ...candle(1), confirmed: false } as unknown as TradingCandle,
          candle(2),
        ]),
      ).status,
    ).toBe("history_incomplete");
    expect(
      reviewPaperOfflineH1(
        sample([candle(0), { ...candle(1), symbol: "BTC-USDT-SWAP" }, candle(2)]),
      ).status,
    ).toBe("history_incomplete");
  });
  it("rejects repeated or overlapping H1 candles", () => {
    const result = reviewPaperOfflineH1(sample([candle(0), candle(1), candle(1), candle(2)]));
    expect(result.status).toBe("history_incomplete");
  });
  it("rejects history from a different venue, even with the same symbol", () => {
    const falseVenue = { ...candle(1), venue: "bingx" } as unknown as TradingCandle;
    expect(reviewPaperOfflineH1(sample([candle(0), falseVenue, candle(2)])).status).toBe(
      "history_incomplete",
    );
  });
  it("does not infer any fills from stale or future gaps", () => {
    const r = reviewPaperOfflineH1(sample([candle(0), candle(1)], ts(3)));
    expect(r.status).toBe("history_incomplete");
    expect(r.executionVerified).toBe(false);
    expect(r.newEntriesAuthorized).toBe(false);
  });
  it("rejects invalid time ranges and inverted protective geometry", () => {
    expect(() => reviewPaperOfflineH1(sample([candle(0)], ts(0)))).toThrow();
    expect(() =>
      reviewPaperOfflineH1({
        ...sample([candle(0)]),
        stopPriceQuote: "96",
      }),
    ).toThrow("geometry");
  });
});
