# Algorithm Discovery v22 — genuine OKX 400-level historical L2 replay; real archive parsed successfully

**Completed on 31 October 2026, manual on connected Rakazo Windows, in research-only branch `research/algorithm-discovery-historical-l2-benchmark-v22-2026-10-31`.**

## Clear scientific scope (no ex-post alpha claim)

**This is a fixed historical market-data processing and fee arithmetic benchmark, NOT a precommitted prospective price forecast, model backtest, actual/paper trade or proven algorithm.** All source dates and initial target instants were fixed BEFORE observing any source price values. Both LONG and SHORT directions were evaluated and retained; the more favorable one was **not** selected as an AI prediction.

Original v22 plan: `BTC-USDT-SWAP` 400-level L2 archive on `2026-09-02`, UTC 12:00→12:05, 5bps/side and 7bps/side. The public official archive catalogue returned **342.84 MB**, violating the already frozen 250MiB cap; **no BTC archive was downloaded and no BTC 5-minute quote was claimed**. Explicit before-prices feasibility amendment `docs/trading/ALGORITHM-HISTORICAL-L2-FEASIBILITY-AMENDMENT-v22-20261031.md` selected *separate supplementary* **`NEAR-USDT-SWAP`**, same module/date/times, since its **30.18 MB** catalogue size was the lowest among the predefined metadata-only candidates. This is NOT replacement of BTC results, nor data-driven selection by return. First protocol `docs/trading/ALGORITHM-HISTORICAL-L2-BENCHMARK-PROTOCOL-v22-20261031.md`.

Official documentation: OKX `GET /api/v5/public/market-data-history`, public read-only historical data catalogue, module `4` = 400-level orderbook, with true file URL/size/filename; orderbook daily calendars are UTC and orderbooks typically available T+3 (no guarantee). https://www.okx.com/docs-v5/en/#get-historical-market-data . This is distinct from the previously blocked **LIVE `/api/v5/market/books`**; that blocked real-time endpoint was never called or circumvented.

## Verified actual data provenance

The archive was retrieved **exactly once** via public catalogue-listed HTTPS URL, using `scripts/trading/algorithm_official_archive_download_v22.py` with exact URL allowlist, one-attempt cap 250MiB, 30s limit and immutable binary + JSON receipt:

`https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/20260902/NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.tar.gz`

- HTTP status: **200**, `Content-Type: application/gzip`, `Content-Length: 31,646,162 bytes`.
- `Last-Modified: Thu, 03 Sep 2026 00:05:06 GMT`.
- `ETag: "f0532e872746cf3b49be3b7a15a6c19e"` (HTTP/CDN metadata, **not** an independent OKX cryptographic signature).
- **Original tar.gz SHA-256:** `33ee27aa5d740255ef01f76f3a7183606e2f5bff6898931605857906b55bf337`.
- Real tar member (NOT `.jsonl`, contrary to the earlier guessed v16 parser): `NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.data`; it contains NDJSON `snapshot/update` rows with `instId`, `ts`, `asks`, `bids` and price/size/order-count levels.
- **Uncompressed original member:** 272,265,724 bytes; SHA-256 `e15dc177dc4a4e6ee6df2813d79c62e2b34a161fea9d9d4641df8e54fa7bb06b`.
- Original tar was preserved, never overwritten, not uploaded to GitHub.

