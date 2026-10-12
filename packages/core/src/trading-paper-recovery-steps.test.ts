import { describe, expect, it } from "vitest";
import {
  canConsumePaperRecoveryStep,
  consumePaperRecoveryStep,
  observePaperRecoverySteps,
  planPaperRecoverySteps,
} from "./trading-paper-recovery-steps.js";

const steps = [
  { stepId: "after-first-test", triggerPriceQuote: "82", allocationPercent: 60 },
  { stepId: "after-second-test", triggerPriceQuote: "62", allocationPercent: 40 },
];
const today = "2026-10-13T10:00:00.000Z";

describe("pre-entry PAPER price-step recovery planning", () => {
  it("books two steps and requires both triggers strictly inside the protective stop", () => {
    const planned = planPaperRecoverySteps("long", "100", "50", "150", steps)!;
    expect(planned).toHaveLength(2);
    expect(planned[0]).toMatchObject({
      stepId: "after-first-test",
      maximumNotionalQuote: "90",
      remainingNotionalQuote: "90",
      activatedAt: null,
    });
    expect(planned[1]).toMatchObject({ maximumNotionalQuote: "60" });
    expect(planPaperRecoverySteps("long", "100", "90", "150", steps)).toBeNull();
    expect(planPaperRecoverySteps("long", "100", "50", "150", steps.slice().reverse())).toBeNull();
    expect(
      planPaperRecoverySteps("long", "100", "50", "150", [
        { ...steps[0]!, allocationPercent: 70 },
        steps[1]!,
      ]),
    ).toBeNull();
  });

  it("requires a later observed price touch AND independent structural confirmation", () => {
    const planned = planPaperRecoverySteps("long", "100", "50", "150", steps)!;
    expect(canConsumePaperRecoveryStep(planned, "after-first-test", "20", true)).toBe(
      "not_triggered",
    );
    const observed = observePaperRecoverySteps("long", "81.8", today, planned);
    expect(observed[0]!.activatedAt).toBe(today);
    expect(observed[1]!.activatedAt).toBeNull();
    expect(canConsumePaperRecoveryStep(observed, "after-first-test", "20", false)).toBe(
      "no_reversal",
    );
    expect(canConsumePaperRecoveryStep(observed, "after-first-test", "91", true)).toBe(
      "exceeds_step",
    );
    expect(canConsumePaperRecoveryStep(observed, "after-second-test", "1", true)).toBe(
      "not_triggered",
    );
    expect(canConsumePaperRecoveryStep(observed, "after-first-test", "20", true)).toBe("ready");
    const filled = consumePaperRecoveryStep(observed, "after-first-test", "20");
    expect(filled[0]!.remainingNotionalQuote).toBe("70");
    expect(filled[1]!.remainingNotionalQuote).toBe("60");
    expect(() => consumePaperRecoveryStep(filled, "after-first-test", "71")).toThrow();
  });

  it("allows symmetric short steps only before the hard stop", () => {
    const short = planPaperRecoverySteps("short", "100", "175", "75", [
      { stepId: "one", triggerPriceQuote: "120", allocationPercent: 40 },
      { stepId: "two", triggerPriceQuote: "155", allocationPercent: 60 },
    ]);
    expect(short).not.toBeNull();
    const touched = observePaperRecoverySteps("short", "130", today, short!);
    expect(touched[0]!.activatedAt).toBe(today);
    expect(touched[1]!.activatedAt).toBeNull();
    expect(
      planPaperRecoverySteps("short", "100", "140", "75", [
        { stepId: "one", triggerPriceQuote: "120", allocationPercent: 40 },
        { stepId: "two", triggerPriceQuote: "155", allocationPercent: 60 },
      ]),
    ).toBeNull();
  });
});
