import { describe, expect, it } from "vitest";
import { estimateExactPaperSpotCapacity } from "./trading-paper-capacity.js";

const sample = {
  availableQuote: "1000",
  askQuote: "100.1",
  stopQuote: "95",
  quantityIncrement: "0.01",
  minNotionalQuote: "5",
  maxPerIdeaRiskQuote: "20",
  maxDailyLossQuote: "90",
  maxOpenRiskQuote: "40",
  maxTotalExposureQuote: "1500",
  assumedFeeBpsPerSide: 10,
  assumedSlippageBpsPerSide: 10,
};
describe("inert exact paper spot capacity", () => {
  it("sizes spot downward and caps both risk and held cash", () => {
    const x = estimateExactPaperSpotCapacity(sample);
    expect(x.status).toBe("inert_estimate");
    if (x.status !== "inert_estimate") return;
    expect(BigInt(x.quantityBase.replace(".", "").padEnd(10, "0"))).toBeGreaterThan(0n);
    expect(Number(x.heldQuote)).toBeLessThanOrEqual(1000);
    expect(Number(x.worstCaseStopRiskQuote)).toBeLessThanOrEqual(20);
    expect("orderId" in x || "approval" in x || "submit" in x).toBe(false);
  });
  it("fails closed on unsupported precision, zero cash, stop above ask and excessive fees", () => {
    expect(estimateExactPaperSpotCapacity({ ...sample, quantityIncrement: "0.000000001" })).toEqual({
      status: "deny", reason: "unrepresentable",
    });
    expect(estimateExactPaperSpotCapacity({ ...sample, availableQuote: "0" }).status).toBe("deny");
    expect(estimateExactPaperSpotCapacity({ ...sample, stopQuote: "101" }).status).toBe("deny");
    expect(estimateExactPaperSpotCapacity({ ...sample, assumedFeeBpsPerSide: 1001 }).status).toBe("deny");
  });
  it("checks minimum notional and adverse fee/slippage rounding", () => {
    expect(estimateExactPaperSpotCapacity({ ...sample, minNotionalQuote: "900" }).status).toBe("deny");
    const a = estimateExactPaperSpotCapacity(sample);
    const b = estimateExactPaperSpotCapacity({ ...sample, assumedFeeBpsPerSide: 30, assumedSlippageBpsPerSide: 30 });
    expect(a.status).toBe("inert_estimate");
    expect(b.status).toBe("inert_estimate");
    if (a.status === "inert_estimate" && b.status === "inert_estimate") {
      expect(Number(b.quantityBase)).toBeLessThanOrEqual(Number(a.quantityBase));
    }
  });
});
