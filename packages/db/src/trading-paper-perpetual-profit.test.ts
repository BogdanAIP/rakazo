import type { PaperPerpetualSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  perpetualBreakEvenStop,
  planPerpetualProfitReduction,
} from "./trading-paper-perpetual-profit.js";

const terms = { priceIncrement: "0.01", quantityIncrement: "0.01", minimumBase: "0.01" };
const long = { side: "long", entryPriceQuote: "100", quantityBase: "1.01" } as const;
const short = { ...long, side: "short" } as const;
const longRisk = { initialEntryPriceQuote: "100", initialStopPriceQuote: "97" };
const shortRisk = { initialEntryPriceQuote: "100", initialStopPriceQuote: "103" };

function quote(
  markPriceQuote: string,
  bidQuote = markPriceQuote,
  askQuote = markPriceQuote,
  depth = "1",
) {
  const book: PaperPerpetualSnapshot["book"] = {
    venue: "okx",
    instrument: "BTC-USDT-SWAP",
    sourceId: "fixture-book",
    observedAt: "2026-01-01T00:00:00.000Z",
    bidQuote,
    askQuote,
    bidAvailableBase: depth,
    askAvailableBase: depth,
  };
  return { markPriceQuote, book };
}

describe("native PAPER profit reduction", () => {
  it("requires +1.5R on the mark and the closing side, for both directions", () => {
    expect(
      planPerpetualProfitReduction(longRisk, long, quote("104.5", "104.49"), terms),
    ).toBeNull();
    expect(
      planPerpetualProfitReduction(shortRisk, short, quote("95.5", "95.49", "95.51"), terms),
    ).toBeNull();
    expect(
      planPerpetualProfitReduction(shortRisk, short, quote("95.51", "95.49", "95.5"), terms),
    ).toBeNull();
    expect(planPerpetualProfitReduction(longRisk, long, quote("104.5"), terms)?.quantityBase).toBe(
      "0.5",
    );
    expect(planPerpetualProfitReduction(shortRisk, short, quote("95.5"), terms)?.quantityBase).toBe(
      "0.5",
    );
  });

  it("keeps the original target through partial fills, missing depth, and completion", () => {
    const start = planPerpetualProfitReduction(
      shortRisk,
      short,
      quote("95.5", "95.5", "95.5", "0"),
      terms,
    );
    expect(start).toEqual({
      partial: { targetQuantityBase: "0.5", filledQuantityBase: "0" },
      quantityBase: null,
    });
    const partial = { ...start!.partial, filledQuantityBase: "0.2" };
    expect(
      planPerpetualProfitReduction(
        { ...shortRisk, partial },
        { ...short, quantityBase: "0.81" },
        quote("95.49"),
        terms,
      ),
    ).toEqual({ partial, quantityBase: "0.3" });
    expect(
      planPerpetualProfitReduction(
        { ...shortRisk, partial: { ...partial, filledQuantityBase: "0.5" } },
        { ...short, quantityBase: "0.51" },
        quote("95.49"),
        terms,
      ),
    ).toBeNull();
  });

  it("preserves a valid position and avoids a remainder below the venue minimum", () => {
    const largerMinimum = { ...terms, minimumBase: "0.05" };
    expect(
      planPerpetualProfitReduction(
        shortRisk,
        { ...short, quantityBase: "0.09" },
        quote("95"),
        largerMinimum,
      ),
    ).toBeNull();
    expect(
      planPerpetualProfitReduction(shortRisk, short, quote("95", "95", "95", "0.48"), largerMinimum)
        ?.quantityBase,
    ).toBe("0.45");
  });

  it("rounds the stop toward protection using the current weighted entry", () => {
    expect(perpetualBreakEvenStop({ ...long, entryPriceQuote: "100.005" }, terms)).toBe(
      10001000000n,
    );
    expect(perpetualBreakEvenStop({ ...short, entryPriceQuote: "100.005" }, terms)).toBe(
      10000000000n,
    );
    expect(
      planPerpetualProfitReduction(
        longRisk,
        { ...long, entryPriceQuote: "105" },
        quote("104.5"),
        terms,
      ),
    ).toBeNull();
  });
});
