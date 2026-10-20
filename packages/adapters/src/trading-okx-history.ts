import {
  type TradingCandle,
  TradingCandleSchema,
  type TradingInstrument,
  TradingInstrumentSchema,
} from "@rakazo/contracts";
import * as z from "zod";

/**
 * Public OKX 1H history for ONE catalog-validated instrument, maximum 100 rows.
 * https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history
 *
 * Never use incomplete bars, vol/volCcy (different units for derivatives), a
 * dynamic hostname, private keys, or an account/order operation.
 */
const ORIGIN = "https://www.okx.com";
const HOUR_MS = 3_600_000;
const MAX_RESPONSE_CHARS = 256 * 1024;
const responseSchema = z.object({
  code: z.string(),
  data: z
    .array(
      z.tuple([
        z.string(),
        z.string(),
        z.string(),
        z.string(),
        z.string(),
        z.string(),
        z.string(),
        z.string(),
        z.enum(["0", "1"]),
      ]),
    )
    .max(100),
});
export type OkxClosedHistory = {
  fetchedAt: string;
  candles: TradingCandle[];
};

export async function fetchOkxClosedOneHourHistory(
  instrument: TradingInstrument,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<OkxClosedHistory> {
  const market = TradingInstrumentSchema.parse(instrument);
  if (
    market.venue !== "okx" ||
    !["spot", "perpetual", "dated_future"].includes(market.kind) ||
    !/^[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/.test(market.symbol)
  ) {
    throw new Error("Unsupported OKX public-history instrument");
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid history clock");
  const fetchImpl = options.fetchImpl ?? fetch;
  const url =
    ORIGIN +
    "/api/v5/market/history-candles?instId=" +
    encodeURIComponent(market.symbol) +
    "&bar=1H&limit=100";
  // Public GET only: one bounded retry for a brief disconnect or short rate limit.
  // Never retry malformed/unauthorized responses and never return stale history.
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (attempt > 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750));
      continue;
    }
    if (attempt > 0 || ![408, 429, 502, 503, 504].includes(response.status)) break;
    const retryAfter = response.headers.get("retry-after");
    const delayMs =
      retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 750;
    if (!Number.isFinite(delayMs) || delayMs > 2000) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!response?.ok) {
    throw new Error(`OKX public history HTTP error: ${response?.status ?? "unavailable"}`);
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error("OKX public history response too large");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("OKX public history response is not JSON");
  }
  const parsed = responseSchema.parse(payload);
  if (parsed.code !== "0") throw new Error(`OKX public history API error: ${parsed.code}`);
  const candles: TradingCandle[] = [];
  const seen = new Set<string>();
  for (const row of parsed.data) {
    if (row[8] === "0") continue; // Never trade/research on an unconfirmed candle.
    if (!/^\d{13}$/.test(row[0])) throw new Error("Invalid OKX candle epoch");
    const openedMs = Number(row[0]);
    if (!Number.isSafeInteger(openedMs) || openedMs % HOUR_MS !== 0) {
      throw new Error("Invalid OKX candle alignment");
    }
    if (openedMs + HOUR_MS > nowMs) {
      throw new Error("Future or prematurely confirmed OKX history bar");
    }
    const openedAt = new Date(openedMs).toISOString();
    if (seen.has(openedAt)) throw new Error("Duplicate OKX confirmed candle");
    seen.add(openedAt);
    candles.push(
      TradingCandleSchema.parse({
        venue: "okx",
        kind: market.kind,
        symbol: market.symbol,
        openedAt,
        durationMs: HOUR_MS,
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        quoteVolume: row[7], // Explicit volCcyQuote: quote units on spot AND derivatives.
        confirmed: true,
      }),
    );
  }
  candles.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  return {
    fetchedAt: (options.now ?? new Date()).toISOString(),
    candles,
  };
}
