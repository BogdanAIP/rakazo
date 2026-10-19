import * as z from "zod";
import { IsoDate } from "./ids.js";
import {
  TradingPaperLedgerEventSchema,
  TradingPaperLedgerStateSchema,
} from "./trading-paper-ledger.js";
import {
  PaperPerpetualEngineBatchSchema,
  PaperPerpetualEngineSnapshotSchema,
} from "./trading-paper-perpetual-engine.js";

const PaperLedgerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const TradingPaperJournalListOutputSchema = z.object({
  mode: z.literal("paper_only"),
  ledgers: z
    .array(
      z.object({
        ledgerId: PaperLedgerIdSchema,
        openedAt: IsoDate,
        updatedAt: IsoDate,
        quoteCurrency: z.string(),
        eventsCount: z.number().int().nonnegative(),
      }),
    )
    .max(50),
});

export const TradingPaperJournalReadInputSchema = z.object({
  ledgerId: PaperLedgerIdSchema,
  beforeSequence: z.number().int().positive().safe().optional(),
});

export const TradingPaperJournalReadOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    mode: z.literal("paper_only"),
    ledgerId: PaperLedgerIdSchema,
    openedAt: IsoDate,
    updatedAt: IsoDate,
    state: TradingPaperLedgerStateSchema,
    events: z.array(TradingPaperLedgerEventSchema).max(100),
    nextBeforeSequence: z.number().int().positive().safe().nullable(),
  }),
  z.object({
    status: z.literal("integrity_blocked"),
    mode: z.literal("paper_only"),
    ledgerId: PaperLedgerIdSchema,
    // Financial details are deliberately omitted for an invalid journal.
    message: z.literal("Journal integrity verification failed"),
  }),
]);

export type TradingPaperJournalListOutput = z.infer<typeof TradingPaperJournalListOutputSchema>;
export type TradingPaperJournalReadOutput = z.infer<typeof TradingPaperJournalReadOutputSchema>;

/**
 * The Futures tab of the SAME PAPER journal page. Monetary projections are
 * returned only after replay and hash-chain verification, never from raw rows.
 */
const PerpetualDecimalSchema = z
  .string()
  .max(64)
  .regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/);
const PerpetualStrategySchema = z.enum(["conservative", "moderate", "aggressive"]);
const PerpetualVenueSchema = z.enum(["okx", "bingx"]);
const PerpetualSideSchema = z.enum(["long", "short"]);

const PerpetualJournalEventBase = z.object({
  ledgerId: PaperLedgerIdSchema,
  eventId: PaperLedgerIdSchema,
  sequence: z.number().int().positive().safe(),
  recordedAt: IsoDate,
  positionId: PaperLedgerIdSchema,
});
const PerpetualJournalEventSchema = z.discriminatedUnion("kind", [
  PerpetualJournalEventBase.extend({
    kind: z.literal("engine"),
    input: PaperPerpetualEngineBatchSchema,
    output: PaperPerpetualEngineSnapshotSchema,
  }),
  PerpetualJournalEventBase.extend({
    kind: z.literal("open"),
    venue: PerpetualVenueSchema,
    instrument: z.string().min(3).max(128),
    side: PerpetualSideSchema,
    leverage: z.number().int().positive().safe(),
    quantityBase: PerpetualDecimalSchema,
    entryPriceQuote: PerpetualDecimalSchema,
    entryFeeQuote: PerpetualDecimalSchema,
    maintenanceMarginBps: z.number().int().min(1).max(1000),
  }),
  PerpetualJournalEventBase.extend({
    kind: z.literal("mark"),
    markPriceQuote: PerpetualDecimalSchema,
  }),
  PerpetualJournalEventBase.extend({
    kind: z.literal("funding"),
    paymentQuoteSigned: PerpetualDecimalSchema,
  }),
  PerpetualJournalEventBase.extend({
    kind: z.literal("close"),
    exitPriceQuote: PerpetualDecimalSchema,
    exitFeeQuote: PerpetualDecimalSchema,
    quantityBase: PerpetualDecimalSchema.optional(),
  }),
  PerpetualJournalEventBase.extend({
    kind: z.literal("liquidate"),
    exitPriceQuote: PerpetualDecimalSchema,
    exitFeeQuote: PerpetualDecimalSchema,
  }),
]);

