import { describe, expect, it } from "vitest";
import type { PaperPerpetualProposalInput } from "./trading-paper-perpetual-preview.js";
import { previewPaperPerpetualProposal } from "./trading-paper-perpetual-preview.js";

const fixture: PaperPerpetualProposalInput = {
  strategy: "moderate",
  ledgerId: "paper.moderate.1",
  venue: "okx",
  instrument: "BTC-USDT-SWAP",
  side: "long",
  leverage: 2,
  quantityBase: "0.1",
  entryPriceQuote: "100",
  stopPriceQuote: "95",
  takeProfitPriceQuote: "110",
  availableQuote: "1000",
  portfolio: {
    openPositions: 0,
    openNotionalQuote: "0",
    openLongNotionalQuote: "0",
    openShortNotionalQuote: "0",
    markedEquityQuote: "1000",
    peakEquityQuote: "1000",
    openStopRiskQuote: "0",
    sameIdeaStopRiskQuote: "0",
    realizedLossTodayQuote: "0",
  },
  assumedFeeBpsPerSide: 10,
  assumedSlippageBpsPerSide: 10,
  maintenanceMarginBps: 50,
};

function expectDenial(overrides: Partial<PaperPerpetualProposalInput>, reason: string) {
  expect(previewPaperPerpetualProposal({ ...fixture, ...overrides })).toMatchObject({
    status: "deny",
    mode: "paper_only",
    reason,
  });
}

