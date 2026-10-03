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
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Signal must expire after creation" });
    }
    if (signal.kind === "proposal") {
      if (
        (signal.action === "spot_buy" || signal.action === "spot_sell") &&
        signal.market.kind !== "spot" && signal.market.kind !== "dex_swap"
      ) {
        ctx.addIssue({ code: "custom", path: ["action"], message: "Spot action requires a spot instrument" });
      }
      if (
        (signal.action === "long" || signal.action === "short") &&
        signal.market.kind !== "perpetual" && signal.market.kind !== "dated_future"
      ) {
        ctx.addIssue({ code: "custom", path: ["action"], message: "Derivative action requires a future" });
      }
    }
  });
export type TradingSignal = z.infer<typeof TradingSignalSchema>;
