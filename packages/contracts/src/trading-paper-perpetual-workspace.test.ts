import { describe, expect, it } from "vitest";
import {
  PaperPerpetualCommandSchema,
  PaperPerpetualDecisionSchema,
} from "./trading-paper-perpetual-workspace.js";

describe("AI PAPER futures portfolio decision schema", () => {
  it("resumes only a bounded existing scope and rejects scope overrides", () => {
    const resume = {
      action: "resume",
      ledgerId: "paper-futures:fixture",
      commandId: "b7e0b8b5-c03d-4dc0-a2fb-8883371f8029",
      expectedRevision: 4,
      durationMinutes: 15,
      protectionMinutes: 1440,
    };
    expect(PaperPerpetualCommandSchema.parse(resume)).toEqual(resume);
    for (const extra of [
      { durationMinutes: 0 },
      { durationMinutes: 20161 },
      { protectionMinutes: 1441 },
      { researchMode: "model" },
      { maxLeverage: 100 },
      { instruments: ["ETH-USDT-SWAP"] },
      { source: {} },
    ])
      expect(PaperPerpetualCommandSchema.safeParse({ ...resume, ...extra }).success).toBe(false);
  });

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

  it("accepts a native position addition and a one-out-one-in hedge rotation", () => {
    const proposal = {
      kind: "proposal" as const,
      instrument: "BTC-USDT-SWAP",
      side: "long" as const,
      leverage: 20,
      quantityBase: "0.5",
      orderType: "market" as const,
      limitPriceQuote: null,
      stopPriceQuote: "97",
      takeProfitPriceQuote: "110",
      rationale: "Verified PAPER market evidence",
    };
    expect(
      PaperPerpetualDecisionSchema.parse({
        ...proposal,
        addToPositionId: "paper-position:old",
      }),
    ).toMatchObject({ addToPositionId: "paper-position:old" });
    expect(
      PaperPerpetualDecisionSchema.parse({
        ...proposal,
        replacePositionId: "paper-position:old",
      }),
    ).toMatchObject({ replacePositionId: "paper-position:old" });
    expect(
      PaperPerpetualDecisionSchema.safeParse({
        ...proposal,
        addToPositionId: "paper-position:old",
        replacePositionId: "paper-position:other",
      }).success,
    ).toBe(false);
  });

  it("validates two explicit pre-entry recovery stages and prevents relabeling an addition", () => {
    const base = {
      kind: "proposal",
      instrument: "BTC-USDT-SWAP",
      side: "long",
      leverage: 10,
      quantityBase: "0.2",
      orderType: "market",
      limitPriceQuote: null,
      stopPriceQuote: "50",
      takeProfitPriceQuote: "130",
      rationale: "Plan margin and two optional recovery zones in advance",
    };
    const stages = [
      { stepId: "test-1", triggerPriceQuote: "80", allocationPercent: 60 },
      { stepId: "test-2", triggerPriceQuote: "60", allocationPercent: 40 },
    ];
    expect(PaperPerpetualDecisionSchema.parse({ ...base, recoverySteps: stages })).toMatchObject({
      kind: "proposal",
      recoverySteps: stages,
    });
    expect(
      PaperPerpetualDecisionSchema.safeParse({
        ...base,
        recoverySteps: [{ ...stages[0]!, allocationPercent: 70 }, stages[1]],
      }).success,
    ).toBe(false);
    expect(
      PaperPerpetualDecisionSchema.safeParse({
        ...base,
        recoverySteps: [stages[0], { ...stages[1]!, stepId: "test-1" }],
      }).success,
    ).toBe(false);
    expect(
      PaperPerpetualDecisionSchema.safeParse({
        ...base,
        addToPositionId: "paper-position:one",
        recoverySteps: stages,
      }).success,
    ).toBe(false);
    expect(
      PaperPerpetualDecisionSchema.parse({
        ...base,
        addToPositionId: "paper-position:one",
        recoveryStepId: "test-1",
      }),
    ).toMatchObject({ recoveryStepId: "test-1" });
  });

  it("accepts only an explicit price on a tighten-only stop intent", () => {
    expect(
      PaperPerpetualDecisionSchema.parse({
        kind: "tighten_stop",
        positionId: "paper-position:old",
        stopPriceQuote: "98",
        reason: "Confirmed volatility adjustment",
      }),
    ).toMatchObject({ kind: "tighten_stop", stopPriceQuote: "98" });
    expect(
      PaperPerpetualDecisionSchema.safeParse({
        kind: "tighten_stop",
        positionId: "paper-position:old",
        stopPriceQuote: "98",
        removeExistingStop: true,
        reason: "Attempt to cancel protection",
      }).success,
    ).toBe(false);
  });

  it("preserves no_trade and full close decisions", () => {
    expect(
      PaperPerpetualDecisionSchema.parse({ kind: "no_trade", reason: "Нет сигнала" }),
    ).toMatchObject({
      kind: "no_trade",
    });
    expect(
      PaperPerpetualDecisionSchema.parse({
        kind: "close",
        positionId: "paper-position:one",
        reason: "Торговая идея утратила силу",
      }),
    ).toMatchObject({ kind: "close" });
  });
});
