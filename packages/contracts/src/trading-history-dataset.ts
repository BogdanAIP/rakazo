import * as z from "zod";
import { IsoDate } from "./ids.js";
import {
  TradingCandleSchema,
  TradingInstrumentSchema,
} from "./trading.js";

/**
 * Captured normalized PUBLIC data. This is not exchange-signed proof that the
 * provider returned these bytes; the adapter must separately preserve raw
 * transport evidence when a source-authenticity claim becomes necessary.
 */
export const TradingHistoryCaptureSchema = z.object({
  source: z.literal("okx_public_history_candles"),
  market: TradingInstrumentSchema,
  retrievedAt: IsoDate,
  candles: z.array(TradingCandleSchema).min(1).max(10_000),
});
export type TradingHistoryCapture = z.infer<typeof TradingHistoryCaptureSchema>;

export const TradingHistoryGapSchema = z.object({
  afterOpenedAt: IsoDate,
  beforeOpenedAt: IsoDate,
  missingBars: z.number().int().positive().safe(),
});

export const TradingHistoryDatasetSchema = TradingHistoryCaptureSchema.extend({
  schemaVersion: z.literal("okx_normalized_closed_1h_v1"),
  /** SHA-256 of a documented, stable, normalized UTF-8 JSON representation. */
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalByteLength: z.number().int().positive().max(8 * 1024 * 1024),
  firstOpenedAt: IsoDate,
  lastOpenedAt: IsoDate,
  gapRanges: z.array(TradingHistoryGapSchema).max(9_999),
  totalMissingBars: z.number().int().nonnegative().safe(),
  /**
   * This flag does NOT mean the universe includes delistings or that account
   * eligibility was verified. Only contiguous, active-at-capture spot data.
   */
  eligibleForSpotWalkforward: z.boolean(),
});
export type TradingHistoryDataset = z.infer<typeof TradingHistoryDatasetSchema>;
