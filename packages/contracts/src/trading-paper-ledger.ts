import * as z from "zod";
import { IsoDate } from "./ids.js";
import { TradingInstrumentSchema } from "./trading.js";

/** Exact decimal transport; BigInt accounting uses at most eight decimals. */
export const TradingPaperLedgerAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/)
  .max(26);
export const TradingPaperLedgerPositiveSchema = TradingPaperLedgerAmountSchema.refine(
  (value) => /[1-9]/.test(value),
  "Positive paper amount required",
);
const EventId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const base = z.object({
  ledgerId: EventId,
  eventId: EventId,
  sequence: z.number().int().positive().safe(),
  recordedAt: IsoDate,
});
const reserve = base.extend({
  kind: z.literal("reserve"),
  reservationId: EventId,
  signalId: EventId,
  market: TradingInstrumentSchema,
  quantityBase: TradingPaperLedgerPositiveSchema,
  maxSpendQuote: TradingPaperLedgerPositiveSchema,
  expiresAt: IsoDate,
}).strict();
const release = base.extend({
  kind: z.literal("release"),
  reservationId: EventId,
}).strict();
const fillBuy = base.extend({
  kind: z.literal("fill_buy"),
  reservationId: EventId,
  quantityBase: TradingPaperLedgerPositiveSchema,
  executedPriceQuote: TradingPaperLedgerPositiveSchema,
  feeQuote: TradingPaperLedgerAmountSchema,
}).strict();
const fillSell = base.extend({
  kind: z.literal("fill_sell"),
  positionId: EventId,
  quantityBase: TradingPaperLedgerPositiveSchema,
  executedPriceQuote: TradingPaperLedgerPositiveSchema,
  feeQuote: TradingPaperLedgerAmountSchema,
}).strict();

/**
 * Event is synthetic and CANNOT be sent as a broker order or considered a
 * user/risk permission token. A future trusted paper Worker must create these
 * from independently authorized state in one transactional outbox.
 */
export const TradingPaperLedgerEventSchema = z.discriminatedUnion("kind", [
  reserve,
  release,
  fillBuy,
  fillSell,
]);
export type TradingPaperLedgerEvent = z.infer<typeof TradingPaperLedgerEventSchema>;

export const TradingPaperLedgerInputSchema = z.object({
  version: z.literal("paper_spot_full_fill_v1"),
  ledgerId: EventId,
  openedAt: IsoDate,
  quoteCurrency: z.string().regex(/^[A-Z0-9]{2,20}$/),
  initialBalanceQuote: TradingPaperLedgerPositiveSchema,
  events: z.array(TradingPaperLedgerEventSchema).max(10_000),
}).strict();
export type TradingPaperLedgerInput = z.infer<typeof TradingPaperLedgerInputSchema>;

export const TradingPaperLedgerStateSchema = z.object({
  version: z.literal("paper_spot_full_fill_v1"),
  ledgerId: EventId,
  quoteCurrency: z.string(),
  nextSequence: z.number().int().positive().safe(),
  acceptedEvents: z.number().int().nonnegative(),
  retryEvents: z.number().int().nonnegative(),
  initialBalanceQuote: TradingPaperLedgerPositiveSchema,
  availableQuote: TradingPaperLedgerAmountSchema,
  reservedQuote: TradingPaperLedgerAmountSchema,
  openCostBasisQuote: TradingPaperLedgerAmountSchema,
  realizedPnlQuote: z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/),
  totalFeesQuote: TradingPaperLedgerAmountSchema,
  /** Book-value only, NOT mark-to-market portfolio equity. */
  bookEquityQuote: TradingPaperLedgerAmountSchema,
  reservations: z.array(z.object({
    reservationId: EventId,
    signalId: EventId,
    symbol: z.string(),
    quantityBase: TradingPaperLedgerPositiveSchema,
    heldQuote: TradingPaperLedgerPositiveSchema,
    expiresAt: IsoDate,
  })),
  positions: z.array(z.object({
    positionId: EventId,
    signalId: EventId,
    symbol: z.string(),
    quantityBase: TradingPaperLedgerPositiveSchema,
    entryCostBasisQuote: TradingPaperLedgerPositiveSchema,
  })),
}).strict();
export type TradingPaperLedgerState = z.infer<typeof TradingPaperLedgerStateSchema>;
