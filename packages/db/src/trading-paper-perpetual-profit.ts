import type {
  PaperPerpetualEngineConfig,
  PaperPerpetualSnapshot,
  PerpetualControl,
} from "@rakazo/contracts";
import type { PerpetualPaperPositionState } from "@rakazo/core";
import { paperPerpetualAmount as amount, formatPaperPerpetualAmount as format } from "@rakazo/core";

type ProfitPlan = NonNullable<PerpetualControl["plans"][number]["profitTaking"]>;
type Contract = PaperPerpetualEngineConfig["instruments"][number];
type HeldPosition = Pick<PerpetualPaperPositionState, "side" | "entryPriceQuote" | "quantityBase">;

export function perpetualBreakEvenStop(
  position: HeldPosition,
  terms: Pick<Contract, "priceIncrement">,
) {
  const entry = amount(position.entryPriceQuote);
  const tick = amount(terms.priceIncrement);
  return position.side === "long" ? ((entry + tick - 1n) / tick) * tick : (entry / tick) * tick;
}

function initialRisk(profit: ProfitPlan, side: HeldPosition["side"]) {
  const difference = amount(profit.initialEntryPriceQuote) - amount(profit.initialStopPriceQuote);
  return side === "long" ? difference : -difference;
}

export function hasVerifiedPerpetualProfitBasis(
  profit: ProfitPlan | undefined,
  side: HeldPosition["side"],
) {
  return profit !== undefined && initialRisk(profit, side) > 0n;
}

/** The target is fixed at the first eligible observation. Only native fills
 * advance it; each IOC must leave a valid residual position. */
export function planPerpetualProfitReduction(
  profit: ProfitPlan,
  position: HeldPosition,
  snapshot: Pick<PaperPerpetualSnapshot, "markPriceQuote" | "book">,
  terms: Pick<Contract, "priceIncrement" | "quantityIncrement" | "minimumBase">,
) {
  const entry = amount(profit.initialEntryPriceQuote);
  const direction = position.side === "long" ? 1n : -1n;
  const risk = initialRisk(profit, position.side);
  const mark = amount(snapshot.markPriceQuote);
  const executable = amount(direction === 1n ? snapshot.book.bidQuote : snapshot.book.askQuote);
  const breakEven = perpetualBreakEvenStop(position, terms);
  if (
    risk <= 0n ||
    [mark, executable].some(
      (price) =>
        direction * (price - entry) * 2n < 3n * risk || direction * (price - breakEven) <= 0n,
    )
  )
    return null;

  const held = amount(position.quantityBase);
  const lot = amount(terms.quantityIncrement);
  const minimum = amount(terms.minimumBase);
  const half = (held / (2n * lot)) * lot;
  const partial = profit.partial ?? { targetQuantityBase: format(half), filledQuantityBase: "0" };
  const remaining = amount(partial.targetQuantityBase) - amount(partial.filledQuantityBase);
  if (remaining < minimum || held < 2n * minimum) return null;

  const depth = amount(
    direction === 1n ? snapshot.book.bidAvailableBase : snapshot.book.askAvailableBase,
  );
  const capacity = held - minimum;
  const maxOrder = [remaining, depth, capacity].reduce((a, b) => (a < b ? a : b));
  let order = (maxOrder / lot) * lot;
  if (order > 0n && remaining > order && remaining - order < minimum)
    order = ((remaining - minimum) / lot) * lot;
  return { partial, quantityBase: order >= minimum ? format(order) : null };
}
