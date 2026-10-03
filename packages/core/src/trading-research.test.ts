import { TradingCandleSchema, TradingInstrumentSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { researchClosedHourBreakout } from "./trading-research.js";

const now = new Date("2026-10-03T10:15:00.000Z");
const fetchedAt = now.toISOString();
const market = TradingInstrumentSchema.parse({
  venue: "okx",
  kind: "perpetual",
  symbol: "DOGE-USDT-SWAP",
  base: "DOGE",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.01",
  quantityIncrement: "1",
  minNotional: null,
  expiryAt: null,
});
const opening = Date.UTC(2026, 9, 3, 9) - 20 * 3_600_000;
function bars(last: "up" | "down" | "flat" = "up") {
  return Array.from({ length: 21 }, (_, index) => {
    const latest = index === 20;
    const variant = latest
      ? last === "up"
        ? { open: "99", high: "110", low: "98", close: "108", quoteVolume: "200" }
        : last === "down"
          ? { open: "96", high: "97", low: "88", close: "89", quoteVolume: "200" }
          : { open: "98", high: "100", low: "95", close: "98", quoteVolume: "200" }
      : { open: "97", high: "100", low: "95", close: "98", quoteVolume: "100" };
    return TradingCandleSchema.parse({
      venue: "okx",
      kind: "perpetual",
      symbol: "DOGE-USDT-SWAP",
      openedAt: new Date(opening + index * 3_600_000).toISOString(),
      durationMs: 3_600_000,
      confirmed: true,
      ...variant,
    });
  });
}
const run = (
  candles: ReturnType<typeof bars>,
  overrides: Partial<Parameters<typeof researchClosedHourBreakout>[0]> = {},
) => researchClosedHourBreakout({ market, candles, now, fetchedAt, ...overrides });

describe("closed 1H breakout research baseline, with no execution capability", () => {
  it("creates conditional long with unprovisioned risk budget and source reference", () => {
    const result = run(bars("up"));
    expect(result.signal.kind).toBe("proposal");
    if (result.signal.kind !== "proposal") throw new Error("Missing research proposal");
    expect(result.signal.action).toBe("long");
    expect(result.signal.entryTrigger).toBe("108.00");
    expect(Number(result.signal.stopLoss)).toBeLessThan(108);
    expect(Number(result.signal.takeProfit[0])).toBeGreaterThan(108);
    expect(result.signal.riskBudgetQuote).toBeNull();
    expect(result.signal.maxSlippageBps).toBeNull();
    expect(result.signal.executionStatus).toBe("research_only");
    expect(result.signal.evidenceIds[0]).toContain("DOGE-USDT-SWAP");
    expect(result.algorithm).toBe("breakout_20_1h_v1");
  });

  it("supports short proposals for perps, but not implicit spot shorting", () => {
    const short = run(bars("down"));
    expect(short.signal.kind).toBe("proposal");
    if (short.signal.kind !== "proposal") throw new Error("Missing short research proposal");
    expect(short.signal.action).toBe("short");
    expect(Number(short.signal.stopLoss)).toBeGreaterThan(Number(short.signal.entryTrigger));
    expect(Number(short.signal.takeProfit[0])).toBeLessThan(Number(short.signal.entryTrigger));
    const spotMarket = TradingInstrumentSchema.parse({
      ...market,
      kind: "spot",
      symbol: "DOGE-USDT",
    });
    const spotBars = bars("down").map((candle) =>
      TradingCandleSchema.parse({ ...candle, kind: "spot", symbol: "DOGE-USDT" }),
    );
    const spot = run(spotBars, { market: spotMarket });
    expect(spot.signal.kind).toBe("no_trade");
  });

  it("abstains for a range-bound market, low-volume breakout and unsupported future", () => {
    expect(run(bars("flat")).signal.kind).toBe("no_trade");
    const low = bars("up");
    low[20] = TradingCandleSchema.parse({ ...low[20], quoteVolume: "10" });
    expect(run(low).signal.kind).toBe("no_trade");
    const future = TradingInstrumentSchema.parse({
      ...market,
      kind: "dated_future",
      expiryAt: "2027-01-01T00:00:00.000Z",
    });
    expect(run(bars(), { market: future }).signal.kind).toBe("no_trade");
  });

  it("rejects missing, duplicated, stale and future bars without hallucinating a signal", () => {
    const gaps = bars("up");
    gaps[10] = TradingCandleSchema.parse({
      ...gaps[10],
      openedAt: gaps[11]!.openedAt,
    });
    expect(run(gaps).signal.kind).toBe("no_trade");
    expect(run(bars("up").slice(1)).signal.kind).toBe("no_trade");
    expect(run(bars("up"), {
      now: new Date("2026-10-03T14:15:00.000Z"),
      fetchedAt: "2026-10-03T14:15:00.000Z",
    }).signal.kind).toBe("no_trade");
    const future = bars("up");
    future[20] = TradingCandleSchema.parse({
      ...future[20],
      openedAt: "2026-10-03T11:00:00.000Z",
    });
    expect(run(future).signal.kind).toBe("no_trade");
  });

  it("fails closed on incorrect candle provenance or untrusted fetch clocks", () => {
    const others = bars("up");
    others[3] = TradingCandleSchema.parse({ ...others[3], symbol: "BTC-USDT-SWAP" });
    expect(run(others).signal.kind).toBe("no_trade");
    expect(run(bars(), { fetchedAt: "2026-10-03T09:00:00.000Z" }).signal.kind).toBe("no_trade");
    expect(run(bars(), { fetchedAt: "2026-10-03T10:20:00.000Z" }).signal.kind).toBe("no_trade");
  });
});