Immutable on-host folder:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/official-l2-v22/NEAR-2026-09-02/`

The original archive lacks visible `seqId/prevSeqId` markers in its genuine `.data` events. Consequently **book update stream gaplessness is not independently provable from this archive**, even though monotonic timestamps, noncrossed books, original hashes and repeated snapshots were validated. No OHLC/candlestick prices were substituted as bid/ask. There is no verified actual order fill, market slippage, contract lot, funding cost or authenticated venue digital signature.

## Reconstructed fixed as-of bid/ask, exchange UTC

**No future leakage:** for each target, all L2 records up to/including target exchange timestamp are applied; the first subsequent record establishes a coverage bracket only and its prices are never used for the earlier quote.

| Target | Latest in-time book event | Age | Best bid | Best ask | Original top level sizes (contracts) |
|---|---|---:|---:|---:|---|
| 2026-09-02 **12:00:00.000 UTC** | 11:59:59.764 | 236 ms | **1.856** | **1.857** | bid 839.6 / ask 61.1 |
| 2026-09-02 **12:05:00.000 UTC** | 12:04:59.674 | 326 ms | **1.853** | **1.854** | bid 330.6 / ask 156.7 |

Both first events AFTER the respective target times are at target+**4ms**, used only to prove temporal coverage. Underlying 5-minute quote changes are NOT a model forecast.

### Hypothetical crossing-best-quote arithmetic, BOTH directions

All values basis points (bps) on example position price, no leverage and **assuming** taker fee 5bps on entry and exit notional separately, stress fee 7bps/side. Includes quoted bid/ask crossing spread, but does **not** guarantee fills or include funding, execution slippage, market impact, lot/contract unit constraints.

| Fixed position direction | Hypothetical gross crossing quote bps | Illustrative net 5bps/side | Stress net 7bps/side |
|---|---:|---:|---:|
| **Long** entry ask1.857, exit bid1.853 | **−21.5401** | **−31.5293** | **−35.5250** |
| **Short** entry bid1.856, exit ask1.854 | **+10.7759** | **+0.78125** | **−3.2166** |

The short's very small +0.78125bps figure under a fee assumption is not a prediction or evidence of alpha and switches negative under the higher fee scenario. Both directions are shown to prevent ex-post cherry-picking.

## Two processing pipelines reconciled on the same actual archive

1. **Direct original tar.gz streaming**: `scripts/trading/algorithm_historical_l2_official_v22.py`, full snapshot+delta replay to fixed targets. Original local output `NEAR-2026-09-02-1200-to-1205-L2-benchmark.json`, SHA-256 **`1dfd80936b0c6b759ca88f760053b9e9443b5cd8431640bb374cddb95baed301`**. The remote tool reported an internal error while the long foreground calculation completed; subsequent filesystem inspection found a genuine intact output. It was NOT rerun/overwritten.
2. **Bounded checkpoint replay**: `scripts/trading/algorithm_l2_checkpoint_v22.py` decompresses 272MB via bounded streaming, retains source+uncompressed SHA, and processes finite source chunks with **nine immutable SHA-chained checkpoints** (up to 100,000 rows/step). Reconstructed **836,367 original records** through the first bracket after 12:05 UTC, **49 complete snapshots** and all intervening deltas without post-target lookahead. Result `NEAR-2026-09-02-1200-to-1205-L2-checkpoint-verified.json`, SHA-256 **`bcb1bc1af555dba298e19219672f6af83b806baafd9d0b0802ee189866e0d609`**.
3. Explicit host-side comparison **PASS** for exact entry/exit records, both complete fee scenario outputs, original archive SHA, `last_book_ts <= target < first_after_ts` and `counts_toward_validated_alpha=false`. These are separate replay implementations using some shared decimal/source helper functions, **not two independent exchange archives**.

The 9 checkpoint records preserve offset, state and hash-chain; source tar.gz and temporary original `.data` were verified against their initial SHA before reporting results. No autonomous daemon, resident background calculation or continuous internet polling was installed.

## Safety, tests, next required stage

- New direct replay synthetic test `test_algorithm_historical_l2_official_v22.py`: 9/9 pass.
- New staged replay synthetic test `test_algorithm_l2_checkpoint_v22.py`: 4/4 pass, including no future leakage, tampering and hash-chain test.
- After actual archive processing: `test_algorithm*.py`: **237/237 pass**, `test_[!a]*.py`: **26/26 pass**, so **263 executed test cases pass**. The previously blocked separate `test_alpha*.py` group was not rerun, and is not claimed.
- Any eventual **prospective** user-invoked validation requires genuine frozen v14/v15 source-only decisions **before** outcome and a later official archive for their actual UTC dates. A new adapter must bridge the original local-capture vs archive exchange-event clock offset honestly; the v20 apparent 1.66s difference was NOT independently calibrated. A fixed v12 60 market-day source-slot experiment cannot reach prior >=100 independent eligible-event criterion; data collection must eventually be expanded with separate genuine holdout days.
- Official orderbook archives are **typically T+3**, not immediate 5-minute API results, per the official API guide. It can be feasible to close the laptop after manually freezing a source-only forecast and compare against the archive days later, without re-running a previously blocked live REST book query.
- No original v12 Nov1–12 calendar changes; no main, active Trader/PAPER/live, schedules, private APIs, credentials, paid sources, or trading orders modified.

**Verdict: for the first time, a genuine downloadable official OKX 400-level L2 archive was ingested and a reproducible 5-minute best bid/ask + illustrative fee calculation was performed, independently crosschecked with a bounded checkpoint replay. This is a significant DATA PIPELINE milestone, not a profitable algorithm discovery.**
