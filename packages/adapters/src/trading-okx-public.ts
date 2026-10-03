import type { TradingInstrument, TradingTicker } from "@rakazo/contracts";
import {
  TradingInstrumentSchema,
  TradingPositiveDecimalSchema,
  TradingTickerSchema,
} from "@rakazo/contracts";
import * as z from "zod";

/**
 * Read-only OKX discovery. No keys, user accounts, orders or ticker-volume
 * conversions. Instrument metadata does not grant execution authority.
 * https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
 */
const ORIGIN = "https://www.okx.com";
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const types = ["SPOT", "SWAP", "FUTURES"] as const;
type OkxType = (typeof types)[number];

const instrument = z.object({
  instType: z.enum(types),
  instId: z.string().min(1),
  state: z.string(),
  ruleType: z.string().optional().default("normal"),
  baseCcy: z.string().optional().default(""),
  quoteCcy: z.string().optional().default(""),
  instFamily: z.string().optional().default(""),
  tickSz: z.string().optional().default(""),
  lotSz: z.string().optional().default(""),
  expTime: z.string().optional().default(""),
});
const envelope = z.object({
  code: z.string(),
  data: z.array(z.unknown()).max(30_000),
});
export type OkxCatalogExclusion = {
  kind: "spot" | "perpetual" | "dated_future";
  symbol: string;
  reason: "incomplete_metadata" | "pre_market_or_special_contract" | "expired_contract";
};
export type OkxPublicCatalog = {
  fetchedAt: string;
  markets: TradingInstrument[];
  excluded: OkxCatalogExclusion[];
};

function kindOf(t: OkxType): OkxCatalogExclusion["kind"] {
  if (t === "SPOT") return "spot";
  return t === "SWAP" ? "perpetual" : "dated_future";
}
function positiveOrNull(input: string): string | null {
  if (!input) return null;
  const parsed = TradingPositiveDecimalSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
function parseMarket(
  value: unknown,
  requested: OkxType,
  nowMs: number,
): { market?: TradingInstrument; excluded?: OkxCatalogExclusion } {
  const raw = instrument.safeParse(value);
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as { instId?: unknown })
      : null;
  const symbol = typeof record?.instId === "string" ? record.instId : "<unidentified>";
  const kind = kindOf(requested);
  const exclude = (reason: OkxCatalogExclusion["reason"]) => ({
    excluded: { kind, symbol, reason },
  });
  if (!raw.success || raw.data.instType !== requested) return exclude("incomplete_metadata");
  const row = raw.data;
  // OKX also classifies some pre-market X-Perps as FUTURES. Do not pretend
  // they are conventional dated futures.
  if (row.ruleType && row.ruleType !== "normal") return exclude("pre_market_or_special_contract");
  let base: string;
  let quote: string;
  if (requested === "SPOT") {
    base = row.baseCcy;
    quote = row.quoteCcy;
    if (row.instId !== base + "-" + quote) return exclude("incomplete_metadata");
  } else {
    const family = row.instFamily.split("-");
    if (family.length !== 2 || !family[0] || !family[1]) return exclude("incomplete_metadata");
    base = family[0];
    quote = family[1];
    if (!row.instId.startsWith(row.instFamily + "-")) return exclude("incomplete_metadata");
    if (requested === "SWAP" && row.instId !== row.instFamily + "-SWAP") {
      return exclude("incomplete_metadata");
    }
    if (requested === "FUTURES" && row.instId === row.instFamily + "-SWAP") {
      return exclude("incomplete_metadata");
    }
  }
  if (!/^[A-Z0-9]{2,40}$/.test(base) || !/^[A-Z0-9]{2,40}$/.test(quote)) {
    return exclude("incomplete_metadata");
  }
  let expiryAt: string | null = null;
  if (requested === "FUTURES") {
    const expiry = Number(row.expTime);
    if (!/^\d{13}$/.test(row.expTime) || !Number.isSafeInteger(expiry)) {
      return exclude("incomplete_metadata");
    }
    if (expiry <= nowMs) return exclude("expired_contract");
    expiryAt = new Date(expiry).toISOString();
  }
  const priceIncrement = positiveOrNull(row.tickSz);
  const quantityIncrement = positiveOrNull(row.lotSz);
  if (row.state === "live" && (!priceIncrement || !quantityIncrement)) {
    return exclude("incomplete_metadata");
  }
  const parsed = TradingInstrumentSchema.safeParse({
    venue: "okx",
    kind,
    symbol: row.instId,
    base,
    quote,
    status: row.state === "live" ? "active" : "inactive",
    priceIncrement,
    quantityIncrement,
    minNotional: null,
    expiryAt,
  });
  return parsed.success ? { market: parsed.data } : exclude("incomplete_metadata");
}

