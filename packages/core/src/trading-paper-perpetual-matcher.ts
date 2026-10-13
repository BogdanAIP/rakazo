import type {
  PaperExperimentStrategy,
  PaperExperimentVenue,
  PaperHedgeSide,
} from "./trading-paper-experiments.js";
import { paperExperimentHedgeBucket } from "./trading-paper-experiments.js";

const SCALE = 100_000_000n;
const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function amount(value: string): bigint {
  if (!AMOUNT.test(value)) throw new Error("invalid exact amount");
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(frac.padEnd(8, "0"));
}
function fmt(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function when(value: string): number {
  if (!UTC.test(value)) throw new Error("invalid quote timestamp");
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) {
    throw new Error("invalid quote clock");
  }
  return n;
}
export type PerpetualPaperOrder = Readonly<{
  accountId: string;
  strategy: PaperExperimentStrategy;
  venue: PaperExperimentVenue;
  instrument: string;
  positionSide: PaperHedgeSide;
  intent: "open" | "reduce_only";
  action: "buy" | "sell";
  orderType: "market" | "limit" | "stop_market" | "take_profit_market";
  timeInForce: "ioc" | "gtc";
  quantityBase: string;
  alreadyFilledBase: string;
  lotIncrement: string;
  limitPriceQuote: string | null;
  triggerPriceQuote: string | null;
  /** For reduce-only, fresh open-position quantity from the same account. */
  positionAvailableBase: string | null;
  submittedAt: string;
  expiresAt: string;
}>;
export type PerpetualPaperPublicBook = Readonly<{
  venue: PaperExperimentVenue;
  instrument: string;
  observedAt: string;
  sourceId: string;
  bidQuote: string;
  askQuote: string;
  bidAvailableBase: string;
  askAvailableBase: string;
}>;
export type PerpetualPaperMatch =
  | { status: "deny"; reason: string }
  | {
      status: "not_filled";
      reason: "not_crossed" | "not_triggered" | "empty_book" | "expired" | "stale_quote";
    }
  | {
      status: "inert_fill_preview";
      /** No ledger writer, broker route, order ID or execution grant. */
      accountId: string;
      hedgeBucket: string;
      sourceId: string;
      executionPriceQuote: string;
      filledBase: string;
      remainingBase: string;
      partial: boolean;
      cancelRemaining: boolean;
    };

/**
 * A deliberately non-executing top-of-book matcher for simulated USDT swaps.
 * Does not claim queue priority, actual maker fills, latency or deep liquidity.
 * Consumers MUST revalidate owner authority, position and margin transactionally
 * before creating any virtual event in the isolated PAPER ledger.
 */
export function previewPerpetualPaperOrderMatch(
  order: PerpetualPaperOrder,
  book: PerpetualPaperPublicBook,
  now: string,
): PerpetualPaperMatch {
  const deny = (reason: string): PerpetualPaperMatch => ({ status: "deny", reason });
  const bucket = paperExperimentHedgeBucket({
    strategy: order.strategy,
    ledgerId: order.accountId,
    venue: order.venue,
    instrument: order.instrument,
    side: order.positionSide,
  });
  if (!bucket || book.venue !== order.venue || book.instrument !== order.instrument) {
    return deny("unsupported_or_mismatched_public_market");
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(book.sourceId)) {
    return deny("missing_provenance");
  }
  const actionShouldBuy =
    (order.intent === "open" && order.positionSide === "long") ||
    (order.intent === "reduce_only" && order.positionSide === "short");
  if (order.action !== (actionShouldBuy ? "buy" : "sell")) {
    return deny("invalid_direction_or_reduce_only");
  }
  if (
    order.intent === "open" &&
    (order.orderType === "stop_market" || order.orderType === "take_profit_market")
  ) {
    return deny("conditional_orders_must_reduce_position");
  }
  try {
    const current = when(now);
    const submitted = when(order.submittedAt);
    const expiry = when(order.expiresAt);
    const observed = when(book.observedAt);
    if (current >= expiry || observed >= expiry) return { status: "not_filled", reason: "expired" };
    if (submitted > current || submitted > observed || observed > current) {
      return deny("future_or_pre_submission_quote");
    }
    if (current - observed > 30_000) return { status: "not_filled", reason: "stale_quote" };
    const qty = amount(order.quantityBase);
    const done = amount(order.alreadyFilledBase);
    const increment = amount(order.lotIncrement);
    const bid = amount(book.bidQuote);
    const ask = amount(book.askQuote);
    const bidDepth = amount(book.bidAvailableBase);
    const askDepth = amount(book.askAvailableBase);
    if (
      qty === 0n ||
      increment === 0n ||
      bid === 0n ||
      ask === 0n ||
      bid > ask ||
      done >= qty ||
      qty % increment !== 0n ||
      done % increment !== 0n
    ) {
      return deny("invalid_quantity_or_order_book");
    }
    const remaining = qty - done;
    if (order.intent === "reduce_only") {
      if (order.positionAvailableBase === null) return deny("missing_position_scope");
      const availablePosition = amount(order.positionAvailableBase);
      if (remaining > availablePosition) return deny("reduce_only_would_reverse");
    }
    const limit = order.limitPriceQuote === null ? null : amount(order.limitPriceQuote);
    const trigger = order.triggerPriceQuote === null ? null : amount(order.triggerPriceQuote);
    if (
      (order.orderType === "limit" && (limit === null || limit === 0n)) ||
      (order.orderType !== "limit" && limit !== null) ||
      (order.orderType === "stop_market" || order.orderType === "take_profit_market"
        ? trigger === null || trigger === 0n
        : trigger !== null)
    ) {
      return deny("invalid_order_price_fields");
    }
    const buy = order.action === "buy";
    const price = buy ? ask : bid;
    if (order.orderType === "limit" && (buy ? price > limit! : price < limit!)) {
      return { status: "not_filled", reason: "not_crossed" };
    }
    if (order.orderType === "stop_market") {
      if (buy ? price < trigger! : price > trigger!) {
        return { status: "not_filled", reason: "not_triggered" };
      }
    }
    if (order.orderType === "take_profit_market") {
      if (buy ? price > trigger! : price < trigger!) {
        return { status: "not_filled", reason: "not_triggered" };
      }
    }
    const depth = buy ? askDepth : bidDepth;
    const fill = ((remaining < depth ? remaining : depth) / increment) * increment;
    if (fill === 0n) return { status: "not_filled", reason: "empty_book" };
    const residue = remaining - fill;
    return {
      status: "inert_fill_preview",
      accountId: order.accountId,
      hedgeBucket: bucket,
      sourceId: book.sourceId,
      executionPriceQuote: fmt(price),
      filledBase: fmt(fill),
      remainingBase: fmt(residue),
      partial: residue > 0n,
      cancelRemaining: residue > 0n && order.timeInForce === "ioc",
    };
  } catch {
    return deny("invalid_exact_amount_or_clock");
  }
}
