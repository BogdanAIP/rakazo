import { suggestPaperPerpetualCryptoUniverse } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { fetchOkxPaperPerpetualResearchScan } from "./trading-paper-perpetual-discovery.js";

describe("bulk PAPER research discovery", () => {
  it("retains more than eight crypto candidates using fixed public bulk requests", async () => {
    const now = new Date("2026-10-18T06:00:00.000Z");
    const symbols = Array.from({ length: 12 }, (_, i) => `ALT${i}`);
    const responses = [
      [],
      [...symbols, "STOCK"].map((base) => ({
        instType: "SWAP",
        instId: `${base}-USDT-SWAP`,
        instFamily: `${base}-USDT`,
        instCategory: base === "STOCK" ? "3" : "1",
        state: "live",
        tickSz: "0.01",
        lotSz: "1",
      })),
      [],
      [...symbols, "STOCK"].map((base) => ({
        instType: "SWAP",
        instId: `${base}-USDT-SWAP`,
        bidPx: "100",
        askPx: "100.01",
        volCcy24h: "1000000",
        high24h: "110",
        low24h: "90",
        ts: String(now.getTime()),
      })),
    ];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ code: "0", data: responses.shift() })),
    );
    const scan = await fetchOkxPaperPerpetualResearchScan({ now, fetchImpl });
    const research = suggestPaperPerpetualCryptoUniverse(scan, "aggressive", now);
    expect(research.researchSymbols).toHaveLength(12);
    expect(research.symbols).toHaveLength(8);
    expect(research.researchSymbols).not.toContain("STOCK-USDT-SWAP");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
