import { describe, expect, it } from "vitest";
import { PaperPerpetualDecisionSchema } from "./trading-paper-perpetual-workspace.js";
import { PaperResearchComparisonSchema } from "./trading-paper-research-comparison.js";

const comparison = {
  asOf: "2026-10-01T12:00:00.000Z",
  validUntil: "2026-10-01T12:10:00.000Z",
  method: "Compare public closed candles",
  profileRationale: "Size and exits fit the selected risk budget",
  candidates: [
    {
      instrument: "BTC-USDT-SWAP",
      verdict: "selected",
      reason: "Confirmed setup",
      facts: [{ name: "close", value: "100" }],
    },
    { instrument: "SOL-USDT-SWAP", verdict: "rejected", reason: "No confirmation", facts: [] },
  ],
};
describe("bounded PAPER candidate comparisons", () => {
  it("accepts auditable facts without granting execution authority", () => {
    const parsed = PaperResearchComparisonSchema.parse(comparison);
    expect(parsed).toEqual(comparison);
    expect(PaperPerpetualDecisionSchema.parse({ kind: "no_trade", reason: "Wait" })).toEqual({
      kind: "no_trade",
      reason: "Wait",
    });
  });
  it("rejects duplicate candidates, unlimited validity and oversized or executable metadata", () => {
    for (const extra of [
      { validUntil: comparison.asOf },
      { validUntil: "2026-10-01T13:00:00.000Z" },
      { candidates: [comparison.candidates[0], comparison.candidates[0]] },
      { profileRationale: "" },
      { executeImmediately: true },
      {
        candidates: [
          { ...comparison.candidates[0], facts: [{ name: "payload", value: "x".repeat(121) }] },
        ],
      },
    ])
      expect(PaperResearchComparisonSchema.safeParse({ ...comparison, ...extra }).success).toBe(
        false,
      );
  });
});
