import { describe, expect, it } from "vitest";
import {
  firstAcceptedNativeCandidate,
  nativePaperPositionGate,
  nativePaperSignal,
} from "./paper-native-auto-research.js";

const now = Date.parse("2026-11-10T12:01:00.000Z");
const frame = (
  start: string,
  over: Partial<{
    close: number;
    ema20: number;
    ema50: number;
    atr14: number;
    rsi14: number;
    volRatio: number;
    breakoutUp: boolean;
    breakoutDown: boolean;
    reclaimLong: boolean;
    reclaimShort: boolean;
    compressed: boolean;
    retestLong: boolean;
    retestShort: boolean;
    priorHigh: number;
    priorLow: number;
  }> = {},
) => ({
  at: start,
  close: 102,
  ema20: 101,
  ema50: 99,
  atr14: 2,
  rsi14: 55,
  volRatio: 1.2,
  breakoutUp: false,
  breakoutDown: false,
  reclaimLong: false,
  reclaimShort: false,
  compressed: false,
  retestLong: false,
  retestShort: false,
  priorHigh: 108,
  priorLow: 96,
  ...over,
});
const base = () => ({
  symbol: "BTC-USDT-SWAP",
  book: { observedAt: "2026-11-10T12:00:30.000Z", bid: 102, ask: 102.01, spreadBps: 0.98 },
  m15: frame("2026-11-10T11:45:00.000Z", { reclaimLong: true }),
  h1: frame("2026-11-10T11:00:00.000Z"),
  h4: frame("2026-11-10T08:00:00.000Z"),
});
describe("PAPER autonomous public-data strategy separation", () => {
  it("conservative enters only a confirmed H4/H1 pullback", () => {
    expect(nativePaperSignal("conservative", base(), now)?.side).toBe("long");
    const weak = base();
    weak.h4.ema50 = 110;
    expect(nativePaperSignal("conservative", weak, now)).toBeNull();
  });
  it("moderate confirms structural breakout separately from C", () => {
    const market = base();
    market.m15.reclaimLong = false;
    market.m15.breakoutUp = true;
    market.m15.retestLong = true;
    expect(nativePaperSignal("moderate", market, now)?.side).toBe("long");
    expect(nativePaperSignal("conservative", market, now)).toBeNull();
    market.m15.retestLong = false;
    expect(nativePaperSignal("moderate", market, now)).toBeNull();
  });
  it("aggressive requires compression and expansion, not just a trend", () => {
    const market = base();
    market.m15.reclaimLong = false;
    market.m15.breakoutUp = true;
    market.m15.retestLong = true;
    market.m15.volRatio = 1.8;
    market.h1.compressed = true;
    expect(nativePaperSignal("aggressive", market, now)?.side).toBe("long");
    market.h1.compressed = false;
    expect(nativePaperSignal("aggressive", market, now)).toBeNull();
  });
  it("rejects an old book or stale closed M15 candle", () => {
    const oldBook = base();
    oldBook.book.observedAt = "2026-11-10T11:58:00.000Z";
    expect(nativePaperSignal("conservative", oldBook, now)).toBeNull();
    const oldBar = base();
    oldBar.m15.at = "2026-11-10T11:15:00.000Z";
    expect(nativePaperSignal("conservative", oldBar, now)).toBeNull();
  });
  it("allows a separately confirmed bearish H4/H1 rejection", () => {
    const row = base();
    const negative = { close: 98, ema20: 99, ema50: 101, rsi14: 43 };
    row.m15 = frame("2026-11-10T11:45:00.000Z", {
      ...negative,
      reclaimLong: false,
      reclaimShort: true,
    });
    row.h1 = frame("2026-11-10T11:00:00.000Z", negative);
    row.h4 = frame("2026-11-10T08:00:00.000Z", negative);
    expect(nativePaperSignal("conservative", row, now)?.side).toBe("short");
  });
});
describe("native autonomous multi-position risk preflight", () => {
  it("allows an independent second or third PAPER entry within limits", () => {
    expect(
      nativePaperPositionGate("conservative", 1, ["ETH-USDT-SWAP"], "BTC-USDT-SWAP"),
    ).toBeNull();
    expect(
      nativePaperPositionGate("moderate", 2, ["ETH-USDT-SWAP", "BTC-USDT-SWAP"], "SOL-USDT-SWAP"),
    ).toBeNull();
    expect(
      nativePaperPositionGate(
        "aggressive",
        3,
        ["ETH-USDT-SWAP", "BTC-USDT-SWAP", "SOL-USDT-SWAP"],
        "ZEC-USDT-SWAP",
      ),
    ).toBeNull();
  });
  it("rejects new entries at C/M/A concurrent position caps", () => {
    expect(
      nativePaperPositionGate("conservative", 2, ["ETH-USDT-SWAP", "BTC-USDT-SWAP"]),
    ).toContain("limit");
    expect(
      nativePaperPositionGate("moderate", 3, ["ETH-USDT-SWAP", "BTC-USDT-SWAP", "SOL-USDT-SWAP"]),
    ).toContain("limit");
    expect(
      nativePaperPositionGate("aggressive", 4, [
        "ETH-USDT-SWAP",
        "BTC-USDT-SWAP",
        "SOL-USDT-SWAP",
        "ZEC-USDT-SWAP",
      ]),
    ).toContain("limit");
  });
  it("rejects a duplicate independent entry or incomplete holdings", () => {
    expect(nativePaperPositionGate("moderate", 1, ["ETH-USDT-SWAP"], "ETH-USDT-SWAP")).toContain(
      "already held",
    );
    expect(nativePaperPositionGate("conservative", 1, [])).toContain("incomplete");
  });
});

describe("native candidate fallback", () => {
  it("examines later markets after a rejection or failed quote", async () => {
    const seen: number[] = [];
    const result = await firstAcceptedNativeCandidate([1, 2, 3], async (n) => {
      seen.push(n);
      if (n === 1) return null;
      if (n === 2) throw new Error("market unavailable");
      return "third candidate";
    });
    expect(result).toBe("third candidate");
    expect(seen).toEqual([1, 2, 3]);
  });
  it("never creates a result if all candidates are rejected", async () => {
    expect(await firstAcceptedNativeCandidate([1, 2], async () => null)).toBeNull();
  });
});
