import type { PaperPerpetualEngineConfig, PaperPerpetualEngineSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { estimatePaperLiquidationPrices } from "./trading-paper-liquidation-estimate.js";
import { summarizePaperEquity } from "./trading-paper-perpetual-analytics.js";

const config: PaperPerpetualEngineConfig = {
  version: "paper_engine_config_v1",
  engineId: "fixture",
  engineVersion: "1.231.0",
  accountId: "fixture",
  initialBalanceQuote: "1000",
  leverage: 20,
  instruments: ["SOL-USDT-SWAP", "BTC-USDT-SWAP"].map((instrument) => ({
    instrument,
    priceIncrement: "0.01",
    quantityIncrement: "0.01",
    minimumBase: "0.01",
    maximumBase: "100000",
    maintenanceRate: "0.005",
    makerFeeRate: "0.0002",
    takerFeeRate: "0.0005",
  })),
};
const position = (side: "LONG" | "SHORT", quantityBase = "2") => ({
  positionId: side,
  instrument: "SOL-USDT-SWAP",
  side,
  quantityBase,
  realizedPnl: "0",
  entryPriceQuote: "100",
  markPriceQuote: "100",
  unrealizedPnlQuote: "0",
});
const snapshot = (
  positions: PaperPerpetualEngineSnapshot["positions"] = [position("SHORT")],
  balanceQuote = "1000",
): PaperPerpetualEngineSnapshot => ({
  version: "paper_engine_snapshot_v1",
  engineId: "fixture",
  engineVersion: "1.231.0",
  accountId: "fixture",
  sequence: 1,
  marginMode: "account_wide",
  leverage: 20,
  clockNs: "1780000000000000000",
  balanceQuote,
  availableQuote: balanceQuote,
  lockedQuote: "10",
  positions,
  closedPositions: 0,
  openOrders: [],
  realizedPnlQuote: "0",
  totalFeesQuote: "0",
  fundingNetQuote: "0",
  liquidations: 0,
  eventCount: 0,
  events: [],
});
describe("indicative account-wide maintenance boundary", () => {
  it("equates whole-account equity and maintenance, rather than entry plus 1/leverage", () => {
    const root = Number(estimatePaperLiquidationPrices(config, snapshot()).get("SOL-USDT-SWAP"));
    expect(root).toBeGreaterThan(590);
    expect(1000 + 2 * (100 - root)).toBeCloseTo(2 * root * 0.005, 6);
    expect(
      estimatePaperLiquidationPrices(
        { ...config, leverage: 5 },
        { ...snapshot(), leverage: 5 },
      ).get("SOL-USDT-SWAP"),
    ).toBe(String(root));
  });
  it("reports no positive long boundary when the whole wallet can absorb the asset reaching zero", () => {
    expect(
      estimatePaperLiquidationPrices(config, snapshot([position("LONG")])).get("SOL-USDT-SWAP"),
    ).toBeNull();
  });
  it("includes other-instrument losses and both hedge legs in maintenance", () => {
    const btc = {
      ...position("LONG"),
      positionId: "btc",
      instrument: "BTC-USDT-SWAP",
      unrealizedPnlQuote: "-100",
    };
    const smaller = Number(
      estimatePaperLiquidationPrices(config, snapshot([position("SHORT"), btc])).get(
        "SOL-USDT-SWAP",
      ),
    );
    const solo = Number(estimatePaperLiquidationPrices(config, snapshot()).get("SOL-USDT-SWAP"));
    expect(smaller).toBeLessThan(solo);
    const hedge = Number(
      estimatePaperLiquidationPrices(config, snapshot([position("LONG"), position("SHORT")])).get(
        "SOL-USDT-SWAP",
      ),
    );
    expect(4 * hedge * 0.005).toBeCloseTo(1000, 5);
  });
  it("never divides a perfectly zero maintenance slope", () => {
    const balanced = {
      ...config,
      instruments: config.instruments.map((p) => ({ ...p, maintenanceRate: "0.5" })),
    };
    expect(
      estimatePaperLiquidationPrices(
        balanced,
        snapshot([position("LONG", "3"), position("SHORT", "1")]),
      ).get("SOL-USDT-SWAP"),
    ).toBeNull();
  });
});
describe("full-history equity analytics", () => {
  const started = "2026-01-01T00:00:00.000Z";
  it("retains a loss outside the latest journal page and reports full-history drawdown", () => {
    const transitions = Array.from({ length: 2000 }, (_, i) => ({
      output: snapshot([], i === 51 ? "700" : "1000"),
      recordedAt: new Date(Date.parse(started) + (i + 1) * 60_000),
    }));
    const result = summarizePaperEquity(transitions, started);
    expect(result.observations).toBe(2000);
    expect(result.maximumDrawdownPercent).toBe("30.00");
    expect(result.points.length).toBeLessThanOrEqual(500);
    expect(result.points.some((p) => p.equityQuote === "700")).toBe(true);
    expect(result.points.at(-1)?.at).toBe(transitions.at(-1)?.recordedAt.toISOString());
  });
  it("marks an overnight missing-observation interval rather than inventing a continuous path", () => {
    const result = summarizePaperEquity(
      [{ output: snapshot(), recordedAt: new Date("2026-01-01T10:00:00.000Z") }],
      started,
    );
    expect(result.points.at(-1)?.gapBefore).toBe(true);
  });
  it("includes unrealized PnL and compares drawdown against previous account peaks", () => {
    const transitions = [
      { output: snapshot([], "1200"), recordedAt: new Date("2026-01-01T00:01:00.000Z") },
      {
        output: snapshot([{ ...position("LONG"), unrealizedPnlQuote: "-120" }], "1200"),
        recordedAt: new Date("2026-01-01T00:02:00.000Z"),
      },
    ];
    const result = summarizePaperEquity(transitions, started);
    expect(result.points.at(-1)?.equityQuote).toBe("1080");
    expect(result.maximumDrawdownPercent).toBe("10.00");
  });
});
