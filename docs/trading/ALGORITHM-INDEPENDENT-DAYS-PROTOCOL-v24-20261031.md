# Algorithm Discovery v24 — preregistration: replication on unseen official OKX L2 days

**2026-10-31 UTC; committed BEFORE requesting either archive's prices, reconstructing any book, or scoring anything on these two days.** V23 development source was **NEAR-USDT-SWAP, 2026-09-02 UTC**, a single day with 58 time-selected anchors and eight hypotheses' holding horizons. Its two conditions' historical assumed net averages were negative on all horizons. V24 strictly REPLICATES the mathematical specifications with no hindsight changes, on two different historically unseen market dates.

## Exactly two new archive dates, frozen now

- NEAR-USDT-SWAP **2026-09-03 UTC**: first chronological replication day.
- NEAR-USDT-SWAP **2026-09-04 UTC**: second replication day.
- **2026-09-05 UTC held untouched** as a possible later independent holdout, not analyzed in v24.

Both files must be original official OKX **400-level orderbook historical daily** source, public HTTPS link advertised by OKX public `GET /api/v5/public/market-data-history` module=4, instType=SWAP, instFamilyList=NEAR-USDT, dateAggrType=daily, begin=end=UTC midnight. This is HISTORICAL CATALOGUE only, not previously blocked LIVE `/api/v5/market/books`. Fetch metadata solely to obtain exact signed-off file URLs/sizes, not prices. Download cap **250 MiB compressed per file**, one attempt with no automatic retries/market substitution, bounded by 40s transfer each, no paid sources, never call any live/order/account endpoint. Mark a missing/oversized inaccessible file as UNAVAILABLE, not an unreported failure. Preserve immutable original `.tar.gz`, response URL/headers, archive SHA-256, uncompressed member SHA-256; HTTP+SHA NOT an independently venue-signed complete orderbook. All source data stays on private local Rakazo Windows research disk.

## Frozen source feature and economic rules — byte-for-byte v23 behavioral semantics

Instrument remains `NEAR-USDT-SWAP`. Per-day UTC timestamp anchors EXACTLY every 15 minutes **02:00–09:00 inclusive** (29) and **14:00–21:00 inclusive** (29), for exactly 58 anchors/day. Pre-feature quote times `t−30s`, `t`, and EIGHT future quote times `t+10,30,60,120,300,900,1800,3600s`. Don't opportunistically move anchors, change thresholds or pick successful horizons after seeing these two days. Eight horizons are dependent within each anchor, and adjacent 15m anchors' longer outcomes overlap; they are NOT 8×58 independent events. Independent unit is the archive DAY, only two days here, adjacent and same asset; do NOT assert universal economic or statistical significance.

Source only contains LIMIT ORDER BOOK snapshots/updates; does NOT have contemporaneous trade executions, so v14/v15 taker-flow hypotheses must not be smuggled in. Require actual full original snapshot, chronological event times, qty-zero deletions, noncrossed best book; `seqId/prevSeqId` may be absent, therefore **completeness not independently demonstrated**. As-of quote must use ONLY event-time `<= target`; next event `>target` is used ONLY to bracket source availability (never next-event price), as-of age <=5000ms, next-event bracket <=5000ms; otherwise fail closed or mark target unavailable. No OHLC proxies.

**Candidate baseline:** top-of-book imbalance `I=(bid_size−ask_size)/(bid_size+ask_size)`; predict long if `I>=0.30`, short if `I<=−0.30`, else abstain.

**Candidate exploratory pressure shock:** `dI=I_t−I_{t-30s}`; `delta_mid_bps=10000*(mid_t/mid_{t-30s}−1)`. Predict `sign(dI)` only when `abs(dI)>=0.50` and `abs(delta_mid_bps)<=3.0`, else abstain. Same candidate and thresholds as v23; NO parameter optimization, no machine-learning retraining, and no claim of novelty.

Each eligible direction scored at archived hypothetical bid/ask **crossing** quotes: long entry at ask, exit at bid; short entry at bid, exit at ask. Calculate fixed **5 bps/side and 7 bps/side** hypothetical taker fees exactly as v23 `algorithm_historical_l2_v16.scenario`. Actual account fee, fills, slippage, funding, contract lots and market impact are UNKNOWN; outcome is historical quote arithmetic only. All eight horizons fully reported, negative/positive, abstentions, missing targets and both dates.

## Replication rules and reports

Use exact existing pure v23 `signal_at`, `observation`, `summarize`, `apply_one` book replay, and source-audit concepts. Only adapt the DATE context and full original source provenance. A separate v24 wrapper must produce **one SHA-chained, finite manual checkpoint series per day** and one immutable per-day output with every anchor/candidate/horizon row. Verify original archive and decompressed spool hashes (on finalization too) before economic results; output retains code/config SHA provenance and explicit `true_out_of_sample_test` scope as **fixed-formula replication, not statistically validated alpha**. If source storage is insufficient, stop rather than bypass cap or swap dates. Never fabricate results or treat synthetics as real markets.

Summarize paired-by-day 2×8 mean proxy net results, signal counts, abstentions, source caveats. The fact that a future result may appear positive for one horizon CANNOT be used to select that horizon or claim profitability. If both days are negative, retain that negative evidence. **No real trades/PAPER or use of autonomous daemons**. The immutable existing v12 Nov1–12 plan and active Trader, main, creds, paid providers and tasks remain untouched.

## Success criterion

At least one fully reproducible independent archive-day validation pipeline output, preferably BOTH frozen days, unchanged v23 formulas, and an honest evidence assessment. Two days are too few for robust strategy validation, positive or negative. Further scientific discovery would need novel mechanisms and a larger independent multiday holdout.
