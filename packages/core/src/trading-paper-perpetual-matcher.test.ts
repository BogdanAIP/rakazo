import { describe, expect, it } from "vitest";
import {
  previewPerpetualPaperOrderMatch,
  type PerpetualPaperOrder,
  type PerpetualPaperPublicBook,
} from "./trading-paper-perpetual-matcher.js";

const order: PerpetualPaperOrder = {
  accountId: "paper.one",
  strategy: "moderate",
  venue: "okx",
  instrument: "BTC-USDT-SWAP",
  positionSide: "long",
  intent: "open",
  action: "buy",
  orderType: "market",
  timeInForce: "gtc",
  quantityBase: "1",
  alreadyFilledBase: "0",
  lotIncrement: "0.01",
  limitPriceQuote: null,
  triggerPriceQuote: null,
  positionAvailableBase: null,
  submittedAt: "2026-10-11T00:00:00.000Z",
  expiresAt: "2026-10-11T00:15:00.000Z",
};
const book: PerpetualPaperPublicBook = {
  venue: "okx",
  instrument: "BTC-USDT-SWAP",
  sourceId: "market:okx:candle1",
  bidQuote: "99",
  askQuote: "100",
  bidAvailableBase: "3",
  askAvailableBase: "0.45",
  observedAt: "2026-10-11T00:01:00.000Z",
};
const now = "2026-10-11T00:01:01.000Z";

function check(
  overrides: Partial<PerpetualPaperOrder> = {},
  quote: Partial<PerpetualPaperPublicBook> = {},
  clock = now,
) {
  return previewPerpetualPaperOrderMatch({ ...order, ...overrides }, { ...book, ...quote }, clock);
}

describe("non-executing USDT swap order matcher", () => {
  it("only previews observed top-of-book liquidity and explicit IOC cancellation", () => {
    const result = check({ timeInForce: "ioc" });
    expect(result.status).toBe("inert_fill_preview");
    if (result.status !== "inert_fill_preview") return;
    expect(result.filledBase).toBe("0.45");
    expect(result.remainingBase).toBe("0.55");
    expect(result.partial).toBe(true);
    expect(result.cancelRemaining).toBe(true);
    expect(result.executionPriceQuote).toBe("100");
    expect("submit" in result || "orderId" in result || "broker" in result).toBe(false);
  });

  it("waits for limit crossing and uses bid for short entries", () => {
    expect(check({ orderType: "limit", limitPriceQuote: "99" })).toMatchObject({
      status: "not_filled",
      reason: "not_crossed",
    });
    const crossed = check({ orderType: "limit", limitPriceQuote: "100" });
    expect(crossed.status).toBe("inert_fill_preview");
    expect(
      check({ positionSide: "short", action: "sell" }, { bidAvailableBase: "2" }),
    ).toMatchObject({
      status: "inert_fill_preview",
      executionPriceQuote: "99",
      filledBase: "1",
    });
  });

  it("requires verified reduce-only side and available matching position", () => {
    const stop = {
      intent: "reduce_only" as const,
      action: "sell" as const,
      orderType: "stop_market" as const,
      triggerPriceQuote: "98",
      positionAvailableBase: "1",
    };
    expect(check(stop)).toMatchObject({ status: "not_filled", reason: "not_triggered" });
    expect(check(stop, { bidQuote: "97" })).toMatchObject({
      status: "inert_fill_preview",
      executionPriceQuote: "97",
    });
    expect(check({ ...stop, positionAvailableBase: "0.5" })).toMatchObject({
      status: "deny",
      reason: "reduce_only_would_reverse",
    });
    expect(check({ ...stop, action: "buy" })).toMatchObject({
      status: "deny",
      reason: "invalid_direction_or_reduce_only",
    });
    expect(check({ orderType: "stop_market", triggerPriceQuote: "98" })).toMatchObject({
      status: "deny",
      reason: "conditional_orders_must_reduce_position",
    });
  });

  it("supports independent short protective buy, long profit sell and multi-pair books", () => {
    const shortStop = check(
      {
        positionSide: "short",
        intent: "reduce_only",
        action: "buy",
        orderType: "stop_market",
        triggerPriceQuote: "100",
        positionAvailableBase: "1",
      },
    );
    expect(shortStop.status).toBe("inert_fill_preview");
    const profit = check(
      {
        intent: "reduce_only",
        action: "sell",
        orderType: "take_profit_market",
        triggerPriceQuote: "105",
        positionAvailableBase: "1",
      },
      { bidQuote: "110", askQuote: "111" },
    );
    expect(profit.status).toBe("inert_fill_preview");
    expect(check(
      { instrument: "ETH-USDT-SWAP" },
      { instrument: "ETH-USDT-SWAP" },
    ).status).toBe("inert_fill_preview");
  });

  it("rejects stale, future, expired and mismatched market evidence", () => {
    expect(check({}, {}, "2026-10-11T00:02:00.000Z")).toMatchObject({
      status: "not_filled",
      reason: "stale_quote",
    });
    expect(check({}, {}, "2026-10-11T00:16:00.000Z")).toMatchObject({
      status: "not_filled",
      reason: "expired",
    });
    expect(check({ instrument: "ETH-USDT-SWAP" })).toMatchObject({
      status: "deny",
      reason: "unsupported_or_mismatched_public_market",
    });
    expect(check({}, { sourceId: "" })).toMatchObject({
      status: "deny",
      reason: "missing_provenance",
    });
    expect(check({}, { observedAt: "2026-10-11T00:01:05.000Z" })).toMatchObject({
      status: "deny",
      reason: "future_or_pre_submission_quote",
    });
  });

  it("refuses invented liquidity, invalid precision and malformed quote spread", () => {
    expect(check({}, { askAvailableBase: "0.001" })).toMatchObject({
      status: "not_filled",
      reason: "empty_book",
    });
    expect(check({}, { bidQuote: "101" })).toMatchObject({
      status: "deny",
      reason: "invalid_quantity_or_order_book",
    });
    expect(check({ quantityBase: "0.000000001" })).toMatchObject({
      status: "deny",
      reason: "invalid_exact_amount_or_clock",
    });
    expect(check({ alreadyFilledBase: "1" })).toMatchObject({
      status: "deny",
      reason: "invalid_quantity_or_order_book",
    });
  });
});
