import { describe, expect, it } from "vitest";
import {
  type PerpetualPaperEvent,
  type PerpetualPaperLedgerInput,
  replayPerpetualPaperLedger,
} from "./trading-paper-perpetual-ledger.js";

const openedAt = "2026-10-11T00:00:00.000Z";
const ledgerId = "virtual.test.one";

function account(
  events: readonly PerpetualPaperEvent[] = [],
  strategy: PerpetualPaperLedgerInput["strategy"] = "moderate",
): PerpetualPaperLedgerInput {
  return {
    ledgerId,
    strategy,
    openedAt,
    initialBalanceQuote: "1000",
    events,
  };
}

function tradeEvent(
  sequence: number,
  event: { kind: PerpetualPaperEvent["kind"]; [field: string]: unknown },
): PerpetualPaperEvent {
  return {
    ...event,
    ledgerId,
    eventId: `event-${sequence}`,
    sequence,
    recordedAt: `2026-10-11T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as PerpetualPaperEvent;
}
function opened(
  positionId: string,
  side: "long" | "short",
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: "open" as const,
    positionId,
    venue: "okx" as const,
    instrument: "BTC-USDT-SWAP",
    side,
    leverage: 2,
    quantityBase: "1",
    entryPriceQuote: "100",
    entryFeeQuote: "0.1",
    maintenanceMarginBps: 50,
    ...overrides,
  };
}
function closing(kind: "close" | "liquidate", positionId: string, price: string, fee = "0.1") {
  return { kind, positionId, exitPriceQuote: price, exitFeeQuote: fee };
}

describe("isolated, exact, replayable perpetual PAPER ledger", () => {
  it("starts three separate, empty 1000-USDT accounts", () => {
    for (const strategy of ["conservative", "moderate", "aggressive"] as const) {
      const state = replayPerpetualPaperLedger(account([], strategy));
      expect(state.availableQuote).toBe("1000");
      expect(state.markedEquityQuote).toBe("1000");
      expect(state.openPositions).toEqual([]);
      expect(state.nextSequence).toBe(1);
    }
  });

  it("opens and marks independent hedged legs without netting them", () => {
    const state = replayPerpetualPaperLedger(
      account([
        tradeEvent(1, opened("p-long", "long")),
        tradeEvent(2, opened("p-short", "short")),
        tradeEvent(3, { kind: "mark", positionId: "p-long", markPriceQuote: "95" }),
        tradeEvent(4, { kind: "mark", positionId: "p-short", markPriceQuote: "95" }),
      ]),
    );
    expect(state.openPositions).toHaveLength(2);
    expect(state.openPositions[0]?.hedgeBucket).not.toBe(state.openPositions[1]?.hedgeBucket);
    expect(state.openPositions.map((p) => p.unrealizedPnlQuote)).toEqual(["-5", "5"]);
    expect(state.unrealizedPnlQuote).toBe("0");
    expect(state.availableQuote).toBe("899.8");
    expect(state.lockedMarginQuote).toBe("100");
    expect(state.markedEquityQuote).toBe("999.8");
    expect(state.realizedPnlQuote).toBe("-0.2");
  });

  it("closes both legs using their own execution prices and records fees", () => {
    const state = replayPerpetualPaperLedger(
      account([
        tradeEvent(1, opened("p-long", "long")),
        tradeEvent(2, opened("p-short", "short")),
        tradeEvent(3, closing("close", "p-long", "95", "0.1")),
        tradeEvent(4, closing("close", "p-short", "90", "0.1")),
      ]),
    );
    expect(state.openPositions).toHaveLength(0);
    expect(state.availableQuote).toBe("1004.6");
    expect(state.bookBalanceQuote).toBe("1004.6");
    expect(state.realizedPnlQuote).toBe("4.6");
    expect(state.totalFeesQuote).toBe("0.4");
    expect(state.closedPositions).toBe(2);
  });

  it("accounts for funding income and expenses without inventing orders", () => {
    const state = replayPerpetualPaperLedger(
      account([
        tradeEvent(1, opened("p-one", "long")),
        tradeEvent(2, { kind: "funding", positionId: "p-one", paymentQuoteSigned: "-2" }),
        tradeEvent(3, { kind: "funding", positionId: "p-one", paymentQuoteSigned: "0.5" }),
        tradeEvent(4, closing("close", "p-one", "100")),
      ]),
    );
    expect(state.fundingNetQuote).toBe("-1.5");
    expect(state.totalFeesQuote).toBe("0.2");
    expect(state.realizedPnlQuote).toBe("-1.7");
    expect(state.availableQuote).toBe("998.3");
    expect(state.acceptedEvents).toBe(4);
    expect("orderId" in state || "submit" in state || "broker" in state).toBe(false);
  });

  it("keeps multiple pairs and venues separate and respects concurrent position caps", () => {
    const state = replayPerpetualPaperLedger(
      account([
        tradeEvent(1, opened("p-one", "long")),
        tradeEvent(2, opened("p-two", "short", { venue: "bingx", instrument: "ETH-USDT-SWAP" })),
      ]),
    );
    expect(state.openPositions[0]?.hedgeBucket).not.toBe(state.openPositions[1]?.hedgeBucket);
    expect(() =>
      replayPerpetualPaperLedger(
        account([
          tradeEvent(1, opened("p-one", "long")),
          tradeEvent(2, opened("p-two", "short")),
          tradeEvent(3, opened("p-three", "long")),
          tradeEvent(4, opened("p-four", "short")),
        ]),
      ),
    ).toThrow(/Risk pause/);
  });

  it("rejects incorrect leverage, unsupported symbols, excessive notional and unavailable collateral", () => {
    expect(() =>
      replayPerpetualPaperLedger(
        account([tradeEvent(1, opened("p-one", "long", { leverage: 3 }))]),
      ),
    ).toThrow(/leverage limit/);
    expect(() =>
      replayPerpetualPaperLedger(
        account([tradeEvent(1, opened("p-one", "long", { instrument: "BTC-USDT" }))]),
      ),
    ).toThrow(/Unsupported PAPER/);
    expect(() =>
      replayPerpetualPaperLedger(
        account([tradeEvent(1, opened("p-one", "long", { quantityBase: "11" }))]),
      ),
    ).toThrow(/exposure limit/);
    expect(() =>
      replayPerpetualPaperLedger(
        account([tradeEvent(1, opened("p-one", "long", { quantityBase: "8" }))], "conservative"),
      ),
    ).toThrow();
  });

  it("requires marked distressed collateral before explicit liquidation and conserves cash", () => {
    const open = opened("distressed", "long", {
      leverage: 3,
      quantityBase: "1",
      entryFeeQuote: "0",
    });
    const before = [
      tradeEvent(1, open),
      tradeEvent(2, { kind: "mark", positionId: "distressed", markPriceQuote: "60" }),
    ];
    const mark = replayPerpetualPaperLedger(account(before, "aggressive"));
    expect(mark.openPositions[0]?.liquidationRequired).toBe(true);
    expect(() =>
      replayPerpetualPaperLedger(
        account(
          [tradeEvent(1, open), tradeEvent(2, closing("liquidate", "distressed", "60"))],
          "aggressive",
        ),
      ),
    ).toThrow(/preceding distressed mark/);
    const done = replayPerpetualPaperLedger(
      account(
        [...before, tradeEvent(3, closing("liquidate", "distressed", "59", "0.05"))],
        "aggressive",
      ),
    );
    expect(done.openPositions).toHaveLength(0);
    expect(done.liquidations).toBe(1);
    expect(done.bankruptcyShortfallQuote).not.toBe("0");
    expect(Number(done.availableQuote)).toBeGreaterThanOrEqual(0);
    expect(done.markedEquityQuote).toBe(done.bookBalanceQuote);
    expect(done.availableQuote).toBe(done.bookBalanceQuote);
    expect(Number(done.availableQuote) + Number(done.bankruptcyShortfallQuote)).toBeGreaterThan(
      966,
    );
  });

  it("fails closed on cross-ledger events, duplicate conflicting IDs and sequence gaps", () => {
    const first = tradeEvent(1, opened("p-one", "long"));
    expect(() => replayPerpetualPaperLedger(account([{ ...first, ledgerId: "other" }]))).toThrow(
      /Cross-account/,
    );
    expect(() =>
      replayPerpetualPaperLedger(
        account([first, tradeEvent(1, { kind: "mark", positionId: "p-one", markPriceQuote: "2" })]),
      ),
    ).toThrow(/Conflicting/);
    expect(() => replayPerpetualPaperLedger(account([tradeEvent(2, opened("x", "long"))]))).toThrow(
      /sequence gap/,
    );
    expect(() =>
      replayPerpetualPaperLedger(account([first, tradeEvent(2, opened("p-one", "short"))])),
    ).toThrow(/Duplicate/);
    const replayed = replayPerpetualPaperLedger(account([first, first]));
    expect(replayed.retryEvents).toBe(1);
    expect(replayed.acceptedEvents).toBe(1);
  });

  it("rejects nondecimal amounts, timestamp regressions and untrusted fees", () => {
    expect(() =>
      replayPerpetualPaperLedger(
        account([tradeEvent(1, opened("p-one", "long", { quantityBase: "1e2" }))]),
      ),
    ).toThrow(/exact/);
    expect(() =>
      replayPerpetualPaperLedger(
        account([tradeEvent(1, opened("p-one", "long", { entryFeeQuote: "100" }))]),
      ),
    ).toThrow(/fee/);
    const open = tradeEvent(1, opened("p-one", "long"));
    expect(() =>
      replayPerpetualPaperLedger(
        account([
          open,
          { ...tradeEvent(2, closing("close", "p-one", "100")), recordedAt: openedAt },
        ]),
      ),
    ).toThrow(/regression/);
  });
});
