import { describe, expect, it } from "vitest";
import { paperPerpetualOrderExpiresAt } from "./trading-paper-perpetual-order.js";

describe("PAPER signal-aligned order validity", () => {
  const submittedAt = "2026-10-18T06:00:00.000Z";
  const sessionExpiresAt = "2026-10-18T07:00:00.000Z";
  it("retains a compared limit for its signal while bounding it to thirty minutes", () => {
    expect(
      paperPerpetualOrderExpiresAt({
        orderType: "limit",
        submittedAt,
        sessionExpiresAt,
        comparisonValidUntil: "2026-10-18T06:20:00.000Z",
      }),
    ).toBe("2026-10-18T06:20:00.000Z");
    expect(
      paperPerpetualOrderExpiresAt({
        orderType: "limit",
        submittedAt,
        sessionExpiresAt,
        comparisonValidUntil: "2026-10-18T06:50:00.000Z",
      }),
    ).toBe("2026-10-18T06:30:00.000Z");
  });
  it("never extends a session or an earlier signal deadline", () => {
    expect(
      paperPerpetualOrderExpiresAt({
        orderType: "limit",
        submittedAt,
        sessionExpiresAt: "2026-10-18T06:02:00.000Z",
        comparisonValidUntil: "2026-10-18T06:20:00.000Z",
      }),
    ).toBe("2026-10-18T06:02:00.000Z");
  });
  it("keeps legacy and market validity at five minutes", () => {
    for (const input of [
      { orderType: "limit" as const },
      { orderType: "market" as const, comparisonValidUntil: sessionExpiresAt },
    ])
      expect(paperPerpetualOrderExpiresAt({ submittedAt, sessionExpiresAt, ...input })).toBe(
        "2026-10-18T06:05:00.000Z",
      );
  });
});
