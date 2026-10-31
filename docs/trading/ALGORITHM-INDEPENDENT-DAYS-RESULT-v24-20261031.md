# Algorithm Discovery v24 — frozen formula replication, two unseen NEAR official L2 dates, and post-result outlier fragility

**Completed manually through connected Rakazo on UTC 2026-10-31. Research only: NO live/PAPER order placement, no active Trader changes, no main branch, paid sources, secrets, schedules or background daemon.** The purpose was to **repeat EXACT frozen v23 book-pressure formulas and all eight originally preregistered horizons** on previously UNSEEN archive dates, not to optimize 5m/15m/60m periods after the results.

## Method registered before any price retrieval

Protocol `docs/trading/ALGORITHM-INDEPENDENT-DAYS-PROTOCOL-v24-20261031.md`, commit **`4740cd12aaf3730718e824bfd55caf013b2e4e90`**, existed before reading either historical source's prices.

Exact new dates/instrument:
- `NEAR-USDT-SWAP`, official `400lv` original orderbook `2026-09-03 UTC`.
- `NEAR-USDT-SWAP`, official `400lv` original orderbook `2026-09-04 UTC`.
- **2026-09-05 explicitly untouched**; no source was downloaded, opened or priced in v24. It may later serve as a new explicit holdout, subject to registering its hypothesis test before evaluating it.

Both original archive links, published archive filenames and sizes were obtained from the official read-only OKX HISTORICAL catalogue `GET /api/v5/public/market-data-history`, `module=4`, without the previously blocked LIVE `market/books` endpoint. Day03 catalogue 31.01 MB (actual 32,513,600 bytes), day04 41.52 MB (actual 43,536,087 bytes); both below fixed 250 MiB hard cap. Each downloaded **once** by allowed exact HTTPS URL, original byte SHA saved and original `.data` tar member decompressed to a separately SHA-anchored spool. No market/price-based date substitution, no paid archive and no synthetic source rows included in results.

Unchanged v23 source hypothesis rules were imported DIRECTLY from `algorithm_temporal_response_v23.signal_at`, with original `apply_one` book-replay, `observation` and `summarize` functions; v24 changes only DATE and source provenance. On each day exactly 58 fixed UTC anchors every 15 minutes 02:00–09:00 and 14:00–21:00, 30-second feature lookback, and exactly EIGHT independent-of-selection horizons **10s, 30s, 60s, 120s, 300s, 900s, 1800s, 3600s**. They are nested & dependent, NOT eight independent trials per source signal. Both registered features: control top displayed bid/ask size imbalance |I|>=0.30 and exploratory 30s pressure shock |ΔI|>=0.50 with |mid30s displacement|<=3bps; original signs/directions, abstentions, and source quality checks unchanged. No executed-trade/taker-flow hypothesis was inferred from book deltas.

Only genuine book snapshot/update rows, no candles. As-of quote <=target and next-event coverage bracket >target must each be within <=5sec, or outcome unavailable. Original archive contains no book seq IDs: **gaplessness cannot independently be proved**. No independently venue-cryptographically-signed data. All economic outcomes are hypothetical best bid/ask crossing with **illustrative** 5bps EACH SIDE baseline and 7bps EACH SIDE stress, without verified fees, funding, order lots, actual fills, market impact or slippage. No actual realized PnL or prospective forecasting.

## Actual original market source provenance

