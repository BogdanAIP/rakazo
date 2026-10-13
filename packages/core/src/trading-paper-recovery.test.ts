import type { PaperPerpetualEngineBatch, PaperPerpetualEngineSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { summarizePaperPositionRecovery } from "./trading-paper-recovery.js";

type MinimalFill = {
  kind: string;
  orderId: string;
  positionId: string;
  quantityBase: string;
  priceQuote: string;
  commission: string;
};
const buy = (id: string, qty: string, price: string, fee = "0.05 USDT"): MinimalFill => ({
  kind: "fill",
  orderId: id,
  positionId: "p1",
  quantityBase: qty,
  priceQuote: price,
  commission: fee,
});
const transition = (
  command: "buy" | "sell" | null,
  event: MinimalFill | null,
  position: null | { quantityBase: string; markPriceQuote: string },
  funding: string | null = null,
  side: "long" | "short" = "long",
) => ({
  input: {
    commands:
      command && event
        ? [
            {
              kind: "order",
              orderId: event.orderId,
              positionId: "p1",
              instrument: "BTC-USDT-SWAP",
              action: command,
              quantityBase: event.quantityBase,
              reduceOnly: command === (side === "long" ? "sell" : "buy"),
              orderType: "market",
              limitPriceQuote: null,
            },
          ]
        : [],
  } as PaperPerpetualEngineBatch,
  output: {
    events: [
      ...(event ? [event] : []),
      ...(funding ? [{ kind: "funding", positionId: "p1", paymentQuoteSigned: funding }] : []),
    ],
    positions: position
      ? [
          {
            positionId: "p1",
            side: side === "long" ? "LONG" : "SHORT",
            instrument: "BTC-USDT-SWAP",
            entryPriceQuote: "100",
            ...position,
          },
        ]
      : [],
  } as unknown as PaperPerpetualEngineSnapshot,
});

describe("PAPER native, position-scoped recovery scoring", () => {
  it("tracks a 50-percent drawdown, a protected scale-in, funding and a net profitable exit", () => {
    const series = [
      transition("buy", buy("open", "1", "100"), { quantityBase: "1", markPriceQuote: "100" }),
      transition(null, null, { quantityBase: "1", markPriceQuote: "50" }),
      transition(
        "buy",
        buy("add", "0.5", "50", "0.03 USDT"),
        { quantityBase: "1.5", markPriceQuote: "50" },
        "-0.02",
      ),
      transition(null, null, { quantityBase: "1.5", markPriceQuote: "90" }),
      transition("sell", buy("exit", "1.5", "90", "0.08 USDT"), null),
    ];
    expect(summarizePaperPositionRecovery(series)).toEqual({
      status: "verified",
      scope: "position_only",
      completedUnderwater: 1,
      recovered: 1,
      recoveryRatePercent: "100.00",
      completedLosses: 0,
      openUnderwater: 0,
      liquidated: 0,
    });
  });

  it("does not credit unrealized recovery, even if the current mark is positive", () => {
    const base = [
      transition("buy", buy("open", "1", "100"), { quantityBase: "1", markPriceQuote: "100" }),
      transition(null, null, { quantityBase: "1", markPriceQuote: "50" }),
      transition(null, null, { quantityBase: "1", markPriceQuote: "120" }),
    ];
    expect(summarizePaperPositionRecovery(base)).toMatchObject({
      completedUnderwater: 0,
      recovered: 0,
      recoveryRatePercent: null,
      openUnderwater: 1,
    });
  });

  it("does not count fee-only underwater positions as recovered", () => {
    const base = [
      transition("buy", buy("open", "1", "100", "0.05 USDT"), {
        quantityBase: "1",
        markPriceQuote: "100",
      }),
      transition("sell", buy("exit", "1", "101", "0.05 USDT"), null),
    ];
    expect(summarizePaperPositionRecovery(base)).toMatchObject({
      completedUnderwater: 0,
      recovered: 0,
      recoveryRatePercent: null,
    });
  });

  it("fails closed for missing attribution, preventing fictitious recovery rate", () => {
    const bad = transition(null, buy("unlinked", "1", "100"), {
      quantityBase: "1",
      markPriceQuote: "100",
    });
    expect(summarizePaperPositionRecovery([bad])).toMatchObject({
      status: "incomplete",
      scope: "position_only",
      reason: "unattributed_native_fill",
    });
  });

  it.each(["long", "short"] as const)(
    "rejects an underwater %s disappearing without a closing fill",
    (side) => {
      const series = [
        transition(
          side === "long" ? "buy" : "sell",
          buy("open", "1", "100"),
          { quantityBase: "1", markPriceQuote: "100" },
          null,
          side,
        ),
        transition(
          null,
          null,
          { quantityBase: "1", markPriceQuote: side === "long" ? "50" : "150" },
          null,
          side,
        ),
        transition(null, null, null),
      ];
      expect(summarizePaperPositionRecovery(series)).toMatchObject({
        status: "incomplete",
        reason: "missing_native_closing_fill",
      });
    },
  );

  it("rejects disappearance after only a partial closing fill", () => {
    const series = [
      transition("buy", buy("open", "1", "100"), { quantityBase: "1", markPriceQuote: "50" }),
      transition("sell", buy("partial", "0.5", "90"), {
        quantityBase: "0.5",
        markPriceQuote: "90",
      }),
      transition(null, null, null),
    ];
    expect(summarizePaperPositionRecovery(series)).toMatchObject({
      status: "incomplete",
      reason: "missing_native_closing_fill",
    });
  });

  it.each(["0.5", "2"])("rejects an unexplained snapshot quantity of %s", (quantityBase) => {
    const series = [
      transition("buy", buy("open", "1", "100"), { quantityBase: "1", markPriceQuote: "100" }),
      transition(null, null, { quantityBase, markPriceQuote: "90" }),
    ];
    expect(summarizePaperPositionRecovery(series)).toMatchObject({
      status: "incomplete",
      reason: "native_position_quantity_mismatch",
    });
  });

  it("rejects a snapshot position with no opening fill", () => {
    expect(
      summarizePaperPositionRecovery([
        transition(null, null, { quantityBase: "1", markPriceQuote: "100" }),
      ]),
    ).toMatchObject({ status: "incomplete", reason: "unattributed_native_position" });
  });

  it("rejects a closing fill larger than the remaining position", () => {
    const series = [
      transition("buy", buy("open", "1", "100"), { quantityBase: "1", markPriceQuote: "50" }),
      transition("sell", buy("exit", "2", "110"), null),
    ];
    expect(summarizePaperPositionRecovery(series)).toMatchObject({
      status: "incomplete",
      reason: "invalid_native_closing_quantity",
    });
  });

  it("credits a short recovery only after all partial exits reconcile", () => {
    const series = [
      transition(
        "sell",
        buy("open", "1", "100"),
        { quantityBase: "1", markPriceQuote: "100" },
        null,
        "short",
      ),
      transition(null, null, { quantityBase: "1", markPriceQuote: "150" }, null, "short"),
      transition(
        "sell",
        buy("add", "0.5", "150"),
        { quantityBase: "1.5", markPriceQuote: "150" },
        null,
        "short",
      ),
      transition(
        "buy",
        buy("partial", "0.5", "90"),
        { quantityBase: "1", markPriceQuote: "90" },
        null,
        "short",
      ),
      transition("buy", buy("exit", "1", "90"), null, null, "short"),
    ];
    expect(summarizePaperPositionRecovery(series)).toMatchObject({
      status: "verified",
      completedUnderwater: 1,
      recovered: 1,
      recoveryRatePercent: "100.00",
      openUnderwater: 0,
    });
  });

  it.each(["long", "short"] as const)(
    "reconciles native %s liquidation without an order command",
    (side) => {
      const markPriceQuote = side === "long" ? "50" : "150";
      const series = [
        transition(
          side === "long" ? "buy" : "sell",
          buy("open", "1", "100"),
          { quantityBase: "1", markPriceQuote: "100" },
          null,
          side,
        ),
        transition(null, null, { quantityBase: "1", markPriceQuote }, null, side),
        transition(null, buy("LIQUIDATION-p1", "1", markPriceQuote), null, null, side),
      ];
      expect(summarizePaperPositionRecovery(series)).toMatchObject({
        status: "verified",
        completedUnderwater: 1,
        recovered: 0,
        completedLosses: 1,
        openUnderwater: 0,
        liquidated: 1,
      });
    },
  );
});
