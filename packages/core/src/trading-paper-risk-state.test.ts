import { TradingInstrumentSchema, TradingPaperLedgerInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { deriveTradingPaperRiskState } from "./trading-paper-risk-state.js";

const market = TradingInstrumentSchema.parse({
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
const base = {
  version: "paper_spot_full_fill_v1" as const,
  ledgerId: "risk-ledger",
  openedAt: "2026-10-03T08:00:00.000Z",
  quoteCurrency: "USDT",
  initialBalanceQuote: "1000",
};
const reserve = (id: string, sequence: number, at: string) => ({
  ledgerId: base.ledgerId,
  kind: "reserve" as const,
  eventId: `reserve-${id}`,
  sequence,
  recordedAt: at,
  reservationId: id,
  signalId: `signal-${id}`,
  market,
  quantityBase: "1",
  maxSpendQuote: "110",
  expiresAt: "2026-10-05T00:00:00.000Z",
});
const buy = (id: string, sequence: number, at: string, price = "100") => ({
  ledgerId: base.ledgerId,
  kind: "fill_buy" as const,
  eventId: `buy-${id}`,
  sequence,
  recordedAt: at,
  reservationId: id,
  quantityBase: "1",
  executedPriceQuote: price,
  feeQuote: "0",
});
const sell = (id: string, sequence: number, at: string, price: string) => ({
  ledgerId: base.ledgerId,
  kind: "fill_sell" as const,
  eventId: `sell-${id}`,
  sequence,
  recordedAt: at,
  positionId: id,
  quantityBase: "1",
  executedPriceQuote: price,
  feeQuote: "0",
});
const input = (events: unknown[]) =>
  TradingPaperLedgerInputSchema.parse({ ...base, events });

describe("derived paper risk state", () => {
  it("derives UTC daily pnl/loss exactly and does not let wins erase gross daily loss", () => {
    const events = [
      reserve("prior", 1, "2026-10-03T09:00:00.000Z"),
      buy("prior", 2, "2026-10-03T09:01:00.000Z"),
      sell("prior", 3, "2026-10-03T10:00:00.000Z", "90"),
      reserve("loss", 4, "2026-10-04T08:00:00.000Z"),
      buy("loss", 5, "2026-10-04T08:01:00.000Z"),
      sell("loss", 6, "2026-10-04T08:02:00.000Z", "95"),
      reserve("win", 7, "2026-10-04T08:03:00.000Z"),
      buy("win", 8, "2026-10-04T08:04:00.000Z"),
      sell("win", 9, "2026-10-04T08:05:00.000Z", "110"),
    ];
    const risk = deriveTradingPaperRiskState(input(events), new Date("2026-10-04T12:00:00Z"));
    expect(risk.realizedPnlTodayQuote).toBe("5");
    expect(risk.realizedLossTodayQuote).toBe("5");
    expect(risk.openExposureQuote).toBe("0");
    expect(risk.openStopRiskQuote).toBe("0");
    expect(risk.stopRiskComplete).toBe(true);
  });

  it("counts reserved/cost exposure and refuses to fabricate stop risk for an open position", () => {
    const open = deriveTradingPaperRiskState(
      input([
        reserve("position", 1, "2026-10-04T08:00:00.000Z"),
        buy("position", 2, "2026-10-04T08:01:00.000Z"),
        reserve("held", 3, "2026-10-04T08:02:00.000Z"),
      ]),
      new Date("2026-10-04T12:00:00Z"),
    );
    expect(open.openCostBasisQuote).toBe("100");
    expect(open.reservedQuote).toBe("110");
    expect(open.openExposureQuote).toBe("210");
    expect(open.openPositions).toBe(1);
    expect(open.openReservations).toBe(1);
    expect(open.openStopRiskQuote).toBeNull();
    expect(open.stopRiskComplete).toBe(false);
  });

  it("uses exact sub-cent loss accounting", () => {
    const tinyMarket = {
      ...market,
      priceIncrement: "0.00000001",
      quantityIncrement: "0.00000001",
      minNotional: null,
    };
    const events = [
      {
        ...reserve("tiny", 1, "2026-10-04T08:00:00.000Z"),
        market: tinyMarket,
        quantityBase: "0.00000001",
        maxSpendQuote: "0.00000002",
      },
      {
        ...buy("tiny", 2, "2026-10-04T08:01:00.000Z", "0.00000001"),
        quantityBase: "0.00000001",
      },
      {
        ...sell("tiny", 3, "2026-10-04T08:02:00.000Z", "0.00000001"),
        quantityBase: "0.00000001",
      },
    ];
    const risk = deriveTradingPaperRiskState(input(events), new Date("2026-10-04T12:00:00Z"));
    expect(risk.realizedPnlTodayQuote).toBe("-0.00000001");
    expect(risk.realizedLossTodayQuote).toBe("0.00000001");
  });
});
