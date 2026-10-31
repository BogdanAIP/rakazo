# Algorithm Discovery v30 — independent-source liquidity/flow falsification

**Run date:** 2026-10-31 UTC. **STATUS: PREDECLARED SIMPLE ALIGNMENT HYPOTHESIS DID NOT REPLICATE; NO CONFIRMED ALGORITHM OR PROFIT.**

- **Preregistered BEFORE new sources accessed:** [v30 original protocol](ALGORITHM-LIQUIDITY-PREREG-v30-20261031.md), commit e8f07505dc59ddf45aa7f3d1bc2dfeebc23274f9.
- **Source-linked historic news:** [v30 news register](ALGORITHM-NEWS-CONTEXT-v30-20261031.md); incomplete news availability, noncausal.
- **Replay implementation:** scripts/trading/algorithm_v30_archive_acquire.py, algorithm_v30_trade_onset.py, algorithm_v30_l2_snapshot_audit.py and algorithm_v30_summary.py; tests in test_algorithm_v30_research.py. All relative to repo root.
- **All numerical outcomes:** SHA-locked original local 2026-09-10 and 2026-09-17 OKX original source archives and read-only results in private Windows path C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/onset-v30/. Original v29, reserved September 5, Nov 1–12 plan, Trader, PAPER and live trading untouched. Full local summary SHA256: 9fa9c6e92aa89ea587a7a404f64095d5b69669f8928137635b0e35e574069f0f.

## Predeclared scope and past-only mechanism

Official OKX UTC+8 archive day labels 2026-09-10, 2026-09-17. Genuine signed executed taker trade CSV for NEAR-USDT-SWAP and SOL-USDT-SWAP (4 archives), genuine confirmed 1m OHLC for both plus BTC and ETH (8 archives), original 400-level historical timestamped L2 for primary symbols (4 archives). Total original 16 historical downloaded ZIP/tar.gz with immutable SHA-256 receipts, no API keys or payment; all source files persisted without modification. Original binary files are not checked into GitHub.

For each instrument/day examine exact 467 decision minutes 02:00..09:00 inclusive and 14:00..14:45 inclusive UTC, total **1,868 decisions**, no outcome-selected minutes. Detector at T sees only real trades strictly <T. Last60sec >=5 fills, contract volume/min >=3x preceding [T-360,T-60) contract volume/min, absolute buy minus sell contract fraction >=0.60, baseline >0. Direction sign of executed flow. Original 60min cooldown on *first* candidate irrespective of outcome, same as v29. MUTED if last completed minute drift <=5bp is descriptive only. **54** minutes qualified before cooldown, **33** suppressed, **21 first onsets** evaluated. All 4 x 467 audit decision ledgers preserved.

Competing outcomes calculated strictly separately using original future completed minute CLOSE +100bp signal-direction FIRST versus -100bp adverse FIRST up to 60min, else CENSORED_60. BTC and ETH equal-weight controls from the same official 1m ZIP. No bid/ask-crossing, fees, fills or real-time availability assumptions in barrier calculations.

For each of the 21 preselected T, recover the original order book at T-60s and T from the nearest preceding original source snapshot; reapply genuine intervening incremental book updates. Each original source archive contains 96 original full snapshots/day. Source original gzip SHA, uncompressed source SHA, matching snapshot offsets and lines and individual replay JSON all verified. Require both as-of quotes age <=5s AND first posttarget source event bracket <=5s; future bracket only confirms source-time coverage and never changes past quote feature. **21/21 event pairs, 42/42 source-as-of quotes, available.** Archived events did **not contain exchange sequence IDs**; it is not possible to certify the absence of hidden missing increments or actual network receipt timestamps. This is strictly source-time historical corroboration.

Frozen rule before new source access: I5=(bid depth first 5 - ask depth first 5)/(sum both); alignment if d*(I5_T-I5_Tminus60)>0, otherwise unaligned including zero. Do not retune or exclude outcomes based on group.

## Results — original 21 first signals

| Instrument (OKX) / archive day | First onsets | Favorable +100bp FIRST | Adverse -100bp FIRST | Censored 60m | L2 aligned |
|---|---:|---:|---:|---:|---:|
| NEAR 2026-09-10 | 5 | 4 | 0 | 1 | 3 |
| NEAR 2026-09-17 | 5 | 3 | 1 | 1 | 4 |
| SOL 2026-09-10 | 6 | 0 | 0 | 6 | 3 |
| SOL 2026-09-17 | 5 | 0 | 0 | 5 | 4 |
| **Total** | **21** | **7** | **1** | **13** | **14** |

| Original L2 group | n | Favorable FIRST | Adverse FIRST | CENSORED | Favorable fraction | Approx descriptive 95% Wilson interval |
|---|---:|---:|---:|---:|---:|---|
| Aligned | 14 | 4 | 1 | 9 | **28.57%** | [11.72%,54.65%] |
| Unaligned | 7 | 3 | 0 | 4 | **42.86%** | [15.82%,74.95%] |

**Primary predeclared difference D=28.57%−42.86%=−14.29 percentage points**, in the wrong direction for v29 hypothesis. **NEGATIVE PILOT RESULT**, not proven source of alpha, not significance evidence, sample n=21 and instrument/day clusters heavily dependent. The fitted positive 5/8 vs1/7 finding on already-seen v29 days did NOT carry over as a favorable fraction ordering to the independent historical dates.

NEAR alone: aligned 4 favorable/7, unaligned 3 favorable/3; SOL alone: aligned 0/7, unaligned 0/4. Even within NEAR, the group ordering is not evidence of alignment benefit. Material cross-asset volatility/regime differences.