const PerpetualJournalStateSchema = z.object({
  marginMode: z.literal("account_wide").optional(),
  engine: z.object({ id: z.string(), version: z.string() }).optional(),
  ledgerId: PaperLedgerIdSchema,
  strategy: PerpetualStrategySchema,
  initialBalanceQuote: PerpetualDecimalSchema,
  availableQuote: PerpetualDecimalSchema,
  lockedMarginQuote: PerpetualDecimalSchema,
  bookBalanceQuote: PerpetualDecimalSchema,
  realizedPnlQuote: PerpetualDecimalSchema,
  unrealizedPnlQuote: PerpetualDecimalSchema,
  markedEquityQuote: PerpetualDecimalSchema,
  fundingNetQuote: PerpetualDecimalSchema,
  totalFeesQuote: PerpetualDecimalSchema,
  bankruptcyShortfallQuote: PerpetualDecimalSchema,
  openPositions: z
    .array(
      z.object({
        positionId: PaperLedgerIdSchema,
        hedgeBucket: z.string().min(1).max(500),
        venue: PerpetualVenueSchema,
        instrument: z.string().min(3).max(128),
        side: PerpetualSideSchema,
        leverage: z.number().int().positive().safe(),
        quantityBase: PerpetualDecimalSchema,
        entryPriceQuote: PerpetualDecimalSchema,
        markPriceQuote: PerpetualDecimalSchema,
        isolatedMarginQuote: PerpetualDecimalSchema,
        initialMarginQuote: PerpetualDecimalSchema.optional(),
        unrealizedPnlQuote: PerpetualDecimalSchema,
        maintenanceMarginQuote: PerpetualDecimalSchema,
        liquidationRequired: z.boolean(),
        estimatedLiquidationPriceQuote: PerpetualDecimalSchema.nullable().optional(),
      }),
    )
    .max(100),
  closedPositions: z.number().int().nonnegative(),
  liquidations: z.number().int().nonnegative(),
  acceptedEvents: z.number().int().nonnegative(),
  retryEvents: z.number().int().nonnegative(),
  nextSequence: z.number().int().positive().safe(),
});

export const TradingPaperPerpetualJournalListOutputSchema = z.object({
  mode: z.literal("paper_only"),
  ledgers: z
    .array(
      z.object({
        ledgerId: PaperLedgerIdSchema,
        strategy: PerpetualStrategySchema,
        openedAt: IsoDate,
        updatedAt: IsoDate,
        quoteCurrency: z.literal("USDT"),
        eventsCount: z.number().int().nonnegative(),
      }),
    )
    .max(50),
});
export type TradingPaperPerpetualJournalListOutput = z.infer<
  typeof TradingPaperPerpetualJournalListOutputSchema
>;

export const TradingPaperPerpetualJournalReadOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    mode: z.literal("paper_only"),
    ledgerId: PaperLedgerIdSchema,
    openedAt: IsoDate,
    updatedAt: IsoDate,
    state: PerpetualJournalStateSchema,
    analytics: z
      .object({
        scope: z.literal("full_verified_history"),
        observations: z.number().int().nonnegative(),
        maximumDrawdownPercent: z.string(),
        points: z
          .array(
            z.object({
              at: IsoDate,
              equityQuote: PerpetualDecimalSchema,
              drawdownPercent: z.string(),
              gapBefore: z.boolean(),
            }),
          )
          .max(500),
      })
      .optional(),
    recovery: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("verified"),
            scope: z.literal("position_only"),
            completedUnderwater: z.number().int().nonnegative(),
            recovered: z.number().int().nonnegative(),
            recoveryRatePercent: z
              .string()
              .regex(/^\d{1,3}\.\d{2}$/)
              .nullable(),
            completedLosses: z.number().int().nonnegative(),
            openUnderwater: z.number().int().nonnegative(),
            liquidated: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({
            status: z.literal("incomplete"),
            scope: z.literal("position_only"),
            reason: z.string().min(1).max(120),
          })
          .strict(),
      ])
      .optional(),
    events: z.array(PerpetualJournalEventSchema).max(100),
    nextBeforeSequence: z.number().int().positive().safe().nullable(),
  }),
  z.object({
    status: z.literal("integrity_blocked"),
    mode: z.literal("paper_only"),
    ledgerId: PaperLedgerIdSchema,
    message: z.literal("Journal integrity verification failed"),
  }),
]);
export type TradingPaperPerpetualJournalReadOutput = z.infer<
  typeof TradingPaperPerpetualJournalReadOutputSchema
>;
