import {
  type TradingCandle,
  TradingCandleSchema,
  type TradingInstrument,
  TradingInstrumentSchema,
} from "@rakazo/contracts";
import * as z from "zod";

const ORIGIN = "https://open-api.bingx.com";
const HOUR_MS = 3_600_000;
const MAX_RESPONSE_CHARS = 256 * 1024;
const rawTimestamp = z
  .union([z.string().regex(/^\d{13}$/u), z.number().int().nonnegative()])
  .transform(String);
const rawDecimal = z.union([z.string(), z.number().finite()]).transform(String);
const responseSchema = z.object({
  code: z.union([z.string(), z.number()]),
  msg: z.string().optional(),
  data: z
    .array(
      z.tuple([
        rawTimestamp,
        rawDecimal,
        rawDecimal,
        rawDecimal,
        rawDecimal,
        rawDecimal,
        rawTimestamp,
        rawDecimal,
      ]),
    )
    .max(100),
});

export type BingxClosedHistory = {
  fetchedAt: string;
  candles: TradingCandle[];
};

/** Public BingX spot 1H history for one catalog-validated instrument.
 * Fixed endpoint, no credentials, no private/account/order operation. */
export async function fetchBingxClosedOneHourHistory(
  instrument: TradingInstrument,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<BingxClosedHistory> {
  const market = TradingInstrumentSchema.parse(instrument);
  if (
    market.venue !== "bingx" ||
    market.kind !== "spot" ||
    market.status !== "active" ||
    !/^[A-Z0-9]+-[A-Z0-9]+$/u.test(market.symbol)
  ) {
    throw new Error("Unsupported BingX public-history instrument");
  }
  const requestNow = options.now ?? new Date();
  const nowMs = requestNow.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid BingX history clock");

  const url =
    ORIGIN +
    "/openApi/spot/v2/market/kline?symbol=" +
    encodeURIComponent(market.symbol) +
    "&interval=1h&limit=100&timestamp=" +
    nowMs;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("BingX public history HTTP error: " + response.status);
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error("BingX public history response too large");

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("BingX public history response is not JSON");
  }
  const parsed = responseSchema.parse(payload);
  if (String(parsed.code) !== "0") {
    throw new Error("BingX public history API error: " + String(parsed.code));
  }

  const candles: TradingCandle[] = [];
  const seen = new Set<string>();
  for (const row of parsed.data) {
    const openedMs = Number(row[0]);
    const closedMs = Number(row[6]);
    if (
      !Number.isSafeInteger(openedMs) ||
      !Number.isSafeInteger(closedMs) ||
      openedMs % HOUR_MS !== 0
    ) {
      throw new Error("Invalid BingX candle alignment");
    }
    const duration = closedMs - openedMs;
    if (duration < HOUR_MS - 1_000 || duration > HOUR_MS) {
      throw new Error("Invalid BingX candle duration");
    }
    if (closedMs > nowMs || openedMs + HOUR_MS > nowMs) continue;

    const openedAt = new Date(openedMs).toISOString();
    if (seen.has(openedAt)) throw new Error("Duplicate BingX closed candle");
    seen.add(openedAt);
    candles.push(
      TradingCandleSchema.parse({
        venue: "bingx",
        kind: "spot",
        symbol: market.symbol,
        openedAt,
        durationMs: HOUR_MS,
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        quoteVolume: row[7],
        confirmed: true,
      }),
    );
  }
  candles.sort((left, right) => Date.parse(left.openedAt) - Date.parse(right.openedAt));
  return {
    fetchedAt: (options.now ?? new Date()).toISOString(),
    candles,
  };
}
