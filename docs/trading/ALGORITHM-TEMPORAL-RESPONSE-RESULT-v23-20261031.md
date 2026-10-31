# Algorithm Discovery v23 — actual eight-horizon temporal response on real OKX L2: negative after costs

**Research executed 2026-10-31 through connected Rakazo Windows + GitHub, exclusively manual and offline.** This report preserves an unsuccessful exploratory day rather than selecting a superficially favorable outcome. The two features and ALL eight horizons were fixed in `docs/trading/ALGORITHM-TEMPORAL-RESPONSE-PROTOCOL-v23-20261031.md`, committed **BEFORE** new v23 source replay (Git commit `3a03337e8bd5971fc4ae7dbbca0d23868d970023`). No live quotes, trading account, actual/paper orders, main branch, automation or paid services used.

## The core question

The user correctly challenged the arbitrarily chosen **five-minute** prediction horizon. We changed the research object to the **time-response profile** of hypotheses: for any pre-defined market condition, how does subsequent quote movement and a pessimism-aware crossed-spread + hypothetical taker-fee proxy vary across multiple horizons?

The eight pre-registered horizons are **10s, 30s, 1m, 2m, 5m, 15m, 30m, 60m**. We do not treat any one as privileged or announce the observed best as a validated future trading horizon.

Two source-only liquidity hypotheses based on ARCHIVED TOP OF BOOK, not historical executed orderflow:
1. `baseline_imbalance`, known simple control: direction sign of displayed top bid/ask size imbalance `I=(bid_qty-ask_qty)/(bid_qty+ask_qty)` if `|I|>=0.30`, else ABSTAIN.
2. `pressure_shock_without_mid_adaptation`, an exploratory condition, **not claimed unique or proven novel**: difference `dI=I_t-I_tminus30s`, direction `sign(dI)` if `|dI|>=0.50` AND `|10000*(mid_t/mid_tminus30s-1)|<=3` bps, otherwise ABSTAIN. This is NOT the original v14/v15 taker-flow hypotheses, since historical L2 archive contains no executed taker stream.

## Fixed source, sample and independence

Reused previously downloaded REAL OKX NEAR-USDT-SWAP 400lvl L2 book archive for **2026-09-02 UTC**; source original tar.gz SHA-256:
`33ee27aa5d740255ef01f76f3a7183606e2f5bff6898931605857906b55bf337`.
Uncompressed one-member snapshot/update NDJSON SHA:
`e15dc177dc4a4e6ee6df2813d79c62e2b34a161fea9d9d4641df8e54fa7bb06b`.
Original trusted-HTTPS provenance is from v22; not separately venue-digitally-signed. The original book events have **NO seqId or prevSeqId**, so the absence of missing book deltas cannot independently be proved.

Exactly **58 anchors** chosen entirely by timestamp, every 15m within UTC **02:00–09:00 inclusive** (29) and **14:00–21:00 inclusive** (29). Times 10:00–14:00 (including earlier manually inspected 12:00→12:05) were EXCLUDED before replay. Still these are 58 highly temporally dependent anchors in just ONE market DAY; overlapping 15m anchor spacing vs 30m/60m outcome makes dependence even stronger. Not an independent holdout, not independent days. Eight horizons from each anchor are nested and DO NOT multiply independent sample size by eight.

Every source anchor also requires an archived t−30sec quote for shock feature, t quote for source signal, and future as-of quote at each fixed horizon; each timestamp can be used only with last complete snapshot/update **at or BEFORE** the timestamp. First later event is only a coverage bracket, never its new book level. Max allowed historical quote age5s, next-event bracket5s, no candle substitution, no lookahead into a source feature. **414 unique target timestamps all satisfied both coverage gates**; 1,579,978 original L2 book events were replayed through the last target (~22:00 UTC), including original snapshot resets and all intervening deltas. The replay was split into **16 immutable SHA-chained checkpoints** and run only by discrete short manual calls on the user's 8GB Windows machine.