describe("inert, risk-bounded PAPER perpetual proposals", () => {
  it("previews a long without exposing order authority", () => {
    const result = previewPaperPerpetualProposal(fixture);
    expect(result.status).toBe("inert_preview");
    if (result.status !== "inert_preview") return;
    expect(result.mode).toBe("paper_only");
    expect(result.side).toBe("long");
    expect(result.notionalQuote).toBe("10.01");
    expect(Number(result.initialMarginQuote)).toBeLessThan(6);
    expect(Number(result.worstCaseStopLossQuote)).toBeLessThanOrEqual(10);
    expect(Number(result.collateralRemainingAtStopQuote)).toBeGreaterThan(
      Number(result.maintenanceMarginQuote),
    );
    expect("orderId" in result || "execute" in result || "approval" in result).toBe(false);
  });

  it("separates hedged long and short legs and multiple markets", () => {
    const long = previewPaperPerpetualProposal(fixture);
    const short = previewPaperPerpetualProposal({
      ...fixture,
      side: "short",
      stopPriceQuote: "105",
      takeProfitPriceQuote: "90",
    });
    expect(long.status).toBe("inert_preview");
    expect(short.status).toBe("inert_preview");
    if (long.status !== "inert_preview" || short.status !== "inert_preview") return;
    expect(long.positionBucket).not.toBe(short.positionBucket);
    expect(short.side).toBe("short");
    expect(Number(short.worstCaseStopLossQuote)).toBeGreaterThan(0);
    const ether = previewPaperPerpetualProposal({
      ...fixture,
      instrument: "ETH-USDT-SWAP",
    });
    expect(ether.status).toBe("inert_preview");
    if (ether.status === "inert_preview") {
      expect(ether.positionBucket).not.toBe(long.positionBucket);
    }
  });

  it("rejects leverage above each preset", () => {
    expectDenial({ strategy: "conservative", leverage: 6 }, "leverage_exceeded");
    expectDenial({ strategy: "moderate", leverage: 11 }, "leverage_exceeded");
    const allowed = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 3,
    });
    expect(allowed.status).toBe("inert_preview");
  });

  it("rejects invalid exits and unsupported spot symbols", () => {
    expectDenial({ stopPriceQuote: "101" }, "invalid_exit_prices");
    expectDenial({ takeProfitPriceQuote: "98" }, "invalid_exit_prices");
    expectDenial({ side: "short", stopPriceQuote: "95" }, "invalid_exit_prices");
    expectDenial({ instrument: "BTC-USDT" }, "unsupported_market");
  });

  it("evaluates cross margin from account equity, not isolated order margin", () => {
    const result = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 3,
      quantityBase: "0.3",
      stopPriceQuote: "65",
      takeProfitPriceQuote: "120",
    });
    expect(result.status).toBe("inert_preview");
    if (result.status !== "inert_preview") return;
    expect(Number(result.collateralRemainingAtStopQuote)).toBeGreaterThan(980);
    expect(Number(result.equityRemainingAfterStressQuote)).toBeGreaterThan(500);
    expect(result.peakDrawdownPercent).toBe("0.00");
  });

  it("checks cash, exposure, risk, daily loss and position slots", () => {
    expectDenial({ availableQuote: "1" }, "insufficient_margin");
    expectDenial(
      {
        portfolio: {
          ...fixture.portfolio,
          openNotionalQuote: "4000",
          openLongNotionalQuote: "4000",
        },
      },
      "catastrophic_survival_exceeded",
    );
    expectDenial(
      { portfolio: { ...fixture.portfolio, openStopRiskQuote: "19.9" } },
      "risk_budget_exceeded",
    );
    expectDenial(
      { portfolio: { ...fixture.portfolio, realizedLossTodayQuote: "30" } },
      "risk_budget_exceeded",
    );
    expectDenial(
      { portfolio: { ...fixture.portfolio, openPositions: 3 } },
      "position_count_exceeded",
    );
  });

  it("permits independently risk-bounded exposure with high leverage, not automatic full leverage", () => {
    const cases = [
      { strategy: "conservative", leverage: 5, quantityBase: "3" },
      { strategy: "moderate", leverage: 10, quantityBase: "4" },
      { strategy: "aggressive", leverage: 20, quantityBase: "5" },
    ] as const;
    for (const candidate of cases) {
      const result = previewPaperPerpetualProposal({
        ...fixture,
        ...candidate,
        stopPriceQuote: "99.95",
        takeProfitPriceQuote: "105",
      });
      expect(result, candidate.strategy).toMatchObject({ status: "inert_preview" });
    }
  });

  it("rejects proposals that exhaust post-shock equity despite a nearby stop", () => {
    expectDenial(
      {
        strategy: "aggressive",
        leverage: 20,
        quantityBase: "35",
        stopPriceQuote: "99.95",
        takeProfitPriceQuote: "105",
      },
      "catastrophic_survival_exceeded",
    );
  });

  it("does not net opposite hedge exposure away when stress testing", () => {
    expectDenial(
      {
        strategy: "aggressive",
        side: "short",
        leverage: 20,
        quantityBase: "10",
        stopPriceQuote: "100.05",
        takeProfitPriceQuote: "95",
        portfolio: {
          ...fixture.portfolio,
          openNotionalQuote: "3000",
          openLongNotionalQuote: "3000",
        },
      },
      "catastrophic_survival_exceeded",
    );
  });

  it("rejects a 50-percent crash exposure and a full collapse exposure independently of leverage", () => {
    const bigLong = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 20,
      quantityBase: "15",
      stopPriceQuote: "99.99",
      takeProfitPriceQuote: "110",
    });
    expect(bigLong).toMatchObject({
      status: "deny",
      reason: "catastrophic_survival_exceeded",
    });
    const smallLong = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 20,
      quantityBase: "4",
      stopPriceQuote: "99.99",
      takeProfitPriceQuote: "110",
    });
    expect(smallLong).toMatchObject({ status: "inert_preview" });
    if (smallLong.status === "inert_preview") {
      expect(Number(smallLong.equityRemainingAfterCatastropheQuote)).toBeGreaterThan(200);
    }
  });

  it("refuses a short too large to withstand a 200-percent adverse price rally", () => {
    const result = previewPaperPerpetualProposal({
      ...fixture,
      side: "short",
      strategy: "aggressive",
      leverage: 20,
      quantityBase: "4",
      stopPriceQuote: "100.01",
      takeProfitPriceQuote: "90",
    });
    expect(result).toMatchObject({
      status: "deny",
      reason: "catastrophic_survival_exceeded",
    });
  });

  it("rejects conflicting long and short gross evidence", () => {
    expectDenial(
      {
        portfolio: {
          ...fixture.portfolio,
          openNotionalQuote: "100",
          openLongNotionalQuote: "0",
          openShortNotionalQuote: "0",
        },
      },
      "invalid_input",
    );
  });

  it("reserves capital and worst-case stop risk for future adds BEFORE first fill", () => {
    for (const strategy of ["conservative", "moderate", "aggressive"] as const) {
      const first = previewPaperPerpetualProposal({
        ...fixture,
        strategy,
        additionalRecoveryNotionalQuote: "5",
      });
      expect(first.status, strategy).toBe("inert_preview");
      if (first.status !== "inert_preview") continue;
      expect(first.plannedRecoveryNotionalQuote).toBe("5");
      expect(Number(first.plannedRecoveryRiskQuote)).toBeGreaterThan(0);
      expect(Number(first.equityRemainingAfterCatastropheQuote)).toBeLessThan(1000);
    }
  });

  it("prevents an unrelated entry from spending committed recovery capacity", () => {
    const withoutReservation = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 20,
      quantityBase: "3",
      stopPriceQuote: "99.9",
      takeProfitPriceQuote: "120",
      portfolio: {
        ...fixture.portfolio,
        openPositions: 1,
        openNotionalQuote: "100",
        openLongNotionalQuote: "100",
        openStopRiskQuote: "1",
      },
    });
    expect(withoutReservation.status).toBe("inert_preview");
    const withReservation = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 20,
      quantityBase: "3",
      stopPriceQuote: "99.9",
      takeProfitPriceQuote: "120",
      portfolio: {
        ...fixture.portfolio,
        openPositions: 1,
        openNotionalQuote: "100",
        openLongNotionalQuote: "100",
        recoveryLongNotionalQuote: "400",
        recoveryReservedRiskQuote: "1",
        openStopRiskQuote: "1",
      },
    });
    expect(withReservation).toMatchObject({
      status: "deny",
      reason: "catastrophic_survival_exceeded",
    });
  });

  it("reserves risk capacity as well as gross notional for future buys", () => {
    const decision = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "moderate",
      portfolio: {
        ...fixture.portfolio,
        openPositions: 1,
        openNotionalQuote: "100",
        openLongNotionalQuote: "100",
        openStopRiskQuote: "1",
        sameIdeaStopRiskQuote: "1",
        recoveryLongNotionalQuote: "10",
        recoveryReservedRiskQuote: "8.7",
        sameIdeaReservedRiskQuote: "8.7",
      },
    });
    expect(decision).toMatchObject({ status: "deny", reason: "risk_budget_exceeded" });
  });

  it("fails closed if marked account equity is missing", () => {
    expectDenial({ portfolio: { ...fixture.portfolio, markedEquityQuote: "0" } }, "invalid_input");
  });

  it("combines all same-direction entries under the per-idea risk budget", () => {
    expectDenial(
      {
        portfolio: {
          ...fixture.portfolio,
          openPositions: 1,
          openNotionalQuote: "100",
          openLongNotionalQuote: "100",
          openStopRiskQuote: "9.8",
          sameIdeaStopRiskQuote: "9.8",
        },
      },
      "risk_budget_exceeded",
    );
  });

  it("a distinct opposing hedge has its own idea risk, but shares gross portfolio limits", () => {
    const proposedHedge = previewPaperPerpetualProposal({
      ...fixture,
      side: "short",
      stopPriceQuote: "105",
      takeProfitPriceQuote: "90",
      portfolio: {
        ...fixture.portfolio,
        openPositions: 1,
        openNotionalQuote: "100",
        openLongNotionalQuote: "100",
        openStopRiskQuote: "9.8",
        sameIdeaStopRiskQuote: "0",
      },
    });
    expect(proposedHedge.status).toBe("inert_preview");
  });

  it("rejects inconsistent same-idea risk greater than aggregate committed risk", () => {
    expectDenial(
      {
        portfolio: {
          ...fixture.portfolio,
          openStopRiskQuote: "1",
          sameIdeaStopRiskQuote: "2",
        },
      },
      "invalid_input",
    );
  });

  it("reduces fresh position risk after high-watermark drawdown in all strategies", () => {
    for (const c of [
      { strategy: "conservative", marked: "974", normal: "1000", largeQty: "0.5" },
      { strategy: "moderate", marked: "949", normal: "1000", largeQty: "1.5" },
      { strategy: "aggressive", marked: "919", normal: "1000", largeQty: "3" },
    ] as const) {
      const proposal = {
        ...fixture,
        strategy: c.strategy,
        stopPriceQuote: "95",
        takeProfitPriceQuote: "110",
        quantityBase: c.largeQty,
        portfolio: {
          ...fixture.portfolio,
          markedEquityQuote: c.marked,
          peakEquityQuote: c.normal,
        },
      };
      expect(previewPaperPerpetualProposal(proposal), c.strategy).toMatchObject({
        status: "deny",
        reason: "risk_budget_exceeded",
      });
      const unrestricted = previewPaperPerpetualProposal({
        ...proposal,
        portfolio: { ...fixture.portfolio },
      });
      expect(unrestricted.status, c.strategy).toBe("inert_preview");
    }
  });

  it("freezes fresh entries at each profile high-watermark breaker", () => {
    for (const c of [
      { strategy: "conservative", marked: "950" },
      { strategy: "moderate", marked: "900" },
      { strategy: "aggressive", marked: "850" },
    ] as const) {
      const result = previewPaperPerpetualProposal({
        ...fixture,
        strategy: c.strategy,
        portfolio: {
          ...fixture.portfolio,
          markedEquityQuote: c.marked,
        },
      });
      expect(result, c.strategy).toMatchObject({
        status: "deny",
        reason: "drawdown_circuit_breaker",
      });
    }
  });

  it("uses the verified historical peak rather than only the initial 1000 USDT", () => {
    expectDenial(
      {
        portfolio: { ...fixture.portfolio, markedEquityQuote: "1050", peakEquityQuote: "1200" },
      },
      "drawdown_circuit_breaker",
    );
    expectDenial(
      {
        portfolio: { ...fixture.portfolio, markedEquityQuote: "1100", peakEquityQuote: "1050" },
      },
      "invalid_input",
    );
  });

  it("fails closed on malformed prices and fee/maintenance inputs", () => {
    for (const value of ["-1", "1e3", "0.000000001", "NaN", ""]) {
      expectDenial({ entryPriceQuote: value }, "invalid_input");
    }
    expectDenial({ assumedFeeBpsPerSide: Number.NaN }, "invalid_input");
    expectDenial({ maintenanceMarginBps: 0 }, "invalid_input");
  });
});
