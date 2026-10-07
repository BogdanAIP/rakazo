import { TradingInstrumentSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { fetchBingxClosedOneHourHistory } from "./trading-bingx-history.js";

const now = new Date("2026-10-07T10:15:00.000Z");
const market = TradingInstrumentSchema.parse({
  venue: "bingx",
  kind: "spot",
  symbol: "SOL-USDT",
  base: "SOL",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.01",
  quantityIncrement: "0.001",
  minNotional: "5",
  expiryAt: null,
});
const open = (hour: number) => Date.UTC(2026, 9, 7, hour);
const bar = (hour: number) => [
  String(open(hour)),
  "100",
  "105",
  "95",
  "102",
  "6",
  String(open(hour) + 3_600_000 - 1),
  "50000",
];
function transport(value: unknown) {
  const mock = vi.fn(async (_url: unknown, _options: unknown) =>
    value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 }),
  );
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}
function history(data: unknown, instrument = market) {
  return fetchBingxClosedOneHourHistory(instrument, {
    now,
    fetchImpl: transport(data).fetchImpl,
  });
}

describe("read-only BingX closed 1H history", () => {
  it("uses quote-volume and excludes the still-open current hour", async () => {
    const fake = transport({ code: 0, msg: "", data: [bar(10), bar(9), bar(8)] });
    const result = await fetchBingxClosedOneHourHistory(market, {
      now,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.candles.map((candle) => candle.openedAt)).toEqual([
      new Date(open(8)).toISOString(),
      new Date(open(9)).toISOString(),
    ]);
    expect(result.candles[0]?.venue).toBe("bingx");
    expect(result.candles[0]?.quoteVolume).toBe("50000");
    expect(result.fetchedAt).toBe(now.toISOString());
    expect(fake.mock).toHaveBeenCalledTimes(1);
    expect(fake.mock.mock.calls[0]?.[0]).toBe(
      "https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=SOL-USDT&interval=1h&limit=100&timestamp=" +
        now.getTime(),
    );
    const options = fake.mock.mock.calls[0]?.[1] as RequestInit;
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(JSON.stringify(options.headers)).not.toMatch(/api.?key|authorization|signature/i);
  });

  it("fails closed on malformed OHLC, alignment, duration and duplicates", async () => {
    const malformed = [...bar(9)];
    malformed[2] = "80";
    await expect(history({ code: 0, data: [malformed] })).rejects.toThrow();
    const unaligned = [...bar(9)];
    unaligned[0] = String(open(9) + 1);
    await expect(history({ code: 0, data: [unaligned] })).rejects.toThrow("alignment");
    const badDuration = [...bar(9)];
    badDuration[6] = String(open(9) + 60_000);
    await expect(history({ code: 0, data: [badDuration] })).rejects.toThrow("duration");
    await expect(history({ code: 0, data: [bar(9), bar(9)] })).rejects.toThrow("Duplicate");
  });

  it("rejects API errors, non-JSON and wrong instruments before trusted use", async () => {
    await expect(history({ code: 100001, msg: "busy", data: [] })).rejects.toThrow("API error");
    await expect(history(new Response("bad-json"))).rejects.toThrow("not JSON");
    await expect(history(new Response("busy", { status: 503 }))).rejects.toThrow("HTTP error");
    await expect(history({ code: 0, data: [] }, { ...market, venue: "okx" })).rejects.toThrow(
      "Unsupported",
    );
    await expect(
      history({ code: 0, data: [] }, { ...market, kind: "perpetual" }),
    ).rejects.toThrow("Unsupported");
    await expect(
      history({ code: 0, data: [] }, { ...market, symbol: "SOL/USDT" }),
    ).rejects.toThrow("Unsupported");
  });
});
