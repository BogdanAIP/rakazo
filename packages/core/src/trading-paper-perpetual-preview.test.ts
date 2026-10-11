import { describe, expect, it } from "vitest";
import {
  type PaperPerpetualProposalInput,
  previewPaperPerpetualProposal,
} from "./trading-paper-perpetual-preview.js";

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

  it("rejects a stop beyond approximate maintenance collateral", () => {
    expectDenial(
      {
        strategy: "aggressive",
        leverage: 3,
        quantityBase: "0.3",
        stopPriceQuote: "65",
        takeProfitPriceQuote: "120",
      },
      "liquidation_before_stop",
    );
  });

  it("checks cash, exposure, risk, daily loss and position slots", () => {
    expectDenial({ availableQuote: "1" }, "insufficient_margin");
    expectDenial(
      { portfolio: { ...fixture.portfolio, openNotionalQuote: "999" } },
      "notional_exceeded",
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

  it("fails closed on malformed prices and fee/maintenance inputs", () => {
    for (const value of ["-1", "1e3", "0.000000001", "NaN", ""]) {
      expectDenial({ entryPriceQuote: value }, "invalid_input");
    }
    expectDenial({ assumedFeeBpsPerSide: Number.NaN }, "invalid_input");
    expectDenial({ maintenanceMarginBps: 0 }, "invalid_input");
  });
});
