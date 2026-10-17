import * as z from "zod";
import { Id, IsoDate } from "./ids.js";
import {
  TradingInstrumentSchema,
  TradingPositiveDecimalSchema,
  TradingSignedRateSchema,
} from "./trading.js";

/**
 * Input is an EXTERNAL, immutable historical experiment fixture: this type
 * does not generate a strategy, fetch candles or authorize an order.
 */
export const TradingReplaySettlementSchema = z.object({
  settledAt: IsoDate,
  ratePerSettlement: TradingSignedRateSchema,
  markPrice: TradingPositiveDecimalSchema,
});

export const TradingReplayTradeSchema = z.object({
  tradeId: Id,
  market: TradingInstrumentSchema,
  side: z.enum(["spot_long", "perpetual_long", "perpetual_short"]),
  /** Point-in-time signal evidence; fill must happen strictly afterwards. */
  decisionAt: IsoDate,
  enteredAt: IsoDate,
  exitedAt: IsoDate,
  entryReference: TradingPositiveDecimalSchema,
  exitReference: TradingPositiveDecimalSchema,
  notionalQuote: TradingPositiveDecimalSchema,
  /**
   * Verified coverage of the entire holding period, with every expected
   * settlement time represented exactly once. Null is allowed on SPOT only.
   */
  fundingCoverage: z
    .object({
      from: IsoDate,
      through: IsoDate,
      expectedSettlementTimes: z.array(IsoDate).max(100),
      events: z.array(TradingReplaySettlementSchema).max(100),
    })
    .nullable(),
});

export const TradingReplayInputSchema = z.object({
  algorithm: z.literal("explicit_fill_replay_v1"),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  strategyId: Id,
  strategyVersion: z.string().min(1).max(128),
  initialBalanceQuote: TradingPositiveDecimalSchema,
  /** Explicit assumptions; never silently assume zero costs. */
  feeBpsPerSide: z.number().finite().min(0).max(1000),
  adverseSlippageBpsPerSide: z.number().finite().min(0).max(1000),
  trades: z.array(TradingReplayTradeSchema).min(1).max(250),
});
export type TradingReplayInput = z.infer<typeof TradingReplayInputSchema>;

export const TradingReplayOutputSchema = z.object({
  algorithm: z.literal("explicit_fill_replay_v1"),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Only realized-close equity; no intratrade mark-to-market drawdown. */
  realizedOnly: z.literal(true),
  initialBalanceQuote: z.number().finite().positive(),
  finalBalanceQuote: z.number().finite(),
  netPnlQuote: z.number().finite(),
  totalFeesQuote: z.number().finite().nonnegative(),
  totalFundingQuote: z.number().finite(),
  maxRealizedDrawdownPct: z.number().finite().min(0).max(100),
  trades: z.array(
    z.object({
      tradeId: Id,
      entryFill: z.number().finite().positive(),
      exitFill: z.number().finite().positive(),
      grossPnlQuote: z.number().finite(),
      slippageImpactQuote: z.number().finite(),
      feeQuote: z.number().finite().nonnegative(),
      fundingQuote: z.number().finite(),
      netPnlQuote: z.number().finite(),
      equityAfterQuote: z.number().finite(),
    }),
  ),
});
export type TradingReplayOutput = z.infer<typeof TradingReplayOutputSchema>;
