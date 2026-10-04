import { createHash } from "node:crypto";
import {
  type TradingHistoryCapture,
  type TradingHistoryDataset,
  TradingHistoryDatasetSchema,
  type TradingWalkforwardInput,
} from "@rakazo/contracts";
import { prepareTradingHistoryCapture, runSpotCandleWalkforward } from "@rakazo/core";
import { fetchOkxClosedOneHourHistory } from "./trading-okx-history.js";

const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

/**
 * Locally calculated SHA-256 of the NORMALIZED source snapshot, never the
 * caller's claimed identifier. This is an integrity check, NOT signed
 * evidence of origin from the exchange.
 */
export function buildVerifiedTradingHistoryDataset(
  input: TradingHistoryCapture,
): TradingHistoryDataset {
  const prepared = prepareTradingHistoryCapture(input);
  const canonicalByteLength = Buffer.byteLength(prepared.canonicalJson, "utf8");
  if (canonicalByteLength > MAX_CANONICAL_BYTES) {
    throw new Error("Canonical historical dataset exceeds the 8 MiB limit");
  }
  const datasetSha256 = createHash("sha256").update(prepared.canonicalJson, "utf8").digest("hex");
  return TradingHistoryDatasetSchema.parse({
    ...prepared.capture,
    ...prepared.coverage,
    canonicalByteLength,
    datasetSha256,
  });
}

/** Detects modification of data, capture provenance or derived coverage. */
export function verifyTradingHistoryDataset(input: TradingHistoryDataset): TradingHistoryDataset {
  const dataset = TradingHistoryDatasetSchema.parse(input);
  const rebuilt = buildVerifiedTradingHistoryDataset({
    source: dataset.source,
    market: dataset.market,
    retrievedAt: dataset.retrievedAt,
    candles: dataset.candles,
  });
  if (
    dataset.datasetSha256 !== rebuilt.datasetSha256 ||
    dataset.canonicalByteLength !== rebuilt.canonicalByteLength ||
    dataset.schemaVersion !== rebuilt.schemaVersion ||
    dataset.firstOpenedAt !== rebuilt.firstOpenedAt ||
    dataset.lastOpenedAt !== rebuilt.lastOpenedAt ||
    dataset.totalMissingBars !== rebuilt.totalMissingBars ||
    dataset.eligibleForSpotWalkforward !== rebuilt.eligibleForSpotWalkforward ||
    JSON.stringify(dataset.gapRanges) !== JSON.stringify(rebuilt.gapRanges)
  ) {
    throw new Error("Historical dataset integrity or coverage mismatch");
  }
  return rebuilt;
}

/** Keyless adapter bridge; response origin/authenticity is not cryptographically attested. */
export async function captureOkxClosedHistoryDataset(
  market: TradingHistoryCapture["market"],
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TradingHistoryDataset> {
  const history = await fetchOkxClosedOneHourHistory(market, options);
  return buildVerifiedTradingHistoryDataset({
    source: "okx_public_history_candles",
    market,
    retrievedAt: history.fetchedAt,
    candles: history.candles,
  });
}

/**
 * Verified data-only boundary into P7. Never silently truncate a 10k-bar
 * capture to 250 bars, use a gap-containing series, or allow a stale/archived
 * instrument as a current spot trading universe.
 */
export function replayVerifiedSpotDataset(
  input: TradingHistoryDataset,
  settings: Omit<TradingWalkforwardInput, "algorithm" | "datasetSha256" | "market" | "candles">,
) {
  const dataset = verifyTradingHistoryDataset(input);
  if (!dataset.eligibleForSpotWalkforward || dataset.candles.length > 250) {
    throw new Error("Dataset is not eligible for full-coverage spot walk-forward v1");
  }
  return runSpotCandleWalkforward({
    algorithm: "spot_breakout_next_bar_v1",
    datasetSha256: dataset.datasetSha256,
    market: dataset.market,
    candles: dataset.candles,
    ...settings,
  });
}
