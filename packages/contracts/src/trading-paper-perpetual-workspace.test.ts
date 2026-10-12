import { describe, expect, it } from "vitest";
import { PaperPerpetualDecisionSchema } from "./trading-paper-perpetual-workspace.js";

describe("AI PAPER futures portfolio decision schema", () => {
  it("accepts a bounded partial reduction intent with no direct exchange authority", () => {
    const decision = PaperPerpetualDecisionSchema.parse({
      kind: "reduce",
      positionId: "paper-position:one",
      quantityBase: "0.25",
      reason: "Сократить экспозицию перед рыночной турбулентностью.",
    });
    expect(decision).toMatchObject({
      kind: "reduce",
      positionId: "paper-position:one",
      quantityBase: "0.25",
    });
    expect("exchangeOrderId" in decision).toBe(false);
  });

  it("rejects zero, negative, ambiguous and over-specified reductions", () => {
    for (const quantityBase of ["0", "-1", "NaN", "1e3", ""]) {
      expect(
        PaperPerpetualDecisionSchema.safeParse({
          kind: "reduce",
          positionId: "paper-position:one",
          quantityBase,
          reason: "Исправление риска",
        }).success,
      ).toBe(false);
    }
    expect(
      PaperPerpetualDecisionSchema.safeParse({
        kind: "reduce",
        positionId: "paper-position:one",
        quantityBase: "1",
        reason: "Исправление риска",
        ignoreRiskChecks: true,
      }).success,
    ).toBe(false);
  });

  it("preserves no_trade and full close decisions", () => {
    expect(PaperPerpetualDecisionSchema.parse({ kind: "no_trade", reason: "Нет сигнала" })).toMatchObject({
      kind: "no_trade",
    });
    expect(PaperPerpetualDecisionSchema.parse({
      kind: "close",
      positionId: "paper-position:one",
      reason: "Торговая идея утратила силу",
    })).toMatchObject({ kind: "close" });
  });
});
