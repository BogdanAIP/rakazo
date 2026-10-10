import { TradingCandleSchema, TradingInstrumentSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { runSpotCandleWalkforward } from "./trading-walkforward.js";

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
const start = Date.UTC(2026, 9, 2, 12);
const baseBar = {
  open: "97",
  high: "100",
  low: "95",
  close: "98",
  quoteVolume: "100",
};
const breakout = {
  open: "99",
  high: "110",
  low: "98",
  close: "108",
  quoteVolume: "200",
};
const nextBar = {
  open: "108",
  high: "125",
  low: "99",
  close: "115",
  quoteVolume: "100",
};
const makeBars = (final = nextBar, last = breakout) =>
  Array.from({ length: 22 }, (_, i) =>
    TradingCandleSchema.parse({
      venue: "okx",
      kind: "spot",
      symbol: "SOL-USDT",
      openedAt: new Date(start + i * 3_600_000).toISOString(),
      durationMs: 3_600_000,
      confirmed: true,
      ...(i < 20 ? baseBar : i === 20 ? last : final),
    }),
  );
const run = (overrides: Record<string, unknown> = {}) =>
  runSpotCandleWalkforward({
    algorithm: "spot_breakout_next_bar_v1",
    datasetSha256: "a".repeat(64),
    market,
    candles: makeBars(),
    initialBalanceQuote: "2000",
    fixedNotionalQuote: "1000",
    feeBpsPerSide: 10,
    adverseSlippageBpsPerSide: 10,
    maxEntryGapBps: 100,
    ...overrides,
  });

describe("point-in-time closed-bar spot walk-forward", () => {
  it("derives a future-bar execution and conservatively picks stop before target", () => {
    const result = run();
    expect(result.signalCount).toBe(1);
    expect(result.noTradeCount).toBe(0);
    expect(result.skippedEntryCount).toBe(0);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.exitReason).toBe("stop");
    expect(Number(result.executions[0]?.entryReference)).toBe(108);
    expect(Number(result.executions[0]?.exitReference)).toBeLessThan(108);
    expect(Date.parse(result.executions[0]!.enteredAt)).toBeGreaterThan(
      Date.parse(result.executions[0]!.decisionAt),
    );
    expect(result.replay?.trades).toHaveLength(1);
    expect(result.replay?.netPnlQuote).toBeLessThan(0);
    expect(result.replay?.totalFeesQuote).toBeGreaterThan(0);
    expect(result.replay?.realizedOnly).toBe(true);
  });

  it("uses only target when stop not touched, or next-bar close otherwise", () => {
    const target = run({ candles: makeBars({ ...nextBar, low: "105" }) });
    expect(target.executions[0]?.exitReason).toBe("target");
    expect(target.replay?.netPnlQuote).toBeGreaterThan(0);
    const close = run({
      candles: makeBars({
        open: "108",
        high: "118",
        low: "103",
        close: "110",
        quoteVolume: "100",
      }),
    });
    expect(close.executions[0]?.exitReason).toBe("next_bar_close");
  });

  it("does not force fills if next open is below trigger or beyond gap / target", () => {
    const low = run({
      candles: makeBars({
        open: "104",
        high: "120",
        low: "102",
        close: "110",
        quoteVolume: "100",
      }),
    });
    expect(low.skippedEntryCount).toBe(1);
    expect(low.replay).toBeNull();
    const gap = run({
      candles: makeBars({
        open: "130",
        high: "135",
        low: "120",
        close: "129",
        quoteVolume: "100",
      }),
    });
    expect(gap.skippedEntryCount).toBe(1);
    expect(gap.replay).toBeNull();
  });

  it("returns NO_TRADE with null replay for flat data and no fabricated returns", () => {
    const result = run({ candles: makeBars(baseBar, baseBar) });
    expect(result.signalCount).toBe(1);
    expect(result.noTradeCount).toBe(1);
    expect(result.executions).toHaveLength(0);
    expect(result.replay).toBeNull();
  });

  it("fails closed on gaps, market mixing, non-spot, invalid dataset or unsupported leverage", () => {
    const gap = makeBars();
    gap[17] = TradingCandleSchema.parse({
      ...gap[17],
      openedAt: new Date(start + 18 * 3_600_000).toISOString(),
    });
    expect(() => run({ candles: gap })).toThrow("gap");
    const mixed = makeBars();
    mixed[2] = TradingCandleSchema.parse({ ...mixed[2], symbol: "BTC-USDT" });
    expect(() => run({ candles: mixed })).toThrow("provenance");
    expect(() =>
      run({ market: { ...market, kind: "perpetual", symbol: "SOL-USDT-SWAP" } }),
    ).toThrow("spot");
    expect(() => run({ datasetSha256: "not-a-hash" })).toThrow();
    expect(() => run({ fixedNotionalQuote: "2001" })).toThrow("borrowing");
    expect(() => run({ adverseSlippageBpsPerSide: undefined })).toThrow();
  });
});
