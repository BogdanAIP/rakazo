import { describe, expect, it } from "vitest";
import {
  assessPaperRecoveryStructure,
  type PaperVolatilityCandle,
} from "./trading-paper-volatility-context.js";

const make = (side: "long" | "short"): PaperVolatilityCandle[] =>
  Array.from({ length: 24 }, (_, i) => {
    const low = side === "long" ? (i === 8 ? 50 : i === 16 ? 50.2 : 55) : i === 23 ? 35 : 50;
    const high = side === "short" ? (i === 8 ? 80 : i === 16 ? 80.1 : 75) : 75;
    const close = i === 23 ? (side === "long" ? 70 : 40) : 60;
    return {
      openedAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      durationMs: 3600000,
      open: "60",
      high: high.toString(),
      low: low.toString(),
      close: close.toString(),
      confirmed: true,
    };
  });

describe("PAPER recovery must not average down a falling knife", () => {
  it("requires both second pivot and later neckline break for a losing long", () => {
    const history = make("long");
    expect(assessPaperRecoveryStructure(history, "long")).toEqual({
      status: "confirmed_structure",
      reason: "two_pivots_and_neckline_break",
    });
    expect(
      assessPaperRecoveryStructure(
        history.map((c, i) => (i === 23 ? { ...c, close: "59" } : c)),
        "long",
      ),
    ).toMatchObject({ status: "unconfirmed_structure" });
  });
  it("can recognize the symmetric double top for a losing short, not as guarantee", () => {
    expect(assessPaperRecoveryStructure(make("short"), "short")).toMatchObject({
      status: "confirmed_structure",
    });
  });
  it("refuses an unfinished second low and unconfirmed or non-consecutive candles", () => {
    const history = make("long");
    expect(assessPaperRecoveryStructure(history.slice(0, 17), "long")).toMatchObject({
      status: "unconfirmed_structure",
    });
    expect(
      assessPaperRecoveryStructure(
        history.map((c, i) => (i === 7 ? { ...c, confirmed: false } : c)),
        "long",
      ),
    ).toMatchObject({ status: "unconfirmed_structure" });
    expect(
      assessPaperRecoveryStructure(
        history.map((c, i) =>
          i === 20 ? { ...c, openedAt: c.openedAt.replace("20:00", "19:00") } : c,
        ),
        "long",
      ),
    ).toMatchObject({ status: "unconfirmed_structure" });
  });
});
