import type { TradingInstrument, TradingTicker } from "@rakazo/contracts";
import { TradingInstrumentSchema, TradingTickerSchema } from "@rakazo/contracts";
import * as z from "zod";

/**
 * Public spot-market discovery only. No credentials, private endpoints, orders
 * or automatic network activity on import. Derivatives need a separately
 * reviewed auth/product adapter, not a silent reuse of spot endpoints.
 */
const BINGX_ORIGIN = "https://open-api.bingx.com";
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
// Expand exponent notation from exchange JSON floats without rounding. The
// shared decimal contracts still enforce sign, size and precision afterward.
function decimalText(value: string | number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const integer = match[2]!;
  const digits = integer + (match[3] ?? "");
  const exponent = Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 80) return text;
  const point = integer.length + exponent;
  const plain =
    point <= 0
      ? "0." + "0".repeat(-point) + digits
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits.slice(0, point) + "." + digits.slice(point);
  return match[1] + plain;
}
const rawDecimal = z.union([z.string(), z.number().finite()]).transform(decimalText);
const rawOptionalDecimal = rawDecimal.nullish();
const rawMarket = z.object({
  symbol: z.string(),
  // Only the documented status 1 is active. Other numeric lifecycle states
  // remain inactive instead of invalidating the complete public catalog.
  status: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  tickSize: rawOptionalDecimal,
  stepSize: rawOptionalDecimal,
  minNotional: rawOptionalDecimal,
});
const rawTicker = z.object({
  symbol: z.string(),
  bidPrice: rawOptionalDecimal,
  askPrice: rawOptionalDecimal,
  quoteVolume: rawDecimal,
  closeTime: z.number().int().nonnegative(),
});
const rawEnvelope = z.object({
  code: z.union([z.number(), z.string()]),
  msg: z.string().optional(),
  data: z.unknown(),
});

export type BingxPublicSpotSnapshot = {
  fetchedAt: string;
  markets: TradingInstrument[];
  tickers: TradingTicker[];
};

export type BingxPublicSpotOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
};

/**
 * Performs exactly two GETs to fixed public BingX endpoints. The supplied
 * fetch implementation is for offline tests/host instrumentation only.
 */
export async function fetchBingxPublicSpotSnapshot(
  options: BingxPublicSpotOptions = {},
): Promise<BingxPublicSpotSnapshot> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid snapshot clock");
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = "?timestamp=" + now.getTime();

  async function getPublic(path: string): Promise<unknown> {
    // No caller-supplied URL, headers or query fields. Never add private keys.
    const response = await fetchImpl(BINGX_ORIGIN + path + query, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("BingX public market HTTP error: " + response.status);
    const body = await response.text();
    if (body.length > MAX_RESPONSE_CHARS) throw new Error("BingX market response too large");
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error("BingX public market response is not JSON");
    }
    const envelope = rawEnvelope.parse(json);
    if (String(envelope.code) !== "0") {
      throw new Error("BingX public market API error: " + String(envelope.code));
    }
    return envelope.data;
  }

  const symbols = z
    .object({ symbols: z.array(rawMarket).max(30_000) })
    .parse(await getPublic("/openApi/spot/v1/common/symbols")).symbols;
  const rawTickers = z
    .array(rawTicker)
    .max(30_000)
    .parse(await getPublic("/openApi/spot/v1/ticker/24hr"));
  // Timestamp after the network snapshot, not at request start: avoid
  // incorrectly treating a later exchange observation as future data.
  const fetchedAt = (options.now ?? new Date()).toISOString();

  const markets: TradingInstrument[] = symbols
    // Delisted aliases are outside the canonical supported spot-symbol
    // contract. Keep valid one-character assets and exclude unsupported aliases.
    .filter((entry) => /^[A-Z0-9]{1,40}-[A-Z0-9]{1,40}$/.test(entry.symbol))
    .map((entry) => {
      const parts = entry.symbol.split("-");
      const base = parts[0];
      const quote = parts[1];
      if (!base || !quote) throw new Error("Invalid BingX symbol");
      return TradingInstrumentSchema.parse({
        venue: "bingx",
        kind: "spot",
        symbol: entry.symbol,
        base,
        quote,
        status: String(entry.status) === "1" ? "active" : "inactive",
        priceIncrement: entry.tickSize ?? null,
        quantityIncrement: entry.stepSize ?? null,
        minNotional: entry.minNotional ?? null,
        expiryAt: null,
      });
    });
  const known = new Set(markets.map((market) => market.symbol));
  if (known.size !== markets.length) throw new Error("Duplicate BingX spot symbol");

  const relevantTickers = rawTickers.filter((entry) => known.has(entry.symbol));
  if (new Set(relevantTickers.map((entry) => entry.symbol)).size !== relevantTickers.length) {
    throw new Error("Duplicate BingX spot ticker");
  }
  const tickers: TradingTicker[] = relevantTickers
    .filter(
      (entry) =>
        ![entry.bidPrice, entry.askPrice].some(
          (price) => price == null || price === "" || /^0(?:\.0+)?$/.test(price),
        ),
    )
    .map((entry) => {
      if (!Number.isFinite(entry.closeTime) || !Number.isSafeInteger(entry.closeTime)) {
        throw new Error("Invalid BingX ticker time");
      }
      const observed = new Date(entry.closeTime);
      if (!Number.isFinite(observed.getTime())) throw new Error("Invalid BingX ticker time");
      return TradingTickerSchema.parse({
        venue: "bingx",
        kind: "spot",
        symbol: entry.symbol,
        observedAt: observed.toISOString(),
        fetchedAt,
        bid: entry.bidPrice,
        ask: entry.askPrice,
        quoteVolume24h: entry.quoteVolume,
      });
    });
  return { fetchedAt, markets, tickers };
}
