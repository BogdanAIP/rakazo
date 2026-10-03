import * as z from "zod";
import { TradingCandleSchema, TradingInstrumentSchema, TradingPositiveDecimalSchema } from "./trading.js";
import { TradingReplayOutputSchema } from "./trading-replay.js";

export const TradingWalkforwardInputSchema = z.object({
  algorithm: z.literal("spot_breakout_next_bar_v1"),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  market: TradingInstrumentSchema,
  /** Already confirmed, chronological and contiguous 1H bars, 22+ needed. */
  candles: z.array(TradingCandleSchema).min(22).max(250),
  initialBalanceQuote: TradingPositiveDecimalSchema,
  fixedNotionalQuote: TradingPositiveDecimalSchema,
  feeBpsPerSide: z.number().finite().min(0).max(1000),
  adverseSlippageBpsPerSide: z.number().finite().min(0).max(1000),
  /** Reject opening gaps beyond this bps limit, not a promise of market fill. */
  maxEntryGapBps: z.number().finite().min(0).max(1000),
});
export type TradingWalkforwardInput = z.infer<typeof TradingWalkforwardInputSchema>;

export const TradingWalkforwardOutputSchema = z.object({
  algorithm: z.literal("spot_breakout_next_bar_v1"),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signalCount: z.number().int().nonnegative(),
  noTradeCount: z.number().int().nonnegative(),
  skippedEntryCount: z.number().int().nonnegative(),
  /** Exit by the end of the one next bar; ambiguous stop+target is stop first. */
  executions: z.array(
    z.object({
      signalId: z.string().min(1),
      decisionAt: z.string().datetime(),
      enteredAt: z.string().datetime(),
      exitedAt: z.string().datetime(),
      entryReason: z.literal("next_bar_open_proxy"),
      exitReason: z.enum(["stop", "target", "next_bar_close"]),
      entryReference: TradingPositiveDecimalSchema,
      exitReference: TradingPositiveDecimalSchema,
    }),
  ),
  /** Null when no valid entries; never invent profitable zero-trade results. */
  replay: TradingReplayOutputSchema.nullable(),
});
export type TradingWalkforwardOutput = z.infer<typeof TradingWalkforwardOutputSchema>;
