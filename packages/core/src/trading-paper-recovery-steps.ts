import {
  formatPaperPerpetualAmount,
  paperPerpetualAmount,
} from "./trading-paper-perpetual-ledger.js";

export type RecoveryStepRequest = Readonly<{
  stepId: string;
  triggerPriceQuote: string;
  allocationPercent: number;
}>;
export type RecoveryBookedStep = {
  stepId: string;
  triggerPriceQuote: string;
  maximumNotionalQuote: string;
  remainingNotionalQuote: string;
  activatedAt: string | null;
};
export type RecoverySide = "long" | "short";

/** Build a price-ordered recovery ladder, constrained INSIDE the original hard stop.
 * The ladder is a paper research PLAN; it never places an averaging order.
 */
export function planPaperRecoverySteps(
  side: RecoverySide,
  entryPriceQuote: string,
  hardStopPriceQuote: string,
  totalReservedNotionalQuote: string,
  steps: readonly RecoveryStepRequest[],
): RecoveryBookedStep[] | null {
  if (steps.length !== 2) return null;
  const entry = paperPerpetualAmount(entryPriceQuote);
  const stop = paperPerpetualAmount(hardStopPriceQuote);
  const reserved = paperPerpetualAmount(totalReservedNotionalQuote);
  if (entry <= 0n || stop <= 0n || reserved <= 0n) return null;
  if (steps[0]!.stepId === steps[1]!.stepId) return null;
  if (steps[0]!.allocationPercent + steps[1]!.allocationPercent !== 100) return null;
  const a = paperPerpetualAmount(steps[0]!.triggerPriceQuote);
  const b = paperPerpetualAmount(steps[1]!.triggerPriceQuote);
  if (side === "long" ? !(stop < b && b < a && a < entry) : !(entry < a && a < b && b < stop))
    return null;
  const first = (reserved * BigInt(steps[0]!.allocationPercent)) / 100n;
  const second = reserved - first;
  if (first <= 0n || second <= 0n) return null;
  return [
    {
      stepId: steps[0]!.stepId,
      triggerPriceQuote: steps[0]!.triggerPriceQuote,
      maximumNotionalQuote: formatPaperPerpetualAmount(first),
      remainingNotionalQuote: formatPaperPerpetualAmount(first),
      activatedAt: null,
    },
    {
      stepId: steps[1]!.stepId,
      triggerPriceQuote: steps[1]!.triggerPriceQuote,
      maximumNotionalQuote: formatPaperPerpetualAmount(second),
      remainingNotionalQuote: formatPaperPerpetualAmount(second),
      activatedAt: null,
    },
  ];
}

/** The first observation of a trigger persists. No data or model can move the
 * trigger price after entry. The future buy still needs independent confirmation.
 */
export function observePaperRecoverySteps(
  side: RecoverySide,
  quote: string,
  verifiedAt: string,
  steps: readonly RecoveryBookedStep[],
): RecoveryBookedStep[] {
  const price = paperPerpetualAmount(quote);
  if (price <= 0n || !Number.isFinite(Date.parse(verifiedAt)))
    throw new Error("Untrusted PAPER mark");
  return steps.map((step) =>
    step.activatedAt ||
    (side === "long"
      ? price > paperPerpetualAmount(step.triggerPriceQuote)
      : price < paperPerpetualAmount(step.triggerPriceQuote))
      ? step
      : { ...step, activatedAt: verifiedAt },
  );
}

/** Never consume a recovery tranche before trigger observation AND a fresh,
 * external, price-action confirmation. Normal stop, leverage and risk gates apply.
 */
export function canConsumePaperRecoveryStep(
  steps: readonly RecoveryBookedStep[],
  stepId: string | undefined,
  requestedNotionalQuote: string,
  confirmedReversal: boolean,
): "ready" | "missing" | "not_triggered" | "no_reversal" | "exceeds_step" {
  const step = steps.find((s) => s.stepId === stepId);
  if (!step) return "missing";
  if (!step.activatedAt) return "not_triggered";
  if (!confirmedReversal) return "no_reversal";
  const requested = paperPerpetualAmount(requestedNotionalQuote);
  if (requested <= 0n || requested > paperPerpetualAmount(step.remainingNotionalQuote))
    return "exceeds_step";
  return "ready";
}

/** Partial fills reduce only their own activated stage; total reserve is
 * separately reduced by the existing native whole-position accountant.
 */
export function consumePaperRecoveryStep(
  steps: readonly RecoveryBookedStep[],
  stepId: string,
  filledNotionalQuote: string,
): RecoveryBookedStep[] {
  const consumed = paperPerpetualAmount(filledNotionalQuote);
  const target = steps.find((s) => s.stepId === stepId);
  if (!target || consumed < 0n || consumed > paperPerpetualAmount(target.remainingNotionalQuote))
    throw new Error("Recovery tranche over-consumption");
  return steps.map((s) =>
    s.stepId === stepId
      ? {
          ...s,
          remainingNotionalQuote: formatPaperPerpetualAmount(
            paperPerpetualAmount(s.remainingNotionalQuote) - consumed,
          ),
        }
      : s,
  );
}
