# Algorithm Discovery v5 — point-in-time acquisition and 50-market source audit

**2026-10-29 — completed bounded manual source capture. Research-only. No trading approval.**

## Why v5 is a data-integrity milestone, not an edge claim

v1-v3's price-only hypotheses largely failed after execution costs. v4's funding-conditioned ETH result (+0.2999% modeled fixed-notional return in an already exposed development slice; +0.0618% after double fees) was not independently validated and, crucially, used **settlement timestamps** with assumed 15/60-minute release delays rather than authenticated original **publication timestamps**. A backtest can therefore accidentally make external information available before it was observed. v5 begins collecting new, independently timestamped *forward* observations to close that gap; it does **not** retrofit past forecasts or OI into July–September.

Public endpoints checked on the physical Windows computer with no credentials:

- [OKX public Open Interest](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-open-interest) — `GET /api/v5/public/open-interest?instType=SWAP&instId=...`
- [OKX public Funding Rate](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate) — `GET /api/v5/public/funding-rate?instId=...`
- `GET /api/v5/public/time` before and after every 5-instrument batch.

The OI response supplies an exchange-generated `ts` and OI values; the funding response supplies a **forecast** funding rate, forecast funding time, a server-generated `ts`, and potentially a reported prior settled rate. **None** is an original distribution/receive timestamp for older snapshots; it is not legitimate to equate `fundingTime` to the time an actual rate or forecast became public.

## Frozen 50-candidate source list

Earlier saved source file in the Rakazo research directory:
`okx-crypto-80-20261029-091422.json` with claimed public OKX instrument/ticker capture at **2026-10-29 06:14:22.890 UTC**. Stored screening conditions: >=90 listing days, estimated 24h turnover >=2m USDT, spread <=30 bps, top 80. Selected top **50 by previously recorded turnover**, 50th turnover approx **11,733,266 USDT**; no post-return choice among markets in this run.

**Provenance caveat:** the earlier source JSON includes SHA-256s of source instrument/ticker responses but their **original raw API bytes were not recovered in this checkpoint**. The original screen cannot be independently replayed from those hashes. It represents current-date candidates, **not** proof of historical membership, 90-day data coverage, survivorship-free universe or historically executable liquidity. The 50 candidate identities and order are now frozen in `pit-captures/universe-50-20261029.json`; SHA-256 `3193fcab0a38e6a881d5b26e28efb1db59e60a0e051a8084112a19f53274a9d3`.

## Capture timeline, all data verifiable locally

Exact manual collection: from **2026-10-29 17:48:04.872 UTC** through **17:50:47.996 UTC**, elapsed 162.124 seconds. Ten consecutive batches of five ranked instruments. Each batch has:

- five raw Open Interest public REST responses;
- five raw funding **forecast** public REST responses;
- two raw public time-service responses, one before and one after;
- request start, complete receipt time, exchange `ts` when applicable, raw response SHA-256, URL and strict policy flags in its `manifest.json`.

Result: **50/50 instruments, 50 OI snapshots, 50 forecast funding snapshots, 20 clock responses, 120 individually hashed raw responses in ten manifests**. No 429/rate-limit error, missing instrument, instrument mismatch, rejected clock response or incomplete batch in this run. The audit re-reads and independently validates the raw bytes and source hashes, instrument identity, UTC clock proximity, timestamp ordering, no duplicate symbols and exact agreement with the frozen rank order.

The audit output is:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/audit-50-20261029.json`
SHA-256 `2583d565d03c52449e7822e2af4b37440e9a3dc2a1d3c9418afe63d34d0cb484`.

The raw snapshots and audit report **remain on the user's physical Windows research machine, not committed to the Git repository**. Source code and tests are committed.

A prior proof-of-concept snapshot of BTC and ETH was separately stored as `okx-pit-v5-20261029-01`, manifest SHA-256 `2e30cbe85129529a1c370d2801dcb477227379f521c67e53279ee970e6a98cad`. This proof-of-concept was not mixed with the ten ranked batches or treated as additional independent markets.

## Programmatic safeguards

`scripts/trading/algorithm_pit_capture_v5.py`:

- allowlisted, strictly public `time`, `open-interest`, `funding-rate` URLs; no private/account/order keys or network routes;
- max five instruments per manual run; no polling, retry scheduler, autonomous monitoring or credentials;
- capture exact response bytes and `request_sent_ms`, `received_complete_ms`; conservative information availability is **not earlier than complete receipt**; exchange `ts` never silently replaces local receipt time;
- reject invalid JSON fields, duplicate keys, NaN/Inf, malformed symbols, bad instruments, implausible values, stale/future exchange timestamps, and large/unbounded responses;
- refuse overwriting any existing evidence directory; write only after all public calls validate;
- verify all bytes on read; a falsified hash or field fails closed.

`point_in_time_oi_delta` rejects any proposed signal unless **two separate observations** have actually been received at least 15 minutes apart and the later observation is not stale. With a single ranked snapshot, **0/50 markets currently have a valid OI change estimate**. Funding forecast snapshot alone does not certify historic realized funding or carry cash flow.

`scripts/trading/algorithm_pit_universe_v5.py` freezes and validates the stored 50-market source list; `scripts/trading/algorithm_pit_audit_v5.py` verifies all ten sorted batches and rejects incomplete or contaminated source evidence.

This is an independently useful acquisition process, **NOT** an implemented trading strategy or an independent performance evaluation. No v5 profitability statistic has been computed.

## Future analysis protocol — not executed

1. Additional **manual** future snapshots must be recorded and audited on separate acquisition times to estimate OI change. Do not backfill the first 15 minutes with zero, interpolate a missing observation, or infer absent publication times.
2. Use a strictly forward, sealed data stream with immutable source hashes, generation and actual receipt times. A new signal must be defined only from observations already received before a candle's decision time.
3. For news, require original and revision publication/receipt timestamps; for historical L2, retain ordered book update sequence, gaps and receive times. These sources were **not** collected here.
4. Before evaluating any performance, freeze feature definitions, decision rules, point-in-time universe/exclusions, funding settlement cashflow and execution assumptions, a future evaluation window and multiple-hypothesis controls. The July–September 2026 v1–v4 slices cannot be converted to independent evidence by relabeling.
5. Even after data exists, use correct contract size, mark/index, funding settlements, spread, impact, stress, margin and liquidation treatment before any claim about futures returns. No guarantees of daily percentage return or liquidation avoidance.

**Prohibited actions maintained:** no real or PAPER orders, no active Trader changes, no main merge, no model autonomy, no unattended scheduler, no paid services, no API keys. The local research host remains under user control.
