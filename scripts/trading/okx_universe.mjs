#!/usr/bin/env node
// Read-only, point-in-time OKX candidate universe for Alpha Discovery research.
// Live market discovery is NOT a historical listing/delisting survivor-bias fix.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const output = process.argv[2];
const limit = Number(process.argv[3] ?? "80");
if (!output || !/\.json$/i.test(output) || !Number.isInteger(limit) ||
    limit < 50 || limit > 150) {
  process.stderr.write("Usage: node okx_universe.mjs NEW_OUTPUT.json [50..150]\n");
  process.exit(2);
}
const origin = "https://www.okx.com";
async function fetchPublic(path) {
  const url = new URL(origin + path);
  if (url.origin !== origin || !["/api/v5/public/instruments", "/api/v5/market/tickers"].includes(url.pathname)) {
    throw new Error("Endpoint not allowed");
  }
  const response = await fetch(url, {
    method: "GET", redirect: "error",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("OKX HTTP_" + response.status);
  const data = await response.text();
  if (Buffer.byteLength(data, "utf8") > 3500000) throw new Error("Large market response");
  const parsed = JSON.parse(data);
  if (parsed.code !== "0" || !Array.isArray(parsed.data)) {
    throw new Error("Unexpected market response");
  }
  return {data: parsed.data, digest: createHash("sha256").update(data).digest("hex")};
}
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const asOf = Date.now();
const [instruments, tickers] = await Promise.all([
  fetchPublic("/api/v5/public/instruments?instType=SWAP"),
  fetchPublic("/api/v5/market/tickers?instType=SWAP"),
]);
const quoteBySymbol = new Map(tickers.data.map(x => [x.instId, x]));
const minimumAgeMs = 90 * 24 * 60 * 60 * 1000;
const candidates = [];
const exclusions = {};
function exclude(reason) {exclusions[reason] = (exclusions[reason] ?? 0) + 1}
for (const market of instruments.data) {
  const id = market.instId;
  if (!/^[A-Z0-9]+-USDT-SWAP$/.test(id ?? "") ||
      market.ctType !== "linear" || market.instCategory !== "1" || market.settleCcy !== "USDT" ||
      market.state !== "live") {exclude("unsupported_or_not_live"); continue;}
  const listTime = Number(market.listTime);
  if (!Number.isSafeInteger(listTime) || asOf - listTime < minimumAgeMs) {
    exclude("less_than_90_days_listed"); continue;
  }
  const tick = quoteBySymbol.get(id);
  if (!tick) {exclude("missing_ticker"); continue;}
  const last = positiveNumber(tick.last);
  const baseVolume24h = positiveNumber(tick.volCcy24h);
  const bid = positiveNumber(tick.bidPx), ask = positiveNumber(tick.askPx);
  if (!last || !baseVolume24h || !bid || !ask || ask < bid) {
    exclude("invalid_quote"); continue;
  }
  // OKX SWAP volCcy24h is reported in base currency; quoted USDT turnover
  // estimated as baseVolume24h * last, NOT guaranteed historical transaction cost.
  const turnover24h = last * baseVolume24h;
  const spreadBps = 10000 * (ask - bid) / ((bid + ask) / 2);
  if (!Number.isFinite(turnover24h) || turnover24h < 2_000_000) {
    exclude("low_quote_turnover"); continue;
  }
  if (spreadBps > 30) {exclude("wide_spread"); continue;}
  const lot = positiveNumber(market.lotSz), contractValue = positiveNumber(market.ctVal);
  if (!lot || !contractValue || market.ctValCcy !== id.slice(0, -10)) {
    exclude("contract_metadata_unverified"); continue;
  }
  candidates.push({
    symbol: id,
    listed_since: new Date(listTime).toISOString(),
    last_usdt: last,
    estimated_24h_quote_turnover_usdt: Math.round(turnover24h),
    spread_bps: +spreadBps.toFixed(4),
    contract_value_in_base: contractValue,
    lot_size_contracts: lot,
    tick_size_usdt: positiveNumber(market.tickSz),
    funding_verified: false,
    history_90d_verified: false,
  });
}
candidates.sort((a,b)=>b.estimated_24h_quote_turnover_usdt-a.estimated_24h_quote_turnover_usdt);
const snapshot = {
  schema: "okx_usdt_swap_universe_v1",
  source: "official_okx_public_rest",
  fetched_at_utc: new Date(asOf).toISOString(),
  instruments_response_sha256: instruments.digest,
  tickers_response_sha256: tickers.digest,
  selection: {
    minimum_listing_days: 90,
    min_estimated_24h_turnover_usdt: 2_000_000,
    max_spread_bps: 30,
    limit,
    note: "Current point-in-time membership only; delisted assets and historical membership not verified",
  },
  total_live_liquid_candidates: candidates.length,
  selected: candidates.slice(0, limit),
  excluded_counts: exclusions,
  all_eligible_symbols_ranked: candidates.map(x=>x.symbol),
};
if (snapshot.selected.length < 50) {
  throw new Error("Fewer than 50 eligible liquid markets; do not claim research coverage");
}
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(snapshot, null, 2)+"\n", {flag:"wx", mode:0o600});
process.stdout.write(JSON.stringify({
  as_of: snapshot.fetched_at_utc,
  eligible: candidates.length, selected: snapshot.selected.length,
  top_10: snapshot.selected.slice(0,10).map(x=>x.symbol),
  output
})+"\n");
