import {
  TradingDecimalSchema,
  type TradingInstrument,
  TradingInstrumentSchema,
  type TradingPerpContext,
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
