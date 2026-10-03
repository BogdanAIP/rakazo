import * as z from "zod";
import { IsoDate } from "./ids.js";
import {
  TradingDecimalSchema,
  TradingPositiveDecimalSchema,
  TradingSignalSchema,
} from "./trading.js";

/** This is a preview policy, not a broker approval or executable order. */
export const TradingPaperPolicySchema = z.object({
  mode: z.literal("paper_only"),
  enabled: z.boolean(),
  killSwitch: z.boolean(),
  allowedVenues: z.array(z.string().min(1).max(80)).min(1).max(10),
  quoteCurrency: z.string().regex(/^[A-Z0-9]{2,20}$/),
  maxAgeMs: z.number().int().min(1000).max(300_000),
  maxSpreadBps: z.number().finite().min(0).max(1000),
  maxTriggerDeviationBps: z.number().finite().min(0).max(1000),
  maxPositions: z.number().int().min(1).max(20),
  maxPerIdeaRiskQuote: TradingPositiveDecimalSchema,
  maxDailyLossQuote: TradingPositiveDecimalSchema,
  maxOpenRiskQuote: TradingPositiveDecimalSchema,
  maxTotalExposureQuote: TradingPositiveDecimalSchema,
  assumedFeeBpsPerSide: z.number().finite().min(0).max(1000),
  assumedSlippageBpsPerSide: z.number().finite().min(0).max(1000),
});
export type TradingPaperPolicy = z.infer<typeof TradingPaperPolicySchema>;

const SignedQuote = z
  .string()
  .max(64)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((v) => Number.isFinite(Number(v)));

export const TradingPaperSnapshotSchema = z.object({
  snapshotAt: IsoDate,
  quoteCurrency: z.string().regex(/^[A-Z0-9]{2,20}$/),
  availableQuoteBalance: TradingDecimalSchema,
  realizedPnlTodayQuote: SignedQuote,
  openStopRiskQuote: TradingDecimalSchema,
  openExposureQuote: TradingDecimalSchema,
  openPositions: z.number().int().min(0).max(10_000),
});

export const TradingPaperAssessmentInputSchema = z.object({
  policy: TradingPaperPolicySchema,
  portfolio: TradingPaperSnapshotSchema,
  signal: TradingSignalSchema,
  observedQuote: z.object({
    bid: TradingPositiveDecimalSchema,
    ask: TradingPositiveDecimalSchema,
    observedAt: IsoDate,
  }),
  now: IsoDate,
});
export type TradingPaperAssessmentInput = z.infer<typeof TradingPaperAssessmentInputSchema>;

export const TradingPaperAssessmentSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("deny"),
    mode: z.literal("paper_only"),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    status: z.literal("paper_preview"),
    /** Inert assessment, not an order; no submission authority or account ID. */
    mode: z.literal("paper_only"),
    signalId: z.string().min(1),
    symbol: z.string().min(3),
    quantityBase: TradingPositiveDecimalSchema,
    assumedEntryQuote: TradingPositiveDecimalSchema,
    estimatedStopLossQuote: TradingPositiveDecimalSchema,
    worstCaseStopRiskQuote: TradingPositiveDecimalSchema,
    assumedRoundTripCostQuote: TradingDecimalSchema,
    estimatedNotionalQuote: TradingPositiveDecimalSchema,
    expiresAt: IsoDate,
  }),
]);
export type TradingPaperAssessment = z.infer<typeof TradingPaperAssessmentSchema>;
