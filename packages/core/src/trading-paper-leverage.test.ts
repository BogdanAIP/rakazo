import { describe, expect, it } from "vitest";
import {
  evaluatePaperLeverage,
  isFreshPaperObservation,
  type PaperLeverageInput,
  type PaperVenueLeverageLimits,
} from "./trading-paper-leverage.js";

const limits: PaperVenueLeverageLimits = {
  venue: "okx",
  instrument: "BTC-USDT-SWAP",
  marginMode: "cross",
  sourceId: "public:okx:position-tiers:fixture",
  observedAt: "2026-10-11T00:00:00.000Z",
  tiers: [
    { id: "1", minQuantityBase: "0", maxQuantityBase: "5", maxLeverage: 125 },
    { id: "2", minQuantityBase: "5", maxQuantityBase: "10", maxLeverage: 10 },
    { id: "3", minQuantityBase: "10", maxQuantityBase: "20", maxLeverage: 5 },
  ],
};
const fixture: PaperLeverageInput = {
  venue: "okx",
  instrument: "BTC-USDT-SWAP",
  marginMode: "cross",
  requestedLeverage: 20,
  ownerMaxLeverage: 20,
  existingQuantityBase: "1",
  proposedQuantityBase: "1",
  limits,
  now: "2026-10-11T00:00:01.000Z",
};

describe("PAPER leverage against owner settings and fresh venue tiers", () => {
  it("keeps the proposed leverage and supports exchange limits above 100", () => {
    expect(
      evaluatePaperLeverage({ ...fixture, requestedLeverage: 125, ownerMaxLeverage: 125 }),
    ).toMatchObject({
      status: "allowed",
      leverage: 125,
      venueMaxLeverage: 125,
      effectiveMaxLeverage: 125,
      grossQuantityBase: "2",
      tierIds: ["1"],
    });
  });

  it("enforces the owner ceiling without silently lowering a proposal", () => {
    expect(evaluatePaperLeverage({ ...fixture, ownerMaxLeverage: 10 })).toEqual({
      status: "deny",
      reason: "leverage_exceeded",
    });
    expect(
      evaluatePaperLeverage({ ...fixture, requestedLeverage: 5, ownerMaxLeverage: 5 }),
    ).toMatchObject({ status: "allowed", leverage: 5, effectiveMaxLeverage: 5 });
  });

  it("uses gross exposure including existing hedge legs and pending entries", () => {
    expect(evaluatePaperLeverage({ ...fixture, existingQuantityBase: "4.99999999" })).toEqual({
      status: "deny",
      reason: "leverage_exceeded",
    });
    expect(
      evaluatePaperLeverage({
        ...fixture,
        requestedLeverage: 10,
        existingQuantityBase: "4.99999999",
      }),
    ).toMatchObject({ status: "allowed", grossQuantityBase: "5.99999999", tierIds: ["2"] });
    expect(evaluatePaperLeverage({ ...fixture, existingQuantityBase: "20" })).toEqual({
      status: "deny",
      reason: "position_tier_exceeded",
    });
  });

  it("uses the restrictive limit at an exact tier boundary", () => {
    expect(evaluatePaperLeverage({ ...fixture, existingQuantityBase: "4" })).toEqual({
      status: "deny",
      reason: "leverage_exceeded",
    });
    expect(
      evaluatePaperLeverage({
        ...fixture,
        existingQuantityBase: "4",
        requestedLeverage: 10,
      }),
    ).toMatchObject({
      status: "allowed",
      grossQuantityBase: "5",
      tierIds: ["1", "2"],
      venueMaxLeverage: 10,
    });
  });

  it("revalidates when venue evidence becomes stale, missing or from another market", () => {
    expect(evaluatePaperLeverage({ ...fixture, limits: null })).toEqual({
      status: "deny",
      reason: "venue_limits_unavailable",
    });
    for (const observedAt of ["2026-10-10T23:59:30.000Z", "2026-10-11T00:00:03.001Z"]) {
      expect(evaluatePaperLeverage({ ...fixture, limits: { ...limits, observedAt } })).toEqual({
        status: "deny",
        reason: "venue_limits_stale",
      });
    }
    for (const change of [
      { venue: "bingx" as const },
      { instrument: "ETH-USDT-SWAP" },
      { marginMode: "isolated" as const },
    ]) {
      expect(evaluatePaperLeverage({ ...fixture, limits: { ...limits, ...change } })).toEqual({
        status: "deny",
        reason: "venue_limits_mismatch",
      });
    }
  });

  it("rejects missing provenance, malformed tier ranges and increasing tier leverage", () => {
    expect(evaluatePaperLeverage({ ...fixture, limits: { ...limits, sourceId: "" } })).toEqual({
      status: "deny",
      reason: "venue_limits_unavailable",
    });
    for (const tiers of [
      [],
      [limits.tiers[1]!],
      [limits.tiers[0]!, { ...limits.tiers[1]!, minQuantityBase: "6" }],
      [limits.tiers[0]!, { ...limits.tiers[1]!, minQuantityBase: "4" }],
      [limits.tiers[0]!, { ...limits.tiers[1]!, id: "1" }],
      [limits.tiers[0]!, { ...limits.tiers[1]!, maxLeverage: 126 }],
    ]) {
      expect(evaluatePaperLeverage({ ...fixture, limits: { ...limits, tiers } })).toEqual({
        status: "deny",
        reason: "invalid_venue_tiers",
      });
    }
  });

  it("accepts bounded clock skew but rejects stale, invalid and far-future evidence", () => {
    for (const offset of [-30_001, -30_000, 0, 1_000, 2_000, 2_001]) {
      const observedAt = new Date(Date.parse(fixture.now) + offset).toISOString();
      const allowed = offset >= -30_000 && offset <= 2_000;
      expect(isFreshPaperObservation(observedAt, fixture.now)).toBe(allowed);
      expect(evaluatePaperLeverage({ ...fixture, limits: { ...limits, observedAt } }).status).toBe(
        allowed ? "allowed" : "deny",
      );
    }
    expect(isFreshPaperObservation("invalid", fixture.now)).toBe(false);
  });

  it("fails closed on malformed quantities, clocks and leverage", () => {
    for (const proposedQuantityBase of ["-1", "1e3", "0.000000001", "NaN"]) {
      expect(evaluatePaperLeverage({ ...fixture, proposedQuantityBase })).toEqual({
        status: "deny",
        reason: "invalid_input",
      });
    }
    for (const requestedLeverage of [0, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluatePaperLeverage({ ...fixture, requestedLeverage })).toEqual({
        status: "deny",
        reason: "invalid_input",
      });
    }
    expect(evaluatePaperLeverage({ ...fixture, now: "invalid" })).toEqual({
      status: "deny",
      reason: "invalid_input",
    });
  });
});
