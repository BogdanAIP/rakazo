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
const rawDecimal = z.union([z.string(), z.number().finite()]).transform(String);
const rawOptionalDecimal = rawDecimal.nullish();
const rawMarket = z.object({
  symbol: z.string(),
  status: z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]),
  tickSize: rawOptionalDecimal,
  stepSize: rawOptionalDecimal,
  minNotional: rawOptionalDecimal,
});
const rawTicker = z.object({
  symbol: z.string(),
  bidPrice: rawDecimal,
  askPrice: rawDecimal,
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
  const fetchedAt = now.toISOString();
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

  const markets: TradingInstrument[] = symbols.map((entry) => {
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(entry.symbol)) {
      throw new Error("BingX returned invalid spot symbol");
    }
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

  const tickers: TradingTicker[] = rawTickers
    .filter((entry) => known.has(entry.symbol))
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
  if (new Set(tickers.map((ticker) => ticker.symbol)).size !== tickers.length) {
    throw new Error("Duplicate BingX spot ticker");
  }
  return { fetchedAt, markets, tickers };
}