/** Three sequential, fixed public GET requests; no account credentials. */
export async function fetchOkxPublicCatalog(
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<OkxPublicCatalog> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid OKX catalog clock");
  const markets: TradingInstrument[] = [];
  const excluded: OkxCatalogExclusion[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    const response = await fetchImpl(ORIGIN + "/api/v5/public/instruments?instType=" + type, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("OKX public instruments HTTP error: " + response.status);
    const body = await response.text();
    if (body.length > MAX_BODY_CHARS) throw new Error("OKX public instruments response too large");
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error("OKX public instruments response is not JSON");
    }
    const data = envelope.parse(raw);
    if (data.code !== "0") throw new Error("OKX public instruments API error: " + data.code);
    for (const row of data.data) {
      const parsed = parseMarket(row, type, nowMs);
      if (parsed.excluded) {
        excluded.push(parsed.excluded);
      } else if (parsed.market) {
        const id = JSON.stringify([parsed.market.kind, parsed.market.symbol]);
        if (seen.has(id)) throw new Error("Duplicate OKX instrument identity");
        seen.add(id);
        markets.push(parsed.market);
      }
    }
  }
  return { fetchedAt: (options.now ?? new Date()).toISOString(), markets, excluded };
}

/**
 * OKX documents volCcy24h as quote-currency volume for SPOT, but base-currency
 * volume for derivatives. This function deliberately accepts SPOT markets only.
 * https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-tickers
 */
export async function fetchOkxPublicSpotTickers(
  markets: readonly TradingInstrument[],
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TradingTicker[]> {
  if (markets.some((market) => market.venue !== "okx" || market.kind !== "spot")) {
    throw new Error("OKX spot tickers require OKX spot markets only");
  }
  const known = new Set(
    markets.filter((market) => market.status === "active").map((m) => m.symbol),
  );
  if (new Set(markets.map((market) => market.symbol)).size !== markets.length) {
    throw new Error("Duplicate OKX spot market");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ORIGIN + "/api/v5/market/tickers?instType=SPOT", {
    method: "GET",
    redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("OKX public spot ticker HTTP error: " + response.status);
  const body = await response.text();
  if (body.length > MAX_BODY_CHARS) throw new Error("OKX public spot ticker response too large");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error("OKX public spot ticker response is not JSON");
  }
  const data = envelope.parse(raw);
  if (data.code !== "0") throw new Error("OKX public spot ticker API error: " + data.code);
  const rawTicker = z.object({
    instType: z.literal("SPOT"),
    instId: z.string().min(3),
    bidPx: z.string(),
    askPx: z.string(),
    volCcy24h: z.string(),
    ts: z.string().regex(/^\d{13}$/),
  });
  const tickers: TradingTicker[] = [];
  const seen = new Set<string>();
  const fetchedAt = (options.now ?? new Date()).toISOString();
  for (const value of data.data) {
    const symbol =
      typeof value === "object" && value !== null && "instId" in value
        ? (value as { instId?: unknown }).instId
        : null;
    if (typeof symbol !== "string" || !known.has(symbol)) continue;
    if (seen.has(symbol)) throw new Error("Duplicate OKX public spot ticker");
    seen.add(symbol);
    const row = rawTicker.parse(value);
    const epoch = Number(row.ts);
    if (!Number.isSafeInteger(epoch)) throw new Error("Invalid OKX ticker timestamp");
    const observedAt = new Date(epoch).toISOString();
    tickers.push(
      TradingTickerSchema.parse({
        venue: "okx",
        kind: "spot",
        symbol,
        observedAt,
        fetchedAt,
        bid: row.bidPx,
        ask: row.askPx,
        quoteVolume24h: row.volCcy24h,
      }),
    );
  }
  return tickers;
}