All source and result originals persist on the Rakazo Windows research disk under:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/official-l2-v24/`.

| Evidence | 2026-09-03 | 2026-09-04 |
|---|---|---|
| Source raw folder | `NEAR-2026-09-03` | `NEAR-2026-09-04` |
| Original tar.gz SHA256 | `6af42fdb315f7249b2c6f863e30b79b5019c90020749d266c20176b96bffe2c9` | `81d74d4d05adf227ff33173ad111344179b72a84c2c913c489f7d3ae5a516734` |
| Compressed original bytes | **32,513,600** | **43,536,087** |
| Uncompressed original .data bytes | **276,675,889** | **356,293,637** |
| Uncompressed .data SHA256 | `f1a1690446f00e9ab0f0d704ca99500df2c14e6edfbd3428b1ab4cd33cbe2acd` | `98c1e9a6f20e10049f9fd5dc2ecbf452fedb7d82a9e6ce3fe138b1d54436dc5e` |
| Actual archived original book event rows through last fixed target | **1,608,556** | **1,823,587** |
| Full snapshots seen | **88** | **88** |
| Immutable replay checkpoints | **17** | **19** |
| Exactly registered unique quote targets reconstructed / available | **414 / 414** | **414 / 414** |
| Control imbalance eligible anchors / 58 | **49** | **47** |
| Pressure-shock eligible anchors / 58 | **11** | **12** |
| Per-day results filename | `NEAR-2026-09-03-frozen-v23-replication-v24.json` | `NEAR-2026-09-04-frozen-v23-replication-v24.json` |
| Immutable full result SHA256 | `056aaca7417863f76b9445d692a82ae971f1f0f647c47f999d40173d000049e2` | `d66eb33ebd6e76f9fe407ba91d2bd5a41a61f94b735018125abedac9b1fa2fe5` |

Both per-day result files contain **58×2×8 = 928** detailed anchor/candidate/horizon rows, original source/as-of coverage, abstentions, exact signed directions and sixteen candidate/horizon summary entries. These original full reports remain on the user's host only, not publicly uploaded. V24 code and this text report are in separate GitHub branch `research/algorithm-discovery-independent-days-v24-2026-10-31`. The original Nov1–12 immutable v12 calendar SHA256 **`6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`** is unchanged.

## Full frozen outcome: average hypothetical NET bps, assuming 5bps/side

| Horizon | Control 03 Sep (49) | Shock 03 Sep (11) | Control 04 Sep (47) | Shock 04 Sep (12) |
|---|---:|---:|---:|---:|
| 10s | −15.26 | −13.73 | −14.52 | −16.39 |
| 30s | −16.99 | −15.24 | −15.10 | −12.25 |
| 1m | −17.19 | −15.73 | −16.89 | −13.11 |
| 2m | −15.69 | −9.60 | −18.60 | −11.87 |
| 5m | −14.43 | −17.32 | −25.94 | −17.77 |
| 15m | −16.88 | −30.65 | −35.51 | **+9.07** |
| 30m | −24.92 | −13.24 | −62.23 | **+19.85** |
| 60m | −13.47 | **+18.22** | −79.82 | **+8.29** |

This repeats the clearly negative CONTROL evidence on both external archive dates. The exploratory pressure-shock rule sometimes appears positive for longer intervals, but the dates do NOT show a stable shared optimum: **3 Sep is positive only at 60m**, while **4 Sep is positive at 15m, 30m, 60m**, and **the development date 2 Sep was negative at all 8 horizons** (2 Sep 60m shock −7.44bps, from v23).

## Post-result fragility diagnostic — never reinterpret as original prereg outcome

AFTER seeing the full frozen results, separately measured the dependence on the largest single hypothetical profitable event. This test is explicitly **post-result exploratory**, not a pre-registered method for choosing a horizon, not a way to selectively delete actual observations from the frozen mean, and not a statistical p-value.

At the ONLY horizon positive on BOTH new dates (60m), the same full original results change under the diagnostic exclusion of just the SINGLE BEST observed outcome:

| Metric at 60m for shock | 3 Sep | 4 Sep |
|---|---:|---:|
| Signals | **11** | **12** |
| Long / Short | 5 / 6 | 3 / 9 |
| Profitable after assumed 5bps/side | 6/11 | 6/12 |
| **Frozen primary sample mean** | **+18.22bps** | **+8.29bps** |
| Median | +5.78bps | **−4.79bps** |
| Best single source outcome | **+228.22bps** | **+408.72bps** |
| **Exploratory mean if one best observation is excluded** | **−2.78bps** | **−28.12bps** |
| Exploratory mean if two best are excluded | **−13.11bps** | **−56.79bps** |

The 4 Sep 15m (+9.07bps) and 30m (+19.85bps) means likewise become **−26.81bps** and **−37.45bps** after excluding only the single largest winner for each horizon. These are post-hoc stress tests and MUST NOT replace the original positive primary averages; they indicate weak robustness and strong outlier dependence. Two adjacent unseen historical days plus one development day are categorically insufficient to conclude a durable profitable advantage.

The immutable detailed postresult diagnostic:
`NEAR-2026-09-03_04-postresult-robustness-v24.json` SHA-256 **`aec5a7eba10954a7bcb5257e4b9c1cce48642c4b8b21101071f57f467a3a43d9`**, local in `official-l2-v24/`. Additional code `scripts/trading/algorithm_replication_robustness_v24.py` only reads the **EXACT known SHA256** original day results and fails closed if modified or a new date is substituted.

## Code, safety and observed test coverage

- `scripts/trading/algorithm_independent_days_v24.py`: exact day/URL allowlist, one-shot archive download and SHA receipts, controlled 250MiB/40sec compressed archive, bounded 1GiB .data decompression, original source replay through 414 time targets with 100k event manually invoked chunks, immutable SHA-chained state per day; imports same v23 feature and fee code, no retrospective threshold modifications.
- `scripts/trading/test_algorithm_independent_days_v24.py`: **5/5 synthetic tests pass**; holds out date 5 Sep by allowlist, checks same 58/8 horizons and thresholds, full-book simulated replay and source/checkpoint SHA tampering.
- `scripts/trading/test_algorithm_replication_robustness_v24.py`: **3/3 synthetic tests pass**; post-hoc outlier sensitivity and original result provenance.
- Full executed disjoint suites: `test_algorithm*.py` **253/253 PASS**, plus `test_[!a]*.py` **26/26 PASS**, TOTAL **279/279 PASSED**. The previously blocked separate `test_alpha*.py` batch was NOT rerun; do not claim all tests in the entire repository.
- No v24 change to production Trader, PAPER/live, account APIs, main, secrets, paid providers, schedules or existing v12/v14/v15 independent prospective rules.

## Scientific decision and next experiment

**DECISION: NO ALGORITHM APPROVED FOR PAPER OR LIVE.** We have repeated a simple-control failure and found that the apparent 60m pressure-shock wins on each unseen day are heavily dominated by a single price event. This is a reason to NOT declare 60 minutes best. The source remains an incomplete provenance L2-only dataset without executed taker trades, venue-signed book data, verified exchange update completeness or realistic realized fills.

Do not use v24 to optimize thresholds, select winning days or treat 3+4 Sep as independent market regimes. If user authorizes further manual research, a defensible v25 action is to PRECOMMIT an exact falsification test for the existing 60m shock on **untouched 5 Sep** before downloading its source (and preferably add additional later nonadjacent dates/markets). All eight original horizon results still need to be retained and reported; do not narrow to 60m and call it independently discovered. Separately design genuinely new algorithmic mechanisms (regime-dependent response or event-triggered unwinding) with explicit hypotheses and adequate independent archival coverage, rather than merely changing 5m to 60m.

**Verdict: replication succeeded technically and scientifically retained both negative evidence and outlier-driven nominal positives; no original validated profitable algorithm exists.**
