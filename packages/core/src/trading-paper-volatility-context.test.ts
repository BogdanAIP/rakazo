import { describe, expect, it } from "vitest";
import {
  type PaperVolatilityCandle,
  summarizePaperVolatilityContext,
} from "./trading-paper-volatility-context.js";

const candles: PaperVolatilityCandle[] = Array.from({ length: 20 }, (_, i) => ({
  openedAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
  durationMs: 3600000,
  open: "100",
  high: i === 14 ? "106" : "102",
  low: i === 15 ? "92" : "98",
  close: "100",
  confirmed: true,
}));

describe("read-only PAPER stop-wick volatility guidance", () => {
  it("measures real adverse wicks without modifying orders or claiming risk authority", () => {
    const output = summarizePaperVolatilityContext(candles);
    expect(output.status).toBe("ready");
    if (output.status !== "ready") return;
    expect(output.mode).toBe("advisory_only");
    expect(output.sampleCount).toBe(20);
    expect(output.atrPercent).toBeGreaterThan(0);
    expect(output.downsideWickP90Percent).toBeGreaterThan(0);
    expect(output.upsideWickP90Percent).toBeGreaterThan(0);
    expect(output.completeThrough).toBe("2026-10-01T20:00:00.000Z");
    expect("stopPriceQuote" in output).toBe(false);
  });

  it("does not pretend a short public history is representative", () => {
    expect(summarizePaperVolatilityContext(candles.slice(0, 5))).toMatchObject({
      status: "insufficient_history",
      required: 14,
      sampleCount: 5,
    });
  });

  it("rejects malformed or unconfirmed public candles without fabricating volatility", () => {
    for (const history of [
      candles.map((x, i) => (i === 5 ? { ...x, confirmed: false } : x)),
      candles.map((x, i) => (i === 5 ? { ...x, low: "105" } : x)),
      candles.map((x, i) => (i === 5 ? { ...x, close: "NaN" } : x)),
      candles.map((x, i) => (i === 5 ? { ...x, openedAt: candles[0]!.openedAt } : x)),
    ]) {
      expect(summarizePaperVolatilityContext(history)).toEqual({
        status: "invalid_history",
        mode: "advisory_only",
      });
    }
  });
});
