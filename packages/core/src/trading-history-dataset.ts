import {
  type TradingHistoryCapture,
  TradingHistoryCaptureSchema,
  type TradingHistoryDataset,
} from "@rakazo/contracts";

const HOUR_MS = 3_600_000;
const SCHEMA_VERSION = "okx_normalized_closed_1h_v1";

/**
 * Pure canonicalization. Field ordering is intentionally explicit rather than
 * dependent on input object insertion order. Original decimal strings remain
 * exact: changing "1.0" to "1" changes the source snapshot digest.
 */
export function prepareTradingHistoryCapture(raw: TradingHistoryCapture): {
  capture: TradingHistoryCapture;
  canonicalJson: string;
  coverage: Pick<
    TradingHistoryDataset,
    | "schemaVersion"
    | "firstOpenedAt"
    | "lastOpenedAt"
    | "gapRanges"
    | "totalMissingBars"
    | "eligibleForSpotWalkforward"
  >;
} {
  const capture = TradingHistoryCaptureSchema.parse(raw);
  const { market, candles } = capture;
  if (market.venue !== "okx") throw new Error("Only OKX normalized public history is supported");
  if (!["spot", "perpetual", "dated_future"].includes(market.kind)) {
    throw new Error("Unsupported historical market kind");
  }
  const retrieved = Date.parse(capture.retrievedAt);
  if (!Number.isFinite(retrieved)) throw new Error("Invalid capture timestamp");
  const gapRanges: TradingHistoryDataset["gapRanges"] = [];
  let totalMissingBars = 0;
  let previous = Number.NaN;
  for (const candle of candles) {
    if (
      candle.venue !== market.venue ||
      candle.kind !== market.kind ||
      candle.symbol !== market.symbol
    ) {
      throw new Error("History market identity mismatch");
    }
    const opened = Date.parse(candle.openedAt);
    if (
      !Number.isSafeInteger(opened) ||
      opened % HOUR_MS !== 0 ||
      opened + HOUR_MS > retrieved + 2_000
    ) {
      throw new Error("Unclosed, unaligned or future candle in captured history");
    }
    if (Number.isFinite(previous)) {
      const delta = opened - previous;
      if (delta <= 0 || delta % HOUR_MS !== 0) {
        throw new Error("Historical candles must be uniquely ascending and hourly aligned");
      }
      if (delta > HOUR_MS) {
        const missingBars = delta / HOUR_MS - 1;
        totalMissingBars += missingBars;
        if (!Number.isSafeInteger(totalMissingBars)) {
          throw new Error("Historical gap count exceeds safe range");
        }
        gapRanges.push({
          afterOpenedAt: new Date(previous).toISOString(),
          beforeOpenedAt: candle.openedAt,
          missingBars,
        });
      }
    }
    previous = opened;
  }
  const canonicalJson = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    source: capture.source,
    retrievedAt: capture.retrievedAt,
    market: {
      venue: market.venue,
      kind: market.kind,
      symbol: market.symbol,
      base: market.base,
      quote: market.quote,
      status: market.status,
      priceIncrement: market.priceIncrement,
      quantityIncrement: market.quantityIncrement,
      minNotional: market.minNotional,
      expiryAt: market.expiryAt,
    },
    candles: candles.map((bar) => ({
      venue: bar.venue,
      kind: bar.kind,
      symbol: bar.symbol,
      openedAt: bar.openedAt,
      durationMs: bar.durationMs,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      quoteVolume: bar.quoteVolume,
      confirmed: bar.confirmed,
    })),
  });
  return {
    capture,
    canonicalJson,
    coverage: {
      schemaVersion: SCHEMA_VERSION,
      firstOpenedAt: candles[0]!.openedAt,
      lastOpenedAt: candles[candles.length - 1]!.openedAt,
      gapRanges,
      totalMissingBars,
      eligibleForSpotWalkforward:
        market.kind === "spot" &&
        market.status === "active" &&
        gapRanges.length === 0 &&
        candles.length >= 22,
    },
  };
}
