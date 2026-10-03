import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Decimals remain strings: JS numbers are not suitable for order-size precision. */
export const TradingDecimalSchema = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)), "Finite decimal required");
export const TradingPositiveDecimalSchema = TradingDecimalSchema.refine(
  (value) => Number(value) > 0,
  "Positive decimal required",
);

export const TradingMarketKindSchema = z.enum(["spot", "perpetual", "dated_future", "dex_swap"]);
export type TradingMarketKind = z.infer<typeof TradingMarketKindSchema>;

export const TradingInstrumentSchema = z
  .object({
    venue: z.string().trim().min(1).max(80),
    kind: TradingMarketKindSchema,
    symbol: z.string().trim().min(3).max(128),
    base: z.string().trim().min(1).max(40),
    quote: z.string().trim().min(1).max(40),
    status: z.enum(["active", "inactive"]),
    priceIncrement: TradingPositiveDecimalSchema.nullable(),
    quantityIncrement: TradingPositiveDecimalSchema.nullable(),
    minNotional: TradingPositiveDecimalSchema.nullable(),
    expiryAt: IsoDate.nullable(),
  })
  .superRefine((market, ctx) => {
    if ((market.kind === "dated_future") !== (market.expiryAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiryAt"],
        message: "Only dated futures require expiryAt",
      });
    }
  });
export type TradingInstrument = z.infer<typeof TradingInstrumentSchema>;

export const TradingTickerSchema = z.object({
  venue: z.string().trim().min(1).max(80),
  kind: TradingMarketKindSchema,
  symbol: z.string().trim().min(3).max(128),
  observedAt: IsoDate,
  fetchedAt: IsoDate,
  bid: TradingPositiveDecimalSchema,
  ask: TradingPositiveDecimalSchema,
  quoteVolume24h: TradingDecimalSchema,
});
export type TradingTicker = z.infer<typeof TradingTickerSchema>;

const SignalBase = z.object({
  signalId: Id,
  strategyId: Id,
  strategyVersion: z.string().trim().min(1).max(128),
  createdAt: IsoDate,
  expiresAt: IsoDate,
  evidenceIds: z.array(Id).min(1).max(100),
});

export const TradingSignalSchema = z
  .discriminatedUnion("kind", [
    SignalBase.extend({
      kind: z.literal("no_trade"),
      reason: z.string().trim().min(1).max(2_000),
    }),
    SignalBase.extend({
      kind: z.literal("proposal"),
      /** A proposal is not an order and grants no execution authority. */
      executionStatus: z.literal("research_only"),
      market: TradingInstrumentSchema,
      action: z.enum(["spot_buy", "spot_sell", "long", "short", "reduce", "close"]),
      entryTrigger: TradingPositiveDecimalSchema,
      stopLoss: TradingPositiveDecimalSchema,
      takeProfit: z.array(TradingPositiveDecimalSchema).min(1).max(8),
      invalidation: z.string().trim().min(1).max(2_000),
      riskBudgetQuote: TradingPositiveDecimalSchema,
      maxSlippageBps: z.number().finite().min(0).max(10_000),
    }),
  ])
  .superRefine((signal, ctx) => {
    if (Date.parse(signal.expiresAt) <= Date.parse(signal.createdAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Signal must expire after creation",
      });
    }
    if (signal.kind === "proposal") {
      if (
        (signal.action === "spot_buy" || signal.action === "spot_sell") &&
        signal.market.kind !== "spot" &&
        signal.market.kind !== "dex_swap"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "Spot action requires a spot instrument",
        });
      }
      if (
        (signal.action === "long" || signal.action === "short") &&
        signal.market.kind !== "perpetual" &&
        signal.market.kind !== "dated_future"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "Derivative action requires a future",
        });
      }
    }
  });
export type TradingSignal = z.infer<typeof TradingSignalSchema>;

/** Read-only, user-invoked market prefilter. It creates no orders or buy/sell signals. */
export const TradingScanRequestSchema = z.object({
  venue: z.enum(["bingx", "okx"]).default("bingx"),
  allowedQuotes: z
    .array(z.string().regex(/^[A-Z0-9]{2,20}$/))
    .min(1)
    .max(20)
    .default(["USDT"]),
  minQuoteVolume24h: z.number().finite().min(0).max(1e15).default(100_000),
  maxSpreadBps: z.number().finite().min(0).max(10_000).default(40),
  maxDataAgeMs: z.number().int().min(1_000).max(300_000).default(60_000),
});
export type TradingScanRequest = z.infer<typeof TradingScanRequestSchema>;

export const TradingExclusionReasonSchema = z.enum([
  "inactive",
  "quote_not_allowed",
  "missing_ticker",
  "stale_or_future_data",
  "invalid_book",
  "insufficient_volume",
  "excessive_spread",
]);

export const TradingScanOutputSchema = z.object({
  fetchedAt: IsoDate,
  candidates: z.array(
    z.object({
      market: TradingInstrumentSchema,
      ticker: TradingTickerSchema,
      spreadBps: z.number().finite().nonnegative(),
    }),
  ),
  excluded: z.array(
    z.object({
      market: TradingInstrumentSchema,
      reason: TradingExclusionReasonSchema,
    }),
  ),
});
export type TradingScanOutput = z.infer<typeof TradingScanOutputSchema>;


/** Public metadata only; this response has no order or signing capability. */
export const TradingCatalogOutputSchema = z.object({
  fetchedAt: IsoDate,
  markets: z.array(TradingInstrumentSchema),
  excluded: z.array(
    z.object({
      kind: z.enum(["spot", "perpetual", "dated_future"]),
      symbol: z.string().min(1).max(128),
      reason: z.enum([
        "incomplete_metadata",
        "pre_market_or_special_contract",
        "expired_contract",
      ]),
    }),
  ),
});
