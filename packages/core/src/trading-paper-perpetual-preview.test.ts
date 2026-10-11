import { describe, expect, it } from "vitest";
import { previewPaperPerpetualProposal, type PaperPerpetualProposalInput } from "./trading-paper-perpetual-preview.js";

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
    openStopRiskQuote: "0",
    realizedLossTodayQuote: "0",
  },
  assumedFeeBpsPerSide: 10,
  assumedSlippageBpsPerSide: 10,
  maintenanceMarginBps: 50,
};

describe("inert, risk-bounded PAPER perpetual proposals", () => {
  it("previews a long without exposing any order submission authority", () => {
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

  it("keeps simultaneous long and short for the same symbol in independent hedge buckets", () => {
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
    expect(long.side).toBe("long");
    expect(short.side).toBe("short");
    expect(Number(short.worstCaseStopLossQuote)).toBeGreaterThan(0);
    const ether = previewPaperPerpetualProposal({
      ...fixture,
      instrument: "ETH-USDT-SWAP",
    });
    expect(ether.status).toBe("inert_preview");
    if (ether.status !== "inert_preview") {
      return;
    }
    expect(ether.positionBucket).not.toBe(long.positionBucket);
  });

  it("blocks leverage beyond the selected account preset", () => {
    expect(previewPaperPerpetualProposal({ ...fixture, strategy: "conservative", leverage: 2 }))
      .toMatchObject({ status: "deny", reason: "leverage_exceeded" });
    expect(previewPaperPerpetualProposal({ ...fixture, strategy: "moderate", leverage: 3 }))
      .toMatchObject({ status: "deny", reason: "leverage_exceeded" });
    expect(previewPaperPerpetualProposal({ ...fixture, strategy: "aggressive", leverage: 3 })
      .status).toBe("inert_preview");
  });

  it("rejects stops/targets on the wrong side of entry and spot instruments", () => {
    expect(previewPaperPerpetualProposal({ ...fixture, stopPriceQuote: "101" }))
      .toMatchObject({ status: "deny", reason: "invalid_exit_prices" });
    expect(previewPaperPerpetualProposal({ ...fixture, takeProfitPriceQuote: "98" }))
      .toMatchObject({ status: "deny", reason: "invalid_exit_prices" });
    expect(previewPaperPerpetualProposal({ ...fixture, side: "short", stopPriceQuote: "95" }))
      .toMatchObject({ status: "deny", reason: "invalid_exit_prices" });
    expect(previewPaperPerpetualProposal({ ...fixture, instrument: "BTC-USDT" }))
      .toMatchObject({ status: "deny", reason: "unsupported_market" });
  });

  it("rejects liquidation-prone proposals even when the position fits a nominal idea budget", () => {
    const result = previewPaperPerpetualProposal({
      ...fixture,
      strategy: "aggressive",
      leverage: 3,
      quantityBase: "0.3",
      stopPriceQuote: "65",
      takeProfitPriceQuote: "120",
    });
    expect(result).toMatchObject({ status: "deny", reason: "liquidation_before_stop" });
  });

  it("checks available collateral, total notional, open risk, daily loss and concurrent slots", () => {
    expect(previewPaperPerpetualProposal({ ...fixture, availableQuote: "1" }))
      .toMatchObject({ status: "deny", reason: "insufficient_margin" });
    expect(previewPaperPerpetualProposal({
      ...fixture,
      portfolio: { ...fixture.portfolio, openNotionalQuote: "999" },
    })).toMatchObject({ status: "deny", reason: "notional_exceeded" });
    expect(previewPaperPerpetualProposal({
      ...fixture,
      portfolio: { ...fixture.portfolio, openStopRiskQuote: "19.9" },
    })).toMatchObject({ status: "deny", reason: "risk_budget_exceeded" });
    expect(previewPaperPerpetualProposal({
      ...fixture,
      portfolio: { ...fixture.portfolio, realizedLossTodayQuote: "30" },
    })).toMatchObject({ status: "deny", reason: "risk_budget_exceeded" });
    expect(previewPaperPerpetualProposal({
      ...fixture,
      portfolio: { ...fixture.portfolio, openPositions: 3 },
    })).toMatchObject({ status: "deny", reason: "position_count_exceeded" });
  });

  it("never accepts negative, exponent, imprecise prices, impossible fees or NaN", () => {
    for (const value of ["-1", "1e3", "0.000000001", "NaN", ""]) {
      expect(previewPaperPerpetualProposal({ ...fixture, entryPriceQuote: value }))
        .toMatchObject({ status: "deny", reason: "invalid_input" });
    }
    expect(previewPaperPerpetualProposal({ ...fixture, assumedFeeBpsPerSide: Number.NaN }))
      .toMatchObject({ status: "deny", reason: "invalid_input" });
    expect(previewPaperPerpetualProposal({ ...fixture, maintenanceMarginBps: 0 }))
      .toMatchObject({ status: "deny", reason: "invalid_input" });
  });
});
