import { TradingSweepRequestSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { sweepOkxSpotResearch } from "./trading-okx-sweep.js";

const now = new Date("2026-10-03T10:15:00.000Z");
const start = Date.UTC(2026, 9, 3, 9) - 20 * 3_600_000;
const instrument = (base: string) => ({
  instType: "SPOT",
  instId: base + "-USDT",
  baseCcy: base,
  quoteCcy: "USDT",
  state: "live",
  ruleType: "normal",
  tickSz: "0.01",
  lotSz: "0.01",
});
const ticker = (base: string, bid: string, ask: string, volume: string) => ({
  instType: "SPOT",
  instId: base + "-USDT",
  bidPx: bid,
  askPx: ask,
  volCcy24h: volume,
  ts: String(now.getTime()),
});
const envelope = (data: unknown[]) => ({ code: "0", data });
const history = (variant: "up" | "flat") =>
  envelope(
    Array.from({ length: 21 }, (_, i) => {
      const recent = i === 20;
      const p = recent && variant === "up"
        ? ["99", "110", "98", "108", "200"]
        : ["97", "100", "95", "98", recent ? "200" : "100"];
      return [
        String(start + i * 3_600_000),
        p[0],
        p[1],
        p[2],
        p[3],
        "4",
        "10",
        p[4],
        "1",
      ];
    }).reverse(),
  );
const catalog = [
  envelope([instrument("SOL"), instrument("DOGE"), instrument("ADA")]),
  envelope([]),
  envelope([]),
];
function setup(
  {
    failFirst = false,
    divergent = false,
  }: { failFirst?: boolean; divergent?: boolean } = {},
) {
  const tickerData = envelope([
    ticker("SOL", divergent ? "1" : "108", divergent ? "1.001" : "108.1", "800000"),
    ticker("DOGE", "98", "98.01", "500000"),
    ticker("ADA", "1", "1.001", "10"),
  ]);
  const responses: unknown[] = [
    ...catalog,
    tickerData,
    failFirst ? new Response("busy", { status: 503 }) : history("up"),
    history("flat"),
  ];
  const remaining = [...responses];
  const mock = vi.fn(async (_url: unknown, _options: unknown) => {
    const item = remaining.shift();
    if (item instanceof Response) return item;
    return new Response(JSON.stringify(item), { status: 200 });
  });
  return { mock, fetchImpl: mock as unknown as typeof fetch };
}
const policy = (maxInstruments: number) =>
  TradingSweepRequestSchema.parse({ maxInstruments });

describe("bounded OKX multi-altcoin research", () => {
  it("discovers dynamic markets, research-proposes one and abstains on another", async () => {
    const fake = setup();
    const result = await sweepOkxSpotResearch(policy(2), {
      fetchImpl: fake.fetchImpl,
      now,
    });
    expect(result.universeCount).toBe(3);
    expect(result.shortlistCount).toBe(2);
    expect(result.filteredOutCount).toBe(1);
    expect(result.analyzed.map((r) => r.market.symbol)).toEqual(["SOL-USDT", "DOGE-USDT"]);
    expect(result.analyzed[0]?.signal.kind).toBe("proposal");
    expect(result.analyzed[1]?.signal.kind).toBe("no_trade");
    expect(result.unavailable).toEqual([]);
    expect(fake.mock).toHaveBeenCalledTimes(6);
    expect(fake.mock.mock.calls.map((call) => String(call[0])).slice(-2)).toEqual([
      "https://www.okx.com/api/v5/market/history-candles?instId=SOL-USDT&bar=1H&limit=100",
      "https://www.okx.com/api/v5/market/history-candles?instId=DOGE-USDT&bar=1H&limit=100",
    ]);
    for (const call of fake.mock.mock.calls) {
      const options = call[1] as RequestInit;
      expect(options.method).toBe("GET");
      expect(JSON.stringify(options.headers)).not.toMatch(/key|signature|authorization/i);
    }
  });

  it("limits history calls to configured bound without assuming profitability", async () => {
    const fake = setup();
    const result = await sweepOkxSpotResearch(policy(1), {
      fetchImpl: fake.fetchImpl,
      now,
    });
    expect(result.analyzed).toHaveLength(1);
    expect(fake.mock).toHaveBeenCalledTimes(5);
    expect(() => TradingSweepRequestSchema.parse({ maxInstruments: 6 })).toThrow();
    expect(() => TradingSweepRequestSchema.parse({ maxInstruments: 0 })).toThrow();
  });

  it("records missing history instead of inventing replacement signals", async () => {
    const fake = setup({ failFirst: true });
    const result = await sweepOkxSpotResearch(policy(2), {
      fetchImpl: fake.fetchImpl,
      now,
    });
    expect(result.unavailable).toEqual([{
      symbol: "SOL-USDT",
      reason: "history_unavailable_or_invalid",
    }]);
    expect(result.analyzed.map((r) => r.market.symbol)).toEqual(["DOGE-USDT"]);
    expect(result.analyzed[0]?.signal.kind).toBe("no_trade");
  });

  it("does not display a historical entry when current ticker diverges materially", async () => {
    const fake = setup({ divergent: true });
    const result = await sweepOkxSpotResearch(policy(2), {
      fetchImpl: fake.fetchImpl,
      now,
    });
    expect(result.analyzed.map((r) => r.market.symbol)).toEqual(["DOGE-USDT"]);
    expect(result.unavailable.map((entry) => entry.symbol)).toEqual(["SOL-USDT"]);
  });
});
