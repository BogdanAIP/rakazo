import type {
  PaperPerpetualSnapshot,
  TradingInstrument,
  TradingPerpContext,
} from "@rakazo/contracts";
import {
  TradingDecimalSchema,
  TradingInstrumentSchema,
  TradingPerpContextSchema,
  TradingPositiveDecimalSchema,
  TradingSignedRateSchema,
} from "@rakazo/contracts";
import * as z from "zod";

/**
 * OKX read-only PERPETUAL market context. This module cannot access accounts,
 * margin settings, wallets, secrets or place any order.
 * Sources: OKX public funding-rate, open-interest, mark-price REST docs.
 */

import { createHash } from "node:crypto";
import { PaperPerpetualSnapshotSchema } from "@rakazo/contracts";
import {
  paperPerpetualAmount as amount,
  formatPaperPerpetualAmount as format,
  isFreshPaperObservation,
} from "@rakazo/core";
import { fetchOkxClosedOneHourHistory } from "./trading-okx-history.js";

/** Public observations only. Contract lots are converted to BASE units exactly.
 * Fee/slippage are simulator assumptions; risk-tier limits are public venue data.
 */
export async function fetchOkxPaperPerpetualSnapshot(
  instrument: string,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<PaperPerpetualSnapshot> {
  if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(instrument))
    throw new Error("Unsupported linear USDT perpetual");
  const fetchImpl = options.fetchImpl ?? fetch;
  const get = async (path: string) => {
    const response = await fetchImpl(ORIGIN + path, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Public perpetual observation unavailable");
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Public perpetual observation too large");
    const result = z
      .object({ code: z.literal("0"), data: z.array(z.unknown()).max(600) })
      .parse(JSON.parse(text));
    return result.data;
  };
  const encoded = encodeURIComponent(instrument);
  const base = instrument.slice(0, -10);
  const records = await get("/api/v5/public/instruments?instType=SWAP&instId=" + encoded);
  if (records.length !== 1) throw new Error("Ambiguous perpetual contract");
  const terms = z
    .object({
      instId: z.literal(instrument),
      instType: z.literal("SWAP"),
      state: z.literal("live"),
      ruleType: z.literal("normal").optional(),
      settleCcy: z.literal("USDT"),
      ctType: z.literal("linear"),
      ctValCcy: z.literal(base),
      ctVal: z.string(),
      ctMult: z.string(),
      lotSz: z.string(),
      minSz: z.string(),
      tickSz: z.string(),
    })
    .parse(records[0]);
  const scale = 100000000n;
  const multiply = (a: string, b: string) => {
    const product = amount(a) * amount(b);
    if (product % scale !== 0n || product === 0n) throw new Error("Unsupported contract precision");
    return format(product / scale);
  };
  const contractBase = multiply(terms.ctVal, terms.ctMult);
  const lotBase = multiply(contractBase, terms.lotSz);
  const minimumBase = multiply(contractBase, terms.minSz);
  const market = TradingInstrumentSchema.parse({
    venue: "okx",
    kind: "perpetual",
    symbol: instrument,
    base,
    quote: "USDT",
    status: "active",
    priceIncrement: terms.tickSz,
    quantityIncrement: lotBase,
    minNotional: null,
    expiryAt: null,
  });
  const [bookRows, tierRows, historyRows] = await Promise.all([
    get("/api/v5/market/books?instId=" + encoded + "&sz=1"),
    get(
      "/api/v5/public/position-tiers?instType=SWAP&tdMode=cross&instFamily=" +
        encodeURIComponent(base + "-USDT"),
    ),
    get("/api/v5/public/funding-rate-history?instId=" + encoded + "&limit=400"),
  ]);
  if (bookRows.length !== 1) throw new Error("Ambiguous perpetual order book");
  const book = z
    .object({
      ts: z.string().regex(/^\d{13}$/),
      bids: z.array(z.array(z.string()).min(2)).min(1).max(5),
      asks: z.array(z.array(z.string()).min(2)).min(1).max(5),
    })
    .parse(bookRows[0]);
  const bid = book.bids[0]!;
  const ask = book.asks[0]!;
  if (amount(bid[0]!) === 0n || amount(ask[0]!) === 0n || amount(bid[0]!) > amount(ask[0]!))
    throw new Error("Invalid perpetual public book");
  const toBase = (contracts: string) => {
    const product = amount(contracts) * amount(contractBase);
    if (product % scale !== 0n) throw new Error("Order book unit precision unavailable");
    return format(product / scale);
  };
  const tierSchema = z.object({
    tier: z.string(),
    minSz: z.string(),
    maxSz: z.string(),
    mmr: z.string(),
    maxLever: z.string(),
  });
  const allTiers = tierRows
    .map((row) => tierSchema.parse(row))
    .sort((a, b) => Number(a.tier) - Number(b.tier));
  const tiers = allTiers.filter((row) => row.tier === "1");
  if (tiers.length !== 1) throw new Error("First maintenance tier unavailable");
  const tier = tiers[0]!;
  const mmr = (amount(tier.mmr) * 10000n + scale - 1n) / scale;
  if (mmr < 1n || mmr > 1000n) throw new Error("Unsupported maintenance tier");
  const [context, history] = await Promise.all([
    fetchOkxPublicPerpContext(market, options),
    fetchOkxClosedOneHourHistory(market, options),
  ]);
  const now = options.now ?? new Date();
  const bookAt = new Date(Number(book.ts)).toISOString();
  for (const at of [bookAt, context.mark.observedAt]) {
    if (!isFreshPaperObservation(at, now.toISOString()))
      throw new Error("Stale or future perpetual price");
  }
  const funding = historyRows
    .map((row) =>
      z
        .object({
          instId: z.literal(instrument),
          instType: z.literal("SWAP"),
          fundingTime: z.string().regex(/^\d{13}$/),
          realizedRate: z.string(),
        })
        .parse(row),
    )
    .map((row) => ({
      settledAt: new Date(Number(row.fundingTime)).toISOString(),
      rateSigned: row.realizedRate,
      priceBasis: "latest_observed_mark_simulation" as const,
    }))
    .filter((row) => Date.parse(row.settledAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt));
  if (new Set(funding.map((row) => row.settledAt)).size !== funding.length)
    throw new Error("Duplicate funding settlement");
  const sourceId =
    "okx-book:" +
    createHash("sha256")
      .update(JSON.stringify([instrument, book.ts, bid, ask]))
      .digest("hex");
  return PaperPerpetualSnapshotSchema.parse({
    market,
    fetchedAt: now.toISOString(),
    leverageLimits: {
      venue: "okx",
      instrument,
      marginMode: "cross",
      sourceId:
        "okx-tiers:" +
        createHash("sha256")
          .update(JSON.stringify([instrument, allTiers]))
          .digest("hex"),
      observedAt: now.toISOString(),
      tiers: allTiers.map((row) => ({
        id: row.tier,
        minQuantityBase: toBase(row.minSz),
        maxQuantityBase: toBase(row.maxSz),
        maxLeverage: Number(row.maxLever),
      })),
    },
    book: {
      venue: "okx",
      instrument,
      sourceId,
      observedAt: bookAt,
      bidQuote: bid[0],
      askQuote: ask[0],
      bidAvailableBase: toBase(bid[1]!),
      askAvailableBase: toBase(ask[1]!),
    },
    rules: {
      basePerContract: contractBase,
      lotIncrementBase: lotBase,
      minimumBase,
      maxTierBase: toBase(tier.maxSz),
      maintenanceMarginBps: Number(mmr),
      maxLeverage: Number(tier.maxLever),
    },
    markPriceQuote: context.mark.price,
    markObservedAt: context.mark.observedAt,
    fundingNextAt:
      Date.parse(context.funding.settlementAt) > now.getTime()
        ? context.funding.settlementAt
        : context.funding.nextSettlementAt,
    funding,
    history: history.candles,
  });
}

const ORIGIN = "https://www.okx.com";
const MAX_BODY = 128 * 1024;
const epoch = z.string().regex(/^\d{13}$/);
const fund = z.object({
  instId: z.string(),
  instType: z.literal("SWAP").optional(),
  fundingRate: z.string(),
  fundingTime: epoch,
  nextFundingRate: z.string().optional().default(""),
  nextFundingTime: z.string().optional().default(""),
});
const oi = z.object({
  instId: z.string(),
  instType: z.literal("SWAP"),
  oi: z.string(),
  oiCcy: z.string(),
  oiUsd: z.string(),
  ts: epoch,
});
const mark = z.object({
  instId: z.string(),
  instType: z.literal("SWAP"),
  markPx: z.string(),
  ts: epoch,
});
function timeOf(value: string): number {
  const ts = Number(value);
  if (!Number.isSafeInteger(ts) || !Number.isFinite(new Date(ts).getTime())) {
    throw new Error("Invalid OKX public telemetry timestamp");
  }
  return ts;
}

export async function fetchOkxPublicPerpContext(
  marketInput: TradingInstrument,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TradingPerpContext> {
  const market = TradingInstrumentSchema.parse(marketInput);
  if (
    market.venue !== "okx" ||
    market.kind !== "perpetual" ||
    market.status !== "active" ||
    !/^[A-Z0-9]+-[A-Z0-9]+-SWAP$/.test(market.symbol)
  ) {
    throw new Error("Only active catalog-validated OKX perpetuals are supported");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const symbol = encodeURIComponent(market.symbol);
  const load = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(ORIGIN + path, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("OKX public perpetual HTTP error: " + response.status);
    const body = await response.text();
    if (body.length > MAX_BODY) throw new Error("OKX public perpetual response too large");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("OKX public perpetual response is not JSON");
    }
    const decoded = z
      .object({ code: z.string(), data: z.array(z.unknown()).max(10) })
      .parse(payload);
    if (decoded.code !== "0") throw new Error("OKX public perpetual API error: " + decoded.code);
    if (decoded.data.length !== 1)
      throw new Error("Expected exactly one instrument telemetry record");
    return decoded.data[0];
  };
  const funding = fund.parse(await load("/api/v5/public/funding-rate?instId=" + symbol));
  const interest = oi.parse(
    await load("/api/v5/public/open-interest?instType=SWAP&instId=" + symbol),
  );
  const marked = mark.parse(await load("/api/v5/public/mark-price?instType=SWAP&instId=" + symbol));
  if ([funding.instId, interest.instId, marked.instId].some((id) => id !== market.symbol)) {
    throw new Error("Cross-instrument OKX perpetual telemetry mismatch");
  }
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid perpetual telemetry clock");
  const markMs = timeOf(marked.ts);
  const oiMs = timeOf(interest.ts);
  for (const sampledAt of [markMs, oiMs]) {
    if (sampledAt > nowMs + 2_000 || nowMs - sampledAt > 90_000) {
      throw new Error("Stale or future OKX perpetual telemetry");
    }
  }
  const settlementMs = timeOf(funding.fundingTime);
  if (settlementMs < nowMs - 60_000) {
    throw new Error("Stale perpetual funding settlement time");
  }
  const nextRate = funding.nextFundingRate;
  const nextTime = funding.nextFundingTime;
  let nextIndicativeRate: string | null = null;
  let nextSettlementAt: string | null = null;
  if (nextRate && nextTime) {
    const nextMs = timeOf(nextTime);
    if (nextMs <= settlementMs) throw new Error("Invalid next funding settlement ordering");
    nextIndicativeRate = TradingSignedRateSchema.parse(nextRate);
    nextSettlementAt = new Date(nextMs).toISOString();
  }
  // oi = number of contracts; oiCcy = base units; oiUsd = USD estimate.
  // None of these is an account position or available collateral.
  return TradingPerpContextSchema.parse({
    venue: "okx",
    market,
    fetchedAt: now.toISOString(),
    funding: {
      ratePerSettlement: TradingSignedRateSchema.parse(funding.fundingRate),
      settlementAt: new Date(settlementMs).toISOString(),
      nextIndicativeRate,
      nextSettlementAt,
    },
    openInterest: {
      contracts: TradingDecimalSchema.parse(interest.oi),
      baseUnits: TradingDecimalSchema.parse(interest.oiCcy),
      usdNotional: TradingDecimalSchema.parse(interest.oiUsd),
      observedAt: new Date(oiMs).toISOString(),
    },
    mark: {
      price: TradingPositiveDecimalSchema.parse(marked.markPx),
      observedAt: new Date(markMs).toISOString(),
    },
  });
}