Source/analysis files unchanged and retained locally under:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/official-l2-v22/NEAR-2026-09-02/`

Final raw result:
`NEAR-2026-09-02-temporal-response-v23.json`
SHA-256: **`7d4980c81695d53cb15238b0a7a949625c5570b57338a7579c205cfe7dc5d06b`**.
It records all 58 anchors and 928 candidate×horizon rows, including 16 aggregate summaries and source quote availability. Source file and this raw analytical output are NOT added to GitHub.

## Signal frequency

Out of the same **58 timestamp-selected anchors**:
- Baseline imbalance **36 eligible**, **22 abstentions**.
- Pressure shock without mid adaptation **16 eligible**, **42 abstentions**.
- For every eligible anchor, all eight fixed future quote targets were actually reconstructable; **0 missing outcomes**. An eligible anchor still represents ONE source event for all eight nested horizons, not eight trials.

## Results — mean hypothetical quote-crossing NET basis points (bps), assumed fee 5 bps EACH SIDE

| Horizon | Baseline imbalance (36 signals) | Pressure shock (16 signals) |
|---|---:|---:|
| 10 seconds | **−12.98** | **−14.71** |
| 30 seconds | **−13.72** | **−14.38** |
| 1 minute | **−13.58** | **−10.34** |
| 2 minutes | **−10.46** | **−7.33** |
| 5 minutes | **−9.70** | **−11.72** |
| 15 minutes | **−5.66** | **−2.53** |
| 30 minutes | **−10.10** | **−4.73** |
| 60 minutes | **−20.99** | **−7.44** |

ALL sixteen candidate/horizon average quote-crossing **net** proxies are NEGATIVE at the predeclared 5bps/side scenario. The higher stress 7bps/side is also negative on every horizon, and worsens each scenario by about four bps for a round trip. Numbers do not include slippage/funding, and a best bid/ask price does not guarantee fill. Actual realized PnL remains `null`.

The fact that 15 minutes has the **least negative** mean for both patterns in this ONE development day is ONLY an observed descriptive ordering. It cannot be used to promote 15-minute holding to an independently validated favorable horizon without a new frozen hypothesis and different unseen market days. Five minutes was indeed an arbitrary point and showed no edge.

### Why naive directional accuracy is misleading

For baseline on 15m, mean directional signed midquote change was **+9.72 bps**. But average crossed bid/ask quote gross proxy was only **+4.34 bps**, and after fee5 per side the average proxy became **−5.66 bps**.

For pressure shock on 15m, mean signed midquote response was **+12.85 bps**, gross crossed proxy **+7.47 bps**, but net after same 5bps fee each side **−2.53 bps**. This example proves that an apparently positive direction forecast or average midquote drift does not by itself imply economic tradability.

Different realized quote crossing, spread/size, funding, slippage, taker/maker fees and execution are not independently established for the user's account. This is an illustrative, conservative economic-proxy comparison only.

## Source validation, synthetic tests and integrity

Implemented `scripts/trading/algorithm_temporal_response_v23.py`, with original source SHA binding via v22 receipt and decompress spool, strict original book delta replay and as-of quote brackets, feature-signal evaluation, full candidate/horizon/abstention matrices, and immutable SHA-chain checkpoints. Unit tests `scripts/trading/test_algorithm_temporal_response_v23.py` **8/8 PASSED** including immutable 58 anchors/eight horizons, no future quote used for earlier feature, stale quote rejection, immutability, two source-only hypothesis gate definitions and exact quote-crossing cost accounting.

Broader disjoint regressions after REAL analysis: **245** `test_algorithm*.py` PASS + **26** `test_[!a]*.py` PASS = **271/271 executed tests PASSED**. The separate `test_alpha*.py` group previously blocked by safety was not retried and is NOT claimed.

Original v12 November 1–12 frozen calendar SHA remains `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`, no v23 sources or outcomes assigned to its development/validation/holdout. Active Trader, PAPER/live, order APIs, account credentials, paid services, schedules and main branch unchanged.

## What a rigorous next iteration should be, NOT retroactively claimed today

- Freeze the outcome of this day as **negative development evidence**, rather than selecting/optimizing the least-negative 15m or relabelling data.
- Expand to several genuinely *unseen*, separately downloaded and recorded official L2 market days and preferably more instruments, with non-overlapping market-day splits (and realistic costs). Preserve exact v23 hypothesis/threshold/horizon definitions if attempting independent replication, or explicitly register NEW hypotheses before their independent tests.
- For NEW AI-generated hypotheses, register mechanism+formula, market data scope, horizons and falsification/abstention criteria BEFORE observing its holdout. Avoid reflexive return to the same known imbalance indicator or RSI/MACD. Possible causal **event-time** exits or volatility-conditioned horizon rules need separate source and true decision-time specification, not post hoc best-future quote selection.
- Due to missing true trade/fill, absent cryptographic venue attestation, unknown orderbook seq gaps, and one-day temporal dependence, do not claim discovered original or profitable trading algorithms. No autonomous background work promised. Finite manual Rakazo runs only.

**Verdict: v23 successfully maps time-response on genuine L2 and rejects profitable average quote-crossing after assumed costs for BOTH current book-pressure candidates in ONE historical development day. No optimal profitable fixed holding period is established.**
