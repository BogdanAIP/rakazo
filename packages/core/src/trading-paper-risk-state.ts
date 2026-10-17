import { type TradingPaperLedgerInput, TradingPaperLedgerInputSchema } from "@rakazo/contracts";
import { replayTradingPaperLedger } from "./trading-paper-ledger.js";

const SCALE = 100_000_000n;
function units(value: string): bigint {
  const negative = value.startsWith("-");
  const raw = negative ? value.slice(1) : value;
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(raw)) {
    throw new Error("Unsupported exact paper risk decimal");
  }
  const [whole, fraction = ""] = raw.split(".");
  const n = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
  return negative ? -n : n;
}
function decimal(value: bigint): string {
  const negative = value < 0n;
  const n = negative ? -value : value;
  const fraction = (n % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${n / SCALE}${fraction ? `.${fraction}` : ""}`;
}
const ceilProduct = (quantity: bigint, price: bigint) => (quantity * price + SCALE - 1n) / SCALE;
const floorProduct = (quantity: bigint, price: bigint) => (quantity * price) / SCALE;

export type TradingPaperDerivedRiskState = {
  dayStartUtc: string;
  ledgerVersion: number;
  realizedPnlTodayQuote: string;
  realizedLossTodayQuote: string;
  openExposureQuote: string;
  openCostBasisQuote: string;
  reservedQuote: string;
  openPositions: number;
  openReservations: number;
  /** Null means existing positions do not yet have independently persisted stop guards. */
  openStopRiskQuote: string | null;
  stopRiskComplete: boolean;
};

/** Derives risk facts from the already-persisted immutable paper journal.
 * No caller-provided portfolio snapshot and no floating-point money math.
 * Daily loss is conservative: losing closes accumulate; winning closes do not
 * erase earlier losses. Existing open positions intentionally make stop risk
 * incomplete until a separate verified stop-guard relation exists. */
export function deriveTradingPaperRiskState(
  raw: TradingPaperLedgerInput,
  now: Date,
): TradingPaperDerivedRiskState {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid paper risk clock");
  const input = TradingPaperLedgerInputSchema.parse(raw);
  const state = replayTradingPaperLedger(input);
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextDayMs = dayStartMs + 86_400_000;
  const processed = new Set<string>();
  const reservations = new Map<string, { quantity: bigint }>();
  const positions = new Map<string, { cost: bigint }>();
  let pnlToday = 0n;
  let lossToday = 0n;

  for (const event of input.events) {
    if (processed.has(event.eventId)) continue;
    processed.add(event.eventId);
    if (event.kind === "reserve") {
      reservations.set(event.reservationId, { quantity: units(event.quantityBase) });
      continue;
    }
    if (event.kind === "release") {
      reservations.delete(event.reservationId);
      continue;
    }
    if (event.kind === "fill_buy") {
      const reservation = reservations.get(event.reservationId);
      if (!reservation) throw new Error("Risk replay missing paper reservation");
      const quantity = units(event.quantityBase);
      if (quantity !== reservation.quantity) throw new Error("Risk replay quantity mismatch");
      const cost = ceilProduct(quantity, units(event.executedPriceQuote)) + units(event.feeQuote);
      positions.set(event.reservationId, { cost });
      reservations.delete(event.reservationId);
      continue;
    }
    const position = positions.get(event.positionId);
    if (!position) throw new Error("Risk replay missing paper position");
    const quantity = units(event.quantityBase);
    const received =
      floorProduct(quantity, units(event.executedPriceQuote)) - units(event.feeQuote);
    const pnl = received - position.cost;
    const at = Date.parse(event.recordedAt);
    if (at >= dayStartMs && at < nextDayMs) {
      pnlToday += pnl;
      if (pnl < 0n) lossToday += -pnl;
    }
    positions.delete(event.positionId);
  }

  const openCost = units(state.openCostBasisQuote);
  const reserved = units(state.reservedQuote);
  return {
    dayStartUtc: new Date(dayStartMs).toISOString(),
    ledgerVersion: state.nextSequence - 1,
    realizedPnlTodayQuote: decimal(pnlToday),
    realizedLossTodayQuote: decimal(lossToday),
    openExposureQuote: decimal(openCost + reserved),
    openCostBasisQuote: state.openCostBasisQuote,
    reservedQuote: state.reservedQuote,
    openPositions: state.positions.length,
    openReservations: state.reservations.length,
    openStopRiskQuote: state.positions.length === 0 ? "0" : null,
    stopRiskComplete: state.positions.length === 0,
  };
}
