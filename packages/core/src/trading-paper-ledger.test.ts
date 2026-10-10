import { TradingInstrumentSchema, TradingPaperLedgerInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { replayTradingPaperLedger } from "./trading-paper-ledger.js";

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
const openedAt = "2026-10-04T08:00:00.000Z";
const context = { ledgerId: "synthetic-ledger-1" };
const reserve = {
  ...context,
  kind: "reserve" as const,
  eventId: "event-1",
  sequence: 1,
  recordedAt: "2026-10-04T08:01:00.000Z",
  reservationId: "paper-reservation-1",
  signalId: "research-signal-1",
  market,
  quantityBase: "2",
  maxSpendQuote: "220",
  expiresAt: "2026-10-04T09:00:00.000Z",
};
const buy = {
  ...context,
  kind: "fill_buy" as const,
  eventId: "event-2",
  sequence: 2,
  recordedAt: "2026-10-04T08:02:00.000Z",
  reservationId: reserve.reservationId,
  quantityBase: "2",
  executedPriceQuote: "100.12",
  feeQuote: "0.20",
};
const sell = {
  ...context,
  kind: "fill_sell" as const,
  eventId: "event-3",
  sequence: 3,
  recordedAt: "2026-10-04T08:03:00.000Z",
  positionId: reserve.reservationId,
  quantityBase: "2",
  executedPriceQuote: "110",
  feeQuote: "0.22",
};
const input = (events: unknown[]) =>
  TradingPaperLedgerInputSchema.parse({
    version: "paper_spot_full_fill_v1",
    ledgerId: context.ledgerId,
    openedAt,
    quoteCurrency: "USDT",
    initialBalanceQuote: "1000",
    events,
  });
const run = (events: unknown[]) => replayTradingPaperLedger(input(events));

describe("paper spot ledger: idempotent exact-decimal event replay", () => {
  it("reserves virtual cash, buys, closes and conserves every quote unit", () => {
    const held = run([reserve]);
    expect(held.availableQuote).toBe("780");
    expect(held.reservedQuote).toBe("220");
    expect(held.bookEquityQuote).toBe("1000");
    const purchased = run([reserve, buy]);
    expect(purchased.availableQuote).toBe("799.56");
    expect(purchased.reservedQuote).toBe("0");
    expect(purchased.openCostBasisQuote).toBe("200.44");
    expect(purchased.positions).toHaveLength(1);
    expect(purchased.bookEquityQuote).toBe("1000");
    const closed = run([reserve, buy, sell]);
    expect(closed.availableQuote).toBe("1019.34");
    expect(closed.realizedPnlQuote).toBe("19.34");
    expect(closed.totalFeesQuote).toBe("0.42");
    expect(closed.bookEquityQuote).toBe("1019.34");
    expect(closed.positions).toEqual([]);
    expect(closed.reservations).toEqual([]);
    expect(closed.nextSequence).toBe(4);
  });

  it("treats a replayed identical event as a no-op even after later events", () => {
    const baseline = run([reserve, buy, sell]);
    const retry = run([reserve, buy, sell, reserve, buy, sell]);
    expect(retry.availableQuote).toBe(baseline.availableQuote);
    expect(retry.realizedPnlQuote).toBe(baseline.realizedPnlQuote);
    expect(retry.acceptedEvents).toBe(3);
    expect(retry.retryEvents).toBe(3);
    expect(retry.nextSequence).toBe(4);
    expect(() => run([reserve, { ...reserve, maxSpendQuote: "200" }])).toThrow(
      "Conflicting duplicate",
    );
  });

  it("reconstructs the same final state from identical retained journal content", () => {
    const journal = input([reserve, buy, sell]);
    const recovered = replayTradingPaperLedger(
      TradingPaperLedgerInputSchema.parse(JSON.parse(JSON.stringify(journal))),
    );
    expect(recovered).toEqual(replayTradingPaperLedger(journal));
  });

  it("rejects journal forks, wrong ledger, backward clocks and mismatched signal identities", () => {
    expect(() => run([{ ...reserve, sequence: 2 }])).toThrow("sequence");
    expect(() => run([reserve, { ...buy, sequence: 4 }])).toThrow("sequence");
    expect(() => run([{ ...reserve, ledgerId: "another-ledger" }])).toThrow("Cross-ledger");
    expect(() => run([reserve, { ...buy, recordedAt: "2026-10-04T08:00:00.000Z" }])).toThrow(
      "backwards",
    );
    const release = {
      ...context,
      kind: "release",
      eventId: "event-2",
      sequence: 2,
      recordedAt: "2026-10-04T08:02:00.000Z",
      reservationId: reserve.reservationId,
    };
    const repeatSignal = {
      ...reserve,
      eventId: "event-3",
      sequence: 3,
      recordedAt: "2026-10-04T08:03:00.000Z",
      reservationId: "another-reservation",
    };
    expect(() => run([reserve, release, repeatSignal])).toThrow("already consumed");
  });

  it("refuses overspending, inactive/futures markets, invalid increments or expired fills", () => {
    expect(() => run([{ ...reserve, maxSpendQuote: "1001" }])).toThrow("Insufficient");
    expect(() => run([{ ...reserve, market: { ...market, status: "inactive" } }])).toThrow(
      "active spot",
    );
    expect(() => run([{ ...reserve, market: { ...market, kind: "perpetual" } }])).toThrow(
      "active spot",
    );
    expect(() => run([{ ...reserve, market: { ...market, quote: "USDC" } }])).toThrow("currency");
    expect(() => run([{ ...reserve, quantityBase: "2.001" }])).toThrow("lot-aligned");
    expect(() =>
      run([{ ...reserve, market: { ...market, priceIncrement: "0.000000001" } }, buy]),
    ).toThrow("precision");
    expect(() =>
      run([{ ...reserve, market: { ...market, quantityIncrement: "0.000000001" } }]),
    ).toThrow("precision");
    expect(() => run([reserve, { ...buy, quantityBase: "1" }])).toThrow("full lot");
    expect(() => run([reserve, { ...buy, executedPriceQuote: "100.121" }])).toThrow("tick-aligned");
    expect(() => run([reserve, { ...buy, feeQuote: "25" }])).toThrow("exceeded");
    expect(() => run([reserve, { ...buy, recordedAt: reserve.expiresAt }])).toThrow("expiry");
    expect(() => run([reserve, { ...buy, recordedAt: "2026-10-04T09:00:01.000Z" }])).toThrow(
      "expiry",
    );
  });

  it("refuses double-spending and invalid or repeated full closes", () => {
    expect(() => run([{ ...sell, sequence: 1 }])).toThrow("open matching position");
    expect(() => run([reserve, buy, { ...sell, quantityBase: "1" }])).toThrow("full lot");
    expect(() => run([reserve, buy, { ...sell, executedPriceQuote: "110.001" }])).toThrow(
      "tick-aligned",
    );
    const secondClose = {
      ...sell,
      eventId: "event-4",
      sequence: 4,
      recordedAt: "2026-10-04T08:04:00.000Z",
    };
    expect(() => run([reserve, buy, sell, secondClose])).toThrow("open matching position");
  });

  it("can release held quote but cannot release or fill it a second time", () => {
    const release = {
      ...context,
      kind: "release",
      eventId: "event-2",
      sequence: 2,
      recordedAt: "2026-10-04T08:02:00.000Z",
      reservationId: reserve.reservationId,
    };
    expect(run([reserve, release]).availableQuote).toBe("1000");
    expect(run([reserve, release]).reservedQuote).toBe("0");
    expect(() => run([reserve, release, { ...buy, eventId: "event-3", sequence: 3 }])).toThrow(
      "outstanding reservation",
    );
    expect(() => run([reserve, release, { ...release, eventId: "event-3", sequence: 3 }])).toThrow(
      "No open",
    );
  });

  it("uses conservative quote rounding for sub-cent virtual amounts", () => {
    const tinyMarket = {
      ...market,
      priceIncrement: "0.00000001",
      quantityIncrement: "0.00000001",
      minNotional: null,
    };
    const tinyReserve = {
      ...reserve,
      market: tinyMarket,
      quantityBase: "0.00000001",
      maxSpendQuote: "0.00000002",
    };
    const tinyBuy = {
      ...buy,
      quantityBase: "0.00000001",
      executedPriceQuote: "0.00000001",
      feeQuote: "0",
    };
    const tinySell = {
      ...sell,
      quantityBase: "0.00000001",
      executedPriceQuote: "0.00000001",
      feeQuote: "0",
    };
    const result = run([tinyReserve, tinyBuy, tinySell]);
    expect(result.availableQuote).toBe("999.99999999");
    expect(result.realizedPnlQuote).toBe("-0.00000001");
    expect(result.bookEquityQuote).toBe(result.availableQuote);
  });
});