**First-passage minutes from end-of-minute CLOSE are NOT fills, win rates of real trades, tradable +1% stops/limits, or PnL.**

## Frozen no-onset negative controls (no cherry-picked controls)

Exactly eight time anchors per instrument/day 02:15,03:15,04:15,05:15,06:15,07:15,08:15,14:15 UTC: 32 expected. Exclude only predeclared those coincident with/on 60min cooldown from first onset: 17 excluded; **15 scored** with pseudo-direction from strictly prior executed taker share, 0 missing direction. Control outcomes 5 favorable,1 adverse,9 censored = **5/15 = 33.33% favorable**. Onset group 7 favorable/21=**33.33%**. No better empirical favorable first-passage enrichment over these frozen nononset samples. Descriptive comparison only: selection of controls and clustering do not support formal independence.

## Market-relative controls and cost context

Directional median of instrument minus equal-weight BTC/ETH raw minute CLOSE return:
- Across all 21: +0.68bp at 5min; +0.98bp at15min; **+20.03bp at 60min**.
- NEAR 10: median +65.26bp at60min; SOL 11: median -4.12bp at60min. This large instrument contrast and many censored outcomes defeat any crossasset-robustness claim.
- Source original **entry-time L2** quoted bid/ask: median spread across all onset quotes ~**1.01bp** (NEAR ~3.89bp, SOL ~1.00bp). Historical T quote alone does not prove future executable exit quote.
- Fee hypothetical scenario **5bp each side ->10bp round trip**; stress **10bp each side ->20bp round trip** before spread, slippage and latency. These are explicit generic scenarios, NOT user's actual account fees or net return estimates. Unknown future quote, fill and latency make realistic full round-trip PnL **COST_UNAVAILABLE**.
- Different intrinsic price step/tick size and volatile regime can yield different rates of crossing an *absolute* 1% minute-close boundary; it is not proof of superior NEAR algorithm.

## Historic news / falsifiability guard

Source-linked evidence in companion [v30 news context](ALGORITHM-NEWS-CONTEXT-v30-20261031.md):
- Sep10 12:30 UTC original [BLS PPI](https://www.bls.gov/news.release/archives/ppi_09102026.htm): exactly two hours before **SOL Sep10 14:30 UTC** aligned onset; CENSORED_60; temporal cooccurrence, no proof of price cause.
- Sep16 18:00 UTC original [FOMC decision](https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm): possible older Sept17 regime context, but not inside frozen preceding 120min window for 02..09UTC signals.
- Sep17 14:00 UTC [NEAR supplied press release](https://www.prnewswire.com/news-releases/nearcoms-confidential-tvl-reaches-70-million-triggering-the-near3-33-snapshot-amid-industry-wide-privacy-wave-302881903.html) occurred after all 10 Sept17 selected onsets, **not** a presignal event.
- Sep17 12:30 UTC macro event [calendar](https://www.newyorkfed.org/research/calendars/i-sep26.html) occurred after selected morning onsets. Sep10 Solana [official engineering update](https://solana.com/news/solana-changelog-september-10-2026) lacks independently confirmed intraday first-publication UTC and cannot be marked presignal known-at.
- Full authoritative news, sentiment, smart-money, true open interest, forced liquidations, funding orderflow and independent surprise feeds **NOT available with certified event-time and historical network-available timestamps**. All 21 must be marked **NEWS_COVERAGE_UNKNOWN**, including no timestamp-matched original release. No supposed manipulator, spoofing, liquidation or first mover identified.

## Independent implementation and tests

- Frozen public repo protocol was committed **before source acquisition and preliminary price outcomes**, and separate new windows/asset names fixed ahead.
- Important bias limitation: the detector and early candle/trade paths were run before the finalized snapshot-indexed L2 replay program was authored. The sign/direction/5-level alignment formula and L2 age threshold were **already committed before any source downloads**, and actual signal membership remained fixed, but the entire execution pipeline was **not prospectively frozen as executable code**. Thus describe as **preregistered hypothesis with partially subsequently implemented pipeline**, NOT a fully blind production-grade confirmatory trial.
- New bounded acquisition source parser treats official receipt mismatch, unexpected ZIP member, broken trade IDs/day labels, invalid L2 quotes or stale quotes as errors; no imputation.
- **13/13 focused tests passed** on isolated Windows worktree: 6 new v30 and 7 prior v29 tests, using python -m unittest -v test_algorithm_v30_research test_algorithm_onset_v29. Prior v29 overall 316 tests refer to prior milestone; NOT misrepresented as newly rerun.
- Original v30 result files and SHA-256 receipts are preserved, separate from GitHub code and report. source original content is not digitally signed by OKX; HTTP origin and hashes establish preserved downloads, not formal venue provenance attestation.

## What to do after this result

**Do not promote the v29 imbalance-alignment trigger, and do not retune it against these observed 21 signals.** Mark it negative and close this v30 validation step.

For a genuinely new v31 **development-only** hypothesis, consider **event-time impact efficiency and quote replenishment** (not a renamed 1-minute technical indicator): infer the incremental price response per executed signed-contract volume on microsecond/subsecond original streams, separately measure how quickly consumed top-of-book volume is replenished, and compare to frozen matched no-onset controls. Condition on asset-normalized volatility, tick size, spread and market synchronization as covariates; potential falsification: if no stable effect on future *quoted* first passage under causal as-of reconstruction and costs, abandon. Before new outcome data: freeze fresh instrument/day sources, source latency, matched controls, thresholds, outcomes, news and econometric guard. This is a proposal, NOT a discovered or tested profitable strategy.

Keep Sep05 and Nov01–12 original out-of-sample windows untouched, no Trader/PAPER/live changes. Research mode only.
