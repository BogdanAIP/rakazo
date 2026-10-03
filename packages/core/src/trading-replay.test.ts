import { TradingInstrumentSchema, TradingReplayInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { replayExplicitTradingFills } from "./trading-replay.js";

const spot = TradingInstrumentSchema.parse({
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
const perp = TradingInstrumentSchema.parse({
  ...spot,
  kind: "perpetual",
  symbol: "SOL-USDT-SWAP",
});
const SHA = "a".repeat(64);
const baseTrade = {
  tradeId: "sample-1",
  market: spot,
  side: "spot_long" as const,
  decisionAt: "2026-10-03T10:00:00.000Z",
  enteredAt: "2026-10-03T10:10:00.000Z",
  exitedAt: "2026-10-03T14:00:00.000Z",
  entryReference: "100",
  exitReference: "110",
  notionalQuote: "1000",
  fundingCoverage: null,
};
const base = {
  algorithm: "explicit_fill_replay_v1" as const,
  datasetSha256: SHA,
  strategyId: "synthetic-only",
  strategyVersion: "1",
  initialBalanceQuote: "2000",
  feeBpsPerSide: 10,
  adverseSlippageBpsPerSide: 0,
  trades: [baseTrade],
};
const fund = {
  from: "2026-10-03T10:10:00.000Z",
  through: "2026-10-03T14:00:00.000Z",
  expectedSettlementTimes: ["2026-10-03T12:00:00.000Z"],
  events: [
    {
      settledAt: "2026-10-03T12:00:00.000Z",
      ratePerSettlement: "-0.001",
      markPrice: "105",
    },
  ],
};
const check = (overrides: Record<string, unknown> = {}) =>
  replayExplicitTradingFills(TradingReplayInputSchema.parse({ ...base, ...overrides }));

describe("offline explicit-fill replay (research-only)", () => {
  it("accounts for both entry and exit fees and preserves provenance", () => {
    const r = check();
    expect(r.finalBalanceQuote).toBeCloseTo(2097.9, 7);
    expect(r.totalFeesQuote).toBeCloseTo(2.1, 7);
    expect(r.netPnlQuote).toBeCloseTo(97.9, 7);
    expect(r.datasetSha256).toBe(SHA);
    expect(r.realizedOnly).toBe(true);
    expect(r.trades[0]?.slippageImpactQuote).toBeCloseTo(0, 7);
  });

  it("charges adverse slippage on both fills and separately records its impact", () => {
    const costFree = check({ feeBpsPerSide: 0, adverseSlippageBpsPerSide: 0 });
    const withCosts = check({ feeBpsPerSide: 10, adverseSlippageBpsPerSide: 10 });
    expect(costFree.netPnlQuote).toBeCloseTo(100, 7);
    expect(withCosts.netPnlQuote).toBeLessThan(costFree.netPnlQuote);
    expect(withCosts.trades[0]?.slippageImpactQuote).toBeGreaterThan(0);
    expect(withCosts.totalFeesQuote).toBeGreaterThan(0);
  });

  it("includes actual historical signed funding for perpetual longs and shorts", () => {
    const long = { ...baseTrade, market: perp, side: "perpetual_long", fundingCoverage: fund };
    const longResult = check({ trades: [long], feeBpsPerSide: 0 });
    expect(longResult.totalFundingQuote).toBeCloseTo(1.05, 7);
    const short = {
      ...long,
      side: "perpetual_short",
      fundingCoverage: {
        ...fund,
        events: [{ ...fund.events[0], ratePerSettlement: "0.001" }],
      },
    };
    const shortResult = check({ trades: [short], feeBpsPerSide: 0 });
    expect(shortResult.totalFundingQuote).toBeCloseTo(1.05, 7);
    expect(shortResult.netPnlQuote).toBeLessThan(0); // adverse price move is not erased by funding
  });

  it("fails closed on absent funding, missing settlement, and mismatched funding chronology", () => {
    const future = { ...baseTrade, market: perp, side: "perpetual_long", fundingCoverage: null };
    expect(() => check({ trades: [future] })).toThrow("mandatory");
    expect(() =>
      check({
        trades: [
          {
            ...future,
            fundingCoverage: { ...fund, events: [] },
          },
        ],
      }),
    ).toThrow("Missing");
    expect(() =>
      check({
        trades: [
          {
            ...future,
            fundingCoverage: {
              ...fund,
              events: [{ ...fund.events[0], settledAt: "2026-10-03T13:00:00.000Z" }],
            },
          },
        ],
      }),
    ).toThrow("Funding schedule");
    expect(() =>
      check({
        trades: [
          {
            ...future,
            fundingCoverage: { ...fund, from: "2026-10-03T11:00:00.000Z" },
          },
        ],
      }),
    ).toThrow("span");
  });

  it("rejects look-ahead-like timing, mixed currencies, duplicated trades and leverage", () => {
    expect(() => check({ trades: [{ ...baseTrade, enteredAt: baseTrade.decisionAt }] })).toThrow(
      "chronological",
    );
    expect(() => check({ trades: [{ ...baseTrade, notionalQuote: "2001" }] })).toThrow(
      "forbids leverage",
    );
    expect(() =>
      check({
        trades: [
          baseTrade,
          {
            ...baseTrade,
            decisionAt: "2026-10-03T15:00:00.000Z",
            enteredAt: "2026-10-03T15:10:00.000Z",
            exitedAt: "2026-10-03T16:00:00.000Z",
          },
        ],
      }),
    ).toThrow("Duplicate");
    expect(() =>
      check({
        trades: [
          baseTrade,
          {
            ...baseTrade,
            tradeId: "sample-2",
            decisionAt: "2026-10-03T15:00:00.000Z",
            enteredAt: "2026-10-03T15:10:00.000Z",
            exitedAt: "2026-10-03T16:00:00.000Z",
            market: { ...spot, quote: "USDC", symbol: "SOL-USDC" },
          },
        ],
      }),
    ).toThrow("Mixed quote");
    expect(() => TradingReplayInputSchema.parse({ ...base, feeBpsPerSide: undefined })).toThrow();
  });

  it("reports peak-to-trough realized drawdown, not an invented intratrade drawdown", () => {
    const r = check({
      trades: [
        { ...baseTrade, exitReference: "120" },
        {
          ...baseTrade,
          tradeId: "sample-2",
          decisionAt: "2026-10-03T15:00:00.000Z",
          enteredAt: "2026-10-03T15:10:00.000Z",
          exitedAt: "2026-10-03T16:00:00.000Z",
          exitReference: "90",
        },
      ],
      feeBpsPerSide: 0,
    });
    expect(r.trades).toHaveLength(2);
    expect(r.finalBalanceQuote).toBeCloseTo(2100, 7);
    expect(r.maxRealizedDrawdownPct).toBeCloseTo((100 / 2200) * 100, 7);
  });
});
