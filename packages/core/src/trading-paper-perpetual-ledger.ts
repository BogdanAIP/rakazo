import {
  getPaperExperimentPreset,
  type PaperExperimentStrategy,
  type PaperExperimentVenue,
  type PaperHedgeSide,
  paperExperimentHedgeBucket,
} from "./trading-paper-experiments.js";

const SCALE = 100_000_000n;
const BPS = 10_000n;
const POSITIVE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function exact(value: string): bigint {
  if (!POSITIVE.test(value)) throw new Error("Invalid exact USDT decimal");
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fractional.padEnd(8, "0"));
}
function signed(value: string): bigint {
  if (value.startsWith("-")) return -exact(value.slice(1));
  return exact(value);
}
function fmt(value: bigint): string {
  const abs = value < 0n ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${abs / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function ceil(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("Unsigned ceil expected");
  return (numerator + denominator - 1n) / denominator;
}
function notional(qty: bigint, price: bigint): bigint {
  return ceil(qty * price, SCALE);
}
function timestamp(value: string): number {
  if (!ISO.test(value)) throw new Error("Invalid PAPER UTC timestamp");
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) {
    throw new Error("Invalid PAPER event clock");
  }
  return n;
}

type BaseEvent = Readonly<{
  ledgerId: string;
  eventId: string;
  sequence: number;
  recordedAt: string;
}>;
export type PerpetualPaperEvent = BaseEvent &
  (
    | Readonly<{
        kind: "open";
        positionId: string;
        venue: PaperExperimentVenue;
        instrument: string;
        side: PaperHedgeSide;
        leverage: number;
        quantityBase: string;
        entryPriceQuote: string;
        entryFeeQuote: string;
        maintenanceMarginBps: number;
      }>
    | Readonly<{
        kind: "mark";
        positionId: string;
        markPriceQuote: string;
      }>
    | Readonly<{
        kind: "funding";
        positionId: string;
        /** Positive credits the account, negative charges the account. */
        paymentQuoteSigned: string;
      }>
    | Readonly<{
        kind: "close" | "liquidate";
        positionId: string;
        exitPriceQuote: string;
        exitFeeQuote: string;
      }>
  );

export type PerpetualPaperLedgerInput = Readonly<{
  ledgerId: string;
  strategy: PaperExperimentStrategy;
  openedAt: string;
  initialBalanceQuote: "1000";
  events: readonly PerpetualPaperEvent[];
}>;

export type PerpetualPaperPositionState = Readonly<{
  positionId: string;
  hedgeBucket: string;
  venue: PaperExperimentVenue;
  instrument: string;
  side: PaperHedgeSide;
  leverage: number;
  quantityBase: string;
  entryPriceQuote: string;
  markPriceQuote: string;
  isolatedMarginQuote: string;
  unrealizedPnlQuote: string;
  maintenanceMarginQuote: string;
  liquidationRequired: boolean;
}>;
export type PerpetualPaperLedgerState = Readonly<{
  ledgerId: string;
  strategy: PaperExperimentStrategy;
  initialBalanceQuote: string;
  availableQuote: string;
  lockedMarginQuote: string;
  bookBalanceQuote: string;
  realizedPnlQuote: string;
  unrealizedPnlQuote: string;
  markedEquityQuote: string;
  fundingNetQuote: string;
  totalFeesQuote: string;
  bankruptcyShortfallQuote: string;
  openPositions: readonly PerpetualPaperPositionState[];
  closedPositions: number;
  liquidations: number;
  acceptedEvents: number;
  retryEvents: number;
  nextSequence: number;
}>;

type Position = {
  positionId: string;
  hedgeBucket: string;
  venue: PaperExperimentVenue;
  instrument: string;
  side: PaperHedgeSide;
  leverage: number;
  quantity: bigint;
  entry: bigint;
  mark: bigint;
  margin: bigint;
  maintenanceMarginBps: bigint;
};
function unrealized(p: Position): bigint {
  return ((p.side === "long" ? p.mark - p.entry : p.entry - p.mark) * p.quantity) / SCALE;
}
function maintenance(p: Position): bigint {
  return ceil(notional(p.quantity, p.mark) * p.maintenanceMarginBps, BPS);
}
function mustLiquidate(p: Position): boolean {
  return p.margin + unrealized(p) <= maintenance(p);
}

/**
 * Reconstructs an isolated, synthetic USDT perpetual account from immutable
 * events. No broker, database, market fetching, model, clocks, or order routes.
 *
 * This is a deterministic accounting kernel, not an execution authorization.
 * Caller must use independent owner-scoped approvals and verified venue data.
 * Funding, mark-to-market and isolated bankruptcy are deliberately explicit.
 */
export function replayPerpetualPaperLedger(
  input: PerpetualPaperLedgerInput,
): PerpetualPaperLedgerState {
  if (!IDENTIFIER.test(input.ledgerId)) throw new Error("Invalid ledger ID");
  const preset = getPaperExperimentPreset(input.strategy);
  const starting = exact(input.initialBalanceQuote);
  if (starting !== exact(preset.initialBalanceQuote)) {
    throw new Error("Experiment capital must be exactly 1000 virtual USDT");
  }
  let free = starting;
  let realized = 0n;
  let fundingNet = 0n;
  let fees = 0n;
  let bankruptcy = 0n;
  let closed = 0;
  let liquidations = 0;
  let expectedSequence = 1;
  let retryEvents = 0;
  let previousTime = timestamp(input.openedAt);
  const processed = new Map<string, string>();
  const usedPositionIds = new Set<string>();
  const positions = new Map<string, Position>();

  for (const event of input.events) {
    if (event.ledgerId !== input.ledgerId) {
      throw new Error("Cross-account PAPER event refused");
    }
    if (!IDENTIFIER.test(event.eventId)) throw new Error("Invalid event ID");
    const canonical = JSON.stringify(event);
    const previous = processed.get(event.eventId);
    if (previous !== undefined) {
      if (previous !== canonical) throw new Error("Conflicting PAPER event retry");
      retryEvents++;
      continue;
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== expectedSequence) {
      throw new Error("PAPER event sequence gap or fork");
    }
    const currentTime = timestamp(event.recordedAt);
    if (currentTime < previousTime) throw new Error("PAPER event timestamp regression");
    previousTime = currentTime;

    if (event.kind === "open") {
      if (!IDENTIFIER.test(event.positionId) || usedPositionIds.has(event.positionId)) {
        throw new Error("Duplicate or invalid perpetual position");
      }
      const hedgeBucket = paperExperimentHedgeBucket({
        strategy: input.strategy,
        ledgerId: input.ledgerId,
        venue: event.venue,
        instrument: event.instrument,
        side: event.side,
      });
      if (!hedgeBucket) throw new Error("Unsupported PAPER perpetual market");
      if (!Number.isSafeInteger(event.leverage) || event.leverage < 1 ||
          event.leverage > preset.maxLeverage) throw new Error("PAPER leverage limit");
      if (!Number.isSafeInteger(event.maintenanceMarginBps) ||
          event.maintenanceMarginBps < 1 || event.maintenanceMarginBps > 1000) {
        throw new Error("Missing trusted maintenance margin tier");
      }
      if (positions.size >= preset.maxConcurrentPositions ||
          [...positions.values()].some(mustLiquidate)) {
        throw new Error("Risk pause: positions need reduction or liquidation");
      }
      const quantity = exact(event.quantityBase);
      const entry = exact(event.entryPriceQuote);
      const entryFee = exact(event.entryFeeQuote);
      if (quantity === 0n || entry === 0n) throw new Error("Invalid perpetual quantity or entry");
      const value = notional(quantity, entry);
      const existingExposure = [...positions.values()].reduce(
        (sum, p) => sum + notional(p.quantity, p.entry),
        0n,
      );
      if (existingExposure + value > exact(preset.maxTotalExposureQuote)) {
        throw new Error("Per-account PAPER exposure limit");
      }
      if (entryFee > ceil(value * 100n, BPS)) {
        throw new Error("Untrusted PAPER entry fee");
      }
      const margin = ceil(value, BigInt(event.leverage));
      if (margin + entryFee > free) throw new Error("Insufficient virtual margin");
      free -= margin + entryFee;
      realized -= entryFee;
      fees += entryFee;
      positions.set(event.positionId, {
        positionId: event.positionId,
        hedgeBucket,
        venue: event.venue,
        instrument: event.instrument,
        side: event.side,
        leverage: event.leverage,
        quantity,
        entry,
        mark: entry,
        margin,
        maintenanceMarginBps: BigInt(event.maintenanceMarginBps),
      });
      usedPositionIds.add(event.positionId);
    } else {
      const p = positions.get(event.positionId);
      if (!p) throw new Error("PAPER operation has no open matching position");
      if (event.kind === "mark") {
        const mark = exact(event.markPriceQuote);
        if (mark === 0n) throw new Error("Zero or invalid PAPER mark");
        p.mark = mark;
      } else if (event.kind === "funding") {
        const payment = signed(event.paymentQuoteSigned);
        if (payment >= 0n) {
          free += payment;
        } else {
          const charge = -payment;
          const fromFree = charge < free ? charge : free;
          free -= fromFree;
          const rest = charge - fromFree;
          if (rest > p.margin) throw new Error("Funding exceeds isolated collateral");
          p.margin -= rest;
        }
        realized += payment;
        fundingNet += payment;
      } else {
        const exit = exact(event.exitPriceQuote);
        const exitFee = exact(event.exitFeeQuote);
        if (exit === 0n) throw new Error("Invalid close price");
        const exitValue = notional(p.quantity, exit);
        if (exitFee > ceil(exitValue * 100n, BPS)) {
          throw new Error("Untrusted PAPER exit fee");
        }
        if (event.kind === "liquidate" && !mustLiquidate(p)) {
          throw new Error("Liquidation must have verified preceding distressed mark");
        }
        const change =
          ((p.side === "long" ? exit - p.entry : p.entry - exit) * p.quantity) / SCALE;
        const grossRelease = p.margin + change - exitFee;
        if (event.kind === "close" && grossRelease < 0n) {
          throw new Error("Bankrupt PAPER position needs liquidation event");
        }
        const release = grossRelease > 0n ? grossRelease : 0n;
        if (grossRelease < 0n) bankruptcy += -grossRelease;
        free += release;
        realized += release - p.margin;
        fees += exitFee;
        positions.delete(event.positionId);
        closed++;
        if (event.kind === "liquidate") liquidations++;
      }
    }
    const locked = [...positions.values()].reduce((sum, p) => sum + p.margin, 0n);
    if (free < 0n || locked < 0n || free + locked !== starting + realized) {
      throw new Error("PAPER margin conservation invariant violated");
    }
    processed.set(event.eventId, canonical);
    expectedSequence++;
  }
  const active = [...positions.values()];
  const locked = active.reduce((sum, p) => sum + p.margin, 0n);
  const markedPnl = active.reduce((sum, p) => sum + unrealized(p), 0n);
  return {
    ledgerId: input.ledgerId,
    strategy: input.strategy,
    initialBalanceQuote: fmt(starting),
    availableQuote: fmt(free),
    lockedMarginQuote: fmt(locked),
    bookBalanceQuote: fmt(free + locked),
    realizedPnlQuote: fmt(realized),
    unrealizedPnlQuote: fmt(markedPnl),
    markedEquityQuote: fmt(free + locked + markedPnl),
    fundingNetQuote: fmt(fundingNet),
    totalFeesQuote: fmt(fees),
    bankruptcyShortfallQuote: fmt(bankruptcy),
    openPositions: active.map((p) => ({
      positionId: p.positionId,
      hedgeBucket: p.hedgeBucket,
      venue: p.venue,
      instrument: p.instrument,
      side: p.side,
      leverage: p.leverage,
      quantityBase: fmt(p.quantity),
      entryPriceQuote: fmt(p.entry),
      markPriceQuote: fmt(p.mark),
      isolatedMarginQuote: fmt(p.margin),
      unrealizedPnlQuote: fmt(unrealized(p)),
      maintenanceMarginQuote: fmt(maintenance(p)),
      liquidationRequired: mustLiquidate(p),
    })),
    closedPositions: closed,
    liquidations,
    acceptedEvents: processed.size,
    retryEvents,
    nextSequence: expectedSequence,
  };
}
