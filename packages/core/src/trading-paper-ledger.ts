import {
  type TradingPaperLedgerInput,
  TradingPaperLedgerInputSchema,
  type TradingPaperLedgerState,
  TradingPaperLedgerStateSchema,
} from "@rakazo/contracts";

/**
 * BigInt decimal accounting with exactly eight fractional digits. No JS
 * floating-point amount/quantity math and no third-party execution engine.
 */
const SCALE = 100_000_000n;
function units(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Unsupported exact paper decimal precision");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
function decimal(value: bigint): string {
  const negative = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / SCALE;
  const fractional = (magnitude % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative}${whole.toString()}${fractional ? "." + fractional : ""}`;
}
function roundUpProduct(quantity: bigint, price: bigint): bigint {
  return (quantity * price + SCALE - 1n) / SCALE;
}
function roundDownProduct(quantity: bigint, price: bigint): bigint {
  return (quantity * price) / SCALE;
}
function aligned(amount: bigint, increment: string | null): boolean {
  return increment !== null && amount % units(increment) === 0n;
}
type Reservation = {
  reservationId: string;
  signalId: string;
  market: Extract<TradingPaperLedgerInput["events"][number], { kind: "reserve" }>["market"];
  quantity: bigint;
  held: bigint;
  expiresAt: number;
  expiresAtText: string;
};
type Position = {
  positionId: string;
  signalId: string;
  market: Reservation["market"];
  quantity: bigint;
  cost: bigint;
};

/**
 * A full, deterministic reconstruction of virtual SPOT balances from an
 * append-only input event stream. No database, timers, exchange I/O, broker
 * capability, risk approval or mutable singleton.
 *
 * Retried events with identical eventId AND normalized payload are no-ops,
 * even after later events. Reusing an event ID with different data fails.
 * New accepted events must have exactly contiguous sequences.
 */
export function replayTradingPaperLedger(raw: TradingPaperLedgerInput): TradingPaperLedgerState {
  const input = TradingPaperLedgerInputSchema.parse(raw);
  const initial = units(input.initialBalanceQuote);
  let available = initial;
  let held = 0n;
  let realized = 0n;
  let fees = 0n;
  let nextSequence = 1;
  let retryEvents = 0;
  let priorAt = Date.parse(input.openedAt);
  const processed = new Map<string, string>();
  const reservationIds = new Set<string>();
  const signalIds = new Set<string>();
  const reservations = new Map<string, Reservation>();
  const positions = new Map<string, Position>();

  for (const event of input.events) {
    if (event.ledgerId !== input.ledgerId) throw new Error("Cross-ledger paper event refused");
    const canonical = JSON.stringify(event);
    const old = processed.get(event.eventId);
    if (old !== undefined) {
      if (old !== canonical) throw new Error("Conflicting duplicate paper eventId");
      retryEvents++;
      continue;
    }
    if (event.sequence !== nextSequence) throw new Error("Paper event sequence gap or replay fork");
    const occurred = Date.parse(event.recordedAt);
    if (!Number.isFinite(occurred) || occurred < priorAt) {
      throw new Error("Paper event timestamp moved backwards");
    }
    priorAt = occurred;

    if (event.kind === "reserve") {
      const market = event.market;
      if (market.kind !== "spot" || market.status !== "active") {
        throw new Error("Only active spot market may reserve paper funds");
      }
      if (
        market.quote !== input.quoteCurrency ||
        market.priceIncrement === null ||
        market.quantityIncrement === null
      ) {
        throw new Error("Spot market quote currency or precision mismatch");
      }
      if (reservationIds.has(event.reservationId) || signalIds.has(event.signalId)) {
        throw new Error("Paper reservation or signal already consumed");
      }
      const qty = units(event.quantityBase);
      const maximum = units(event.maxSpendQuote);
      const expires = Date.parse(event.expiresAt);
      if (expires <= occurred) throw new Error("Paper reservation expires before creation");
      if (!aligned(qty, market.quantityIncrement))
        throw new Error("Paper quantity not lot-aligned");
      if (market.minNotional !== null && maximum < units(market.minNotional)) {
        throw new Error("Paper reservation below market min notional");
      }
      if (maximum > available) throw new Error("Insufficient available virtual quote funds");
      reservationIds.add(event.reservationId);
      signalIds.add(event.signalId);
      reservations.set(event.reservationId, {
        reservationId: event.reservationId,
        signalId: event.signalId,
        market,
        quantity: qty,
        held: maximum,
        expiresAt: expires,
        expiresAtText: event.expiresAt,
      });
      available -= maximum;
      held += maximum;
    } else if (event.kind === "release") {
      const reservation = reservations.get(event.reservationId);
      if (!reservation) throw new Error("No open paper reservation to release");
      held -= reservation.held;
      available += reservation.held;
      reservations.delete(event.reservationId);
    } else if (event.kind === "fill_buy") {
      const reservation = reservations.get(event.reservationId);
      if (!reservation) throw new Error("Paper buy requires an outstanding reservation");
      if (occurred > reservation.expiresAt) throw new Error("Paper fill after reservation expiry");
      const qty = units(event.quantityBase);
      const price = units(event.executedPriceQuote);
      const fee = units(event.feeQuote);
      if (qty !== reservation.quantity || !aligned(price, reservation.market.priceIncrement)) {
        throw new Error("Paper v1 requires exact full lot and tick-aligned buy fill");
      }
      const cost = roundUpProduct(qty, price) + fee;
      if (cost > reservation.held) {
        throw new Error("Paper fill including fee exceeded held virtual quote funds");
      }
      if (
        reservation.market.minNotional !== null &&
        roundUpProduct(qty, price) < units(reservation.market.minNotional)
      ) {
        throw new Error("Paper buy fill below market minimum notional");
      }
      held -= reservation.held;
      available += reservation.held - cost;
      reservations.delete(event.reservationId);
      positions.set(event.reservationId, {
        positionId: reservation.reservationId,
        signalId: reservation.signalId,
        market: reservation.market,
        quantity: qty,
        cost,
      });
      fees += fee;
    } else {
      const position = positions.get(event.positionId);
      if (!position) throw new Error("Paper close requires an open matching position");
      const qty = units(event.quantityBase);
      const price = units(event.executedPriceQuote);
      const fee = units(event.feeQuote);
      if (qty !== position.quantity || !aligned(price, position.market.priceIncrement)) {
        throw new Error("Paper v1 requires full lot and tick-aligned position close");
      }
      const proceeds = roundDownProduct(qty, price);
      if (fee > proceeds) throw new Error("Paper close fee exceeds virtual sale proceeds");
      const received = proceeds - fee;
      available += received;
      realized += received - position.cost;
      fees += fee;
      positions.delete(event.positionId);
    }
    nextSequence++;
    processed.set(event.eventId, canonical);
    const openCost = [...positions.values()].reduce((acc, position) => acc + position.cost, 0n);
    if (available < 0n || held < 0n || available + held + openCost !== initial + realized) {
      throw new Error("Paper quote ledger conservation invariant failed");
    }
  }

  const openCost = [...positions.values()].reduce((acc, position) => acc + position.cost, 0n);
  return TradingPaperLedgerStateSchema.parse({
    version: input.version,
    ledgerId: input.ledgerId,
    quoteCurrency: input.quoteCurrency,
    nextSequence,
    acceptedEvents: processed.size,
    retryEvents,
    initialBalanceQuote: decimal(initial),
    availableQuote: decimal(available),
    reservedQuote: decimal(held),
    openCostBasisQuote: decimal(openCost),
    realizedPnlQuote: decimal(realized),
    totalFeesQuote: decimal(fees),
    bookEquityQuote: decimal(available + held + openCost),
    reservations: [...reservations.values()].map((reservation) => ({
      reservationId: reservation.reservationId,
      signalId: reservation.signalId,
      symbol: reservation.market.symbol,
      quantityBase: decimal(reservation.quantity),
      heldQuote: decimal(reservation.held),
      expiresAt: reservation.expiresAtText,
    })),
    positions: [...positions.values()].map((position) => ({
      positionId: position.positionId,
      signalId: position.signalId,
      symbol: position.market.symbol,
      quantityBase: decimal(position.quantity),
      entryCostBasisQuote: decimal(position.cost),
    })),
  });
}
