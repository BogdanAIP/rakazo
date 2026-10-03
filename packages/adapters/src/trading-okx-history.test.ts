import { TradingInstrumentSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { fetchOkxClosedOneHourHistory } from "./trading-okx-history.js";

const now = new Date("2026-10-03T10:15:00.000Z");
const market = TradingInstrumentSchema.parse({
  venue: "okx",
  kind: "perpetual",
  symbol: "DOGE-USDT-SWAP",
  base: "DOGE",
  quote: "USDT",
  status: "active",
  priceIncrement: "0.0001",
  quantityIncrement: "1",
  minNotional: null,
  expiryAt: null,
});
const ts = (hour: number) => String(Date.UTC(2026, 9, 3, hour));
const bar = (hour: number, confirm: "0" | "1" = "1") => [
  ts(hour),
  "100",
  "105",
  "95",
  "102",
  "6",
  "120",
  "50000",
  confirm,
];
function transport(value: unknown) {
  const mock = vi.fn(async (_url: unknown, _options: unknown) =>
    value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 }),
  );
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}
function history(data: unknown, instrument = market) {
  return fetchOkxClosedOneHourHistory(instrument, {
    now,
    fetchImpl: transport(data).fetchImpl,
  });
}

describe("read-only OKX closed 1H history", () => {
  it("uses quote-denominated volume for perpetuals and excludes unfinished bars", async () => {
    const fake = transport({ code: "0", data: [bar(10, "0"), bar(9), bar(8)] });
    const result = await fetchOkxClosedOneHourHistory(market, {
      now,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.candles.map((c) => c.openedAt)).toEqual([
      new Date(Number(ts(8))).toISOString(),
      new Date(Number(ts(9))).toISOString(),
    ]);
    expect(result.candles[0]?.kind).toBe("perpetual");
    expect(result.candles[0]?.quoteVolume).toBe("50000");
    expect(result.fetchedAt).toBe(now.toISOString());
    expect(fake.mock).toHaveBeenCalledTimes(1);
    expect(fake.mock.mock.calls[0]?.[0]).toBe(
      "https://www.okx.com/api/v5/market/history-candles?instId=DOGE-USDT-SWAP&bar=1H&limit=100",
    );
    const options = fake.mock.mock.calls[0]?.[1] as RequestInit;
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(JSON.stringify(options.headers)).not.toMatch(/api.?key|authorization|signature/i);
  });

  it("fails closed on malformed OHLC, timestamps and duplicate confirmed rows", async () => {
    await expect(
      history({ code: "0", data: [[...bar(9).slice(0, 2), "80", ...bar(9).slice(3)]] }),
    ).rejects.toThrow();
    await expect(history({ code: "0", data: [bar(9), bar(9)] })).rejects.toThrow("Duplicate");
    const future = [...bar(10)];
    await expect(history({ code: "0", data: [future] })).rejects.toThrow(
      "Future or prematurely confirmed",
    );
    await expect(history({ code: "0", data: [["bad-ts", ...bar(9).slice(1)]] })).rejects.toThrow(
      "epoch",
    );
  });

  it("rejects API errors, non-JSON and wrong provider before network access", async () => {
    await expect(history({ code: "50001", data: [] })).rejects.toThrow("API error");
    await expect(history(new Response("bad-json"))).rejects.toThrow("not JSON");
    await expect(history(new Response("busy", { status: 503 }))).rejects.toThrow("HTTP error");
    await expect(history({ code: "0", data: [] }, { ...market, venue: "other" })).rejects.toThrow(
      "Unsupported",
    );
    await expect(
      history({ code: "0", data: [] }, { ...market, symbol: "DOGE/USDT" }),
    ).rejects.toThrow("Unsupported");
  });
});
