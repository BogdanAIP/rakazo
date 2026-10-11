import { describe, expect, it } from "vitest";
import {
  getPaperExperimentPreset,
  PAPER_EXPERIMENT_STRATEGIES,
  paperExperimentHedgeBucket,
} from "./trading-paper-experiments.js";

describe("three isolated 1000-USDT PAPER experiment presets", () => {
  it("allocates exactly three independent accounts with the same starting cash", () => {
    expect(PAPER_EXPERIMENT_STRATEGIES).toEqual([
      "conservative",
      "moderate",
      "aggressive",
    ]);
    const profiles = PAPER_EXPERIMENT_STRATEGIES.map(getPaperExperimentPreset);
    expect(new Set(profiles.map((p) => p.id)).size).toBe(3);
    expect(new Set(profiles.map((p) => p.accountName)).size).toBe(3);
    expect(profiles.every((p) => p.initialBalanceQuote === "1000")).toBe(true);
    expect(profiles.every((p) => p.positionMode === "hedge")).toBe(true);
    expect(profiles.every((p) => p.researchMode === "model_proposes")).toBe(true);
  });

  it("orders risk budgets and leverage conservatively", () => {
    const profiles = PAPER_EXPERIMENT_STRATEGIES.map(getPaperExperimentPreset);
    const strictlyAscending = (extract: (p: (typeof profiles)[number]) => number) =>
      profiles.every((profile, i) => i === 0 || extract(profiles[i - 1]!) < extract(profile));
    expect(strictlyAscending((p) => Number(p.maxPerIdeaRiskQuote))).toBe(true);
    expect(strictlyAscending((p) => Number(p.maxDailyLossQuote))).toBe(true);
    expect(strictlyAscending((p) => Number(p.maxOpenRiskQuote))).toBe(true);
    expect(strictlyAscending((p) => Number(p.maxTotalExposureQuote))).toBe(true);
    expect(strictlyAscending((p) => p.maxLeverage)).toBe(true);
    expect(profiles.every((p) => Number(p.maxPerIdeaRiskQuote) < 1000)).toBe(true);
  });

  it("keeps simultaneous long and short buckets separate by ledger, venue and symbol", () => {
    const common = {
      strategy: "moderate" as const,
      ledgerId: "paper.test.1",
      venue: "okx" as const,
      instrument: "BTC-USDT-SWAP",
    };
    const long = paperExperimentHedgeBucket({ ...common, side: "long" });
    const short = paperExperimentHedgeBucket({ ...common, side: "short" });
    expect(long).not.toBeNull();
    expect(short).not.toBeNull();
    expect(long).not.toBe(short);
    expect(long).not.toBe(
      paperExperimentHedgeBucket({ ...common, ledgerId: "paper.test.2", side: "long" }),
    );
    expect(long).not.toBe(
      paperExperimentHedgeBucket({ ...common, venue: "bingx", side: "long" }),
    );
    expect(long).not.toBe(
      paperExperimentHedgeBucket({ ...common, instrument: "ETH-USDT-SWAP", side: "long" }),
    );
    expect(long).not.toBe(
      paperExperimentHedgeBucket({ ...common, strategy: "conservative", side: "long" }),
    );
  });

  it("rejects malformed or spot-only symbols and missing account identity", () => {
    const normal = {
      strategy: "aggressive" as const,
      ledgerId: "paper-3",
      venue: "okx" as const,
      side: "short" as const,
    };
    expect(paperExperimentHedgeBucket({ ...normal, instrument: "BTC-USDT" })).toBeNull();
    expect(paperExperimentHedgeBucket({ ...normal, instrument: "BTC-USD-SWAP" })).toBeNull();
    expect(paperExperimentHedgeBucket({ ...normal, instrument: "../BTC-USDT-SWAP" })).toBeNull();
    expect(
      paperExperimentHedgeBucket({ ...normal, instrument: "BTC-USDT-SWAP", ledgerId: "" }),
    ).toBeNull();
  });
});
