# Algorithm Discovery v29 — real source-time onset, 934 minute decisions, full 400-level L2 corroboration and competing first passage

**UTC 2026-10-31. THIS RESEARCH WAS ACTUALLY EXECUTED MANUALLY IN CONNECTED RAKAZO; no background process, no live/PAPER order, no paid data source and no source substitution.** We addressed the user's objection that choosing fixed 5m/60m holding windows and praising two extraordinary crypto moves is finger-in-the-air. We replaced fixed 15-minute sampled signals with a **causally source-time limited onset detector**, applied to every one of 934 minute decision times on two previously inspected archived market days, then independently checked all emitted onsets against ORIGINAL 400-level book deltas. **No new alpha validated.**

## Prereg before real v29 source reinspection

Precommitted research protocol `docs/trading/ALGORITHM-ONSET-PROTOCOL-v29-20261031.md` commit **`a08418f73e276c102bbe99d8d34a80ee8b0b1552`** **BEFORE** the complete v29 scan/outcome calculations. These same Sept03/04 original data had been observed in earlier v23–v28 research; therefore the protocol was precommitted before **the new v29 study calculation**, NOT before all historical outcomes were first known. This v29 is **DEVELOPMENT/HYPOTHESIS GENERATION**, not an independently prospective holdout.

Only previously original-SHA-audited market sources:
- Original official OKX module1 real `NEAR-USDT-SWAP` taker trades, UTC+8 day labels Sept03/04, 110,736 and 189,559 original trades (from v25); true executed BUY/SELL initiation, not merely displayed orders.
- Original six official OKX module2 minute OHLC ZIPs UTC+8 day labels Sept03/04, 1440 consecutive confirmed 1-minute bars each for NEAR-USDT-SWAP, BTC-USDT-SWAP and ETH-USDT-SWAP (from v27).
- Original source-SHA-validated official OKX 400-level NEAR book original daily `.data` Sept03/04, audited v24 100k-event immutable SHA-checkpoint chain and original raw decompressed/gzip file SHA.
- Four original hourly NEAR OI responses, known **historical timestamp** but NOT proven available in realtime at that hour; and the curated v26 partial source-linked dated news register. Neither OI nor headlines were eligible as detector inputs and no "no news" conclusions were drawn from the incomplete curated corpus.
- No Sep05 UTC original market holdout data, no UTC+8 Sep05 trade/candle archive, no new download or live API request.

## Exact detector — source-only and NOT trained against outcomes

Two UTC days, exact source-time end-of-minute decisions:
- 02:00..09:00 UTC each minute inclusive (421/day).
- 14:00..14:45 UTC each minute inclusive (46/day).
- **467/day × 2 days = 934**, all original decisions included, including not eligible / baseline quiet / source absent.

At each decision T:
1. Genuine executed taker contracts over **`[T−360sec,T−60sec)`** (5-minute reference) and **`[T−60sec,T)`** (recent). Source excludes t itself and all future individual trades. Baseline 0 contracts => abstain.
2. Real recent trade print count ≥ **5**, recent contracts per-minute ≥ **3.0 × previous baseline per-minute**, and `abs((buyContracts−sellContracts)/totalRecentContracts)>=0.60`, equivalent to ≥80% contracts initiated by one side. All fixed before this scan. Direction is that taker-initiator sign, not book/candle hindsight. These are arbitrary pilot thresholds, no v29 fitting.
3. Price response = last complete NEAR minute candle CLOSE relative to previous completed minute, both known by T in historical exchange event-time conventions. If absolute move **≤5bps**, label **MUTED_PRICE_RESPONSE** (*possible* source-time absorption); otherwise **VISIBLE_PRICE_RESPONSE**. Because a NEAR minimum price tick near $2 is about 5bps, this muted criterion roughly selects near-unchanged minute CLOSE, not proof that the true intraminute price/queues never moved.
4. Global fixed **60-minute cooldown after the first signal**, independent of resulting price and outcome; qualifying duplicates suppressed but retained in full 934-decision output. This cooldown is source-time only; real network arrival/clock offsets remain uncalibrated.

Historical fixed outcome for each selected onset: at every completed 1-minute close from +1 to +60min, measure first attainment **+100bps in signaled direction** vs **−100bps adverse**; whichever crosses first; if neither hits, **CENSORED_60_MINUTES**. This hour is a **maximum censoring horizon, NOT an optimized holding period**. The source minute CLOSE is not an executable entry/exit bid/ask, ignores actual fill latency, spread, fees, market impact, funding and slippage. We also record BTC/ETH equal-weight control and NEAR-relative excess at +5,+15,+60min and first barrier; no optimized factor beta.

## Genuine original result (934 minute decisions)

| Actual decisions/cases | Count |
|---|---:|
| Full immutable minute decisions tested | **934** |
| Qualified original source-time candidate minutes before cooldown | **47** |
| Removed as within exact 60min prior signal (original outcomes NOT inspected to do so) | **32** |
| **Distinct first onset triggers** | **15** |
| MUTED minute-close price response onset | **1** |
| VISIBLE already-moving price response onset | **14** |

### Source first-passage outcomes

| Group | First achieved +1% in signal direction | First achieved −1% adverse | Neither within 60min |
|---|---:|---:|---:|
| **MUTED**, n=1 | **0** | **0** | **1** |
| **VISIBLE**, n=14 | **6** | **3** | **5** |
| **Total**, n=15 | **6** | **3** | **6** |

One genuinely muted original event **Sep04 02:32 UTC**, SHORT, real signed taker fraction −0.694, recent flow acceleration 3.38×, original minute-close change **0bps**. Follow-up official 400-level original L2 confirms **true midpoint at last-minute endpoints unchanged (0bps)**. Top5 displayed depth imbalance drift was +0.1165 (i.e., AGAINST the short taker flow), and neither ±1% directional barrier was reached within 60min. This is one authentic absorbed-looking observation but NO evidence that muted price response predicts breakout.

Original selected 15 onsets:
- Sept03 UTC: 02:02 (LONG, +1% favorable first @33min); 03:02 (LONG censored); 04:10 (SHORT favorable @26min); 05:22 (SHORT censored); 06:29 (LONG censored); 07:42 (LONG adverse @45min); 08:52 (SHORT adverse @27min); 14:18 (SHORT adverse @29min).
- Sept04 UTC: 02:32 (SHORT, the only MUTED, censored); 03:56 (LONG censored); 04:59 (SHORT favorable @41min); 06:26 (LONG favorable @11min); 07:46 (SHORT censored); 08:46 (LONG favorable @21min); 14:31 (SHORT favorable @17min).

Note the famous Sep03 14:45 previous winner **did not become a first selected onset** under these frozen criteria/cooldown, since an earlier onset at 14:18 (SHORT) triggered before it. THIS IS ACTUAL BAD CONTEXT AND IS NOT HIDDEN. Later post hoc shifting the thresholds to include that winner would invalidate this experiment.

Median signed NEAR-relative excess vs equal-weight BTC/ETH at +60min:
- 14 VISIBLE events **+15.84bps** (raw source, not economic outcome);
- one MUTED event **−13.24bps**; sample too small for inference.

Across two already observed market days, 15 source-onset first signals are **not statistically independent** despite cooldown. No statistical effect size, uncertainty, backtest PnL or trading readiness is claimed.

## Independently replayed authentic ORIGINAL 400-level book — 15/15 source times covered

Additional original L2 as-of audit `scripts/trading/algorithm_onset_l2_audit_v29.py` revalidated:
- each original .tar.gz archive SHA and decompressed original `.data` SHA with v24 source receipt;
- the entire immutable v24 SHA-chained checkpoint series BEFORE choosing the immediately PRE-event checkpoint;
- replayed ORIGINAL chronological snapshot/update events from checkpoint to each target `T−60sec` and T, requiring **next source event > target <=5s** and **prior source quote <=5s age**; future event provided **time bracket only**, NOT future price/size into feature.
- displayed best bid/ask, exact source as-of age, top-five price-level BID/ASK displayed aggregate depth, imbalance, true midquote and book imbalance change; quantities are NOT execution volume nor individual order IDs.

All **8/8 Sept03** and **7/7 Sept04** emitted onset events had **both strict source-as-of book quotes available** and no checkpoint/source integrity divergence. This confirms that the single muted minute close indeed coincided with zero original L2 best bid/ask midpoint drift across those two endpoint instants, although intraminute variation and displayed order replacement remain possible. The other 14 showed genuine original L2 midprice change of varied directions and magnitudes at their exact source-minute endpoints.

Archive provenance and immutable per-day results:
- source-original v29 onset 934 decision JSON:
  `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/onset-v29/NEAR-2026-09-03_04-934min-onset-v29.json`, SHA256 **`f9e867360169fc71c17fe94c3aa4649846f98584af6617db71da18c6fc853d86`**, 1,577,950 bytes, complete 934 decisions and all 15×60 actual minute-close future paths.
- original L2 Sept03 strict replay JSON `NEAR-2026-09-03-onset-strict-original-L2-v29.json`, SHA256 **`661c8168ea3f811be247f78e86a150ae32d07dbf399c7e0aa9a48d751119df67`**, 8 original events.
- original L2 Sept04 strict replay JSON `NEAR-2026-09-04-onset-strict-original-L2-v29.json`, SHA256 **`4e25e6bff759d99e5e49bc3a6a82fb8fcd2c681fb6cc3c2faebee0abbcc96044`**, 7 original events.

Two lengthy original cached-book replays returned temporary R desktop-tool "Internal server error" although the immutable raw audit outputs **actually completed and persisted**. We checked exact files by short independent read-only commands rather than recapturing or overwriting originals; both source SHA, 15 rows and strict asof success verified. NO failures or skipped original events disguised as successful records.

## A new candidate **ONLY discovered AFTER outcomes**: taker-direction reinforcement by top5 book liquidity

The most interesting post-result source phenomenon arose by comparing signed flow with original book-depth imbalance drift during the same PRE-signal minute. This was first inspected **AFTER** observing which of the 15 future +/-100bps outcomes had occurred; it is **NOT** part of the v29 registered detector and MUST NOT be relabeled preregistered:

`aligned = sign(original executed taker net volume in last60s) × (I_top5_at_T−I_top5_at_T−60s)`, where `I_top5=(sum_bid_qty_top5−sum_ask_qty_top5)/(sum_bid_qty_top5+sum_ask_qty_top5)`.

| Post-hoc directional top5 depth change | Favorable 1% barrier first | Adverse 1% first | Both censored |
|---|---:|---:|---:|
| **Same direction as genuine trade-flow** (`aligned>0`), n=8 | **5** | **1** | **2** |
| **Opposite/flat direction** (`aligned<=0`), n=7 | **1** | **2** | **4** |

This is an interesting *mechanistic question*: maybe price response changes when actual executed flow and displayed resting depth are being reallocated consistently, whereas divergence is noise or replenishment. **It is not proof of causality, a discovered profitable rule or statistical significance**: two already-observed days, 15 potential non-independent events, post-hoc dichotomy chosen after inspecting outcomes, no verified true realtime availability, no real costs. Any new "alignment" rule requires **BEFORE NEW ORIGINAL SOURCE** prereg, independent nonadjacent days/assets and nonevent controls without manipulating the threshold/horizon.

The exact SHA-bound original postresult audit:
`onset-v29/NEAR-2026-09-03_04-onset-L2-alignment-posthoc-v29.json`
SHA256 **`aad0c6928417136c84dfecd113709fd2f4518bb0e6d986e654cd45e15c392c64`**, computed by `scripts/trading/algorithm_onset_alignment_posthoc_v29.py`. This script rejects source mismatch against the **exact** original 934-rows onset SHA and both strict L2 per-day SHAs and retains all 15 examples (no replacing with more favorable selected subset).

## No verified market/news causal attribution

The previously curated v26 10-item news corpus was joined to each original onset as DATE-AND-TIME KNOWN-AT context only, not a complete newsfeed. Of 15 onsets only two had a known pre-event curated headline in the 120min lookback (one favorable, one adverse); this fact is **NOT evidence news absent** at other times or news irrelevant. Published external event exact minute timestamp and actual live availability would require a much more complete independently archived announcement stream.

Original NEAR hourly OI remains historic/descriptive with unknown public publication lag. Neither OI change nor source book changes prove forced liquidation, spoofing, order cancellation vs execution or trader identity. v20 clock offset also remains uncalibrated, so these market-exchange-time features cannot yet be promised to operate with equivalent information in realtime.

## Code and real tests, not invented

New research-only branch `research/algorithm-discovery-onset-v29-2026-10-31`:
- `scripts/trading/algorithm_onset_v29.py` — strict complete minute grid, authentic trading tape, source time-only conditions, 60-minute dedup, independent first passage.
- `scripts/trading/algorithm_onset_l2_audit_v29.py` — independent SHA-linked original book asof replay and strict top5 level diagnostics.
- `scripts/trading/algorithm_onset_alignment_posthoc_v29.py` — explicitly post-result source SHA-locked comparison; cannot change original detector.
- Tests `test_algorithm_onset_v29.py` (7), `test_algorithm_onset_l2_audit_v29.py` (4), `test_algorithm_onset_alignment_posthoc_v29.py` (2) all PASSED in dedicated runs.
- Broad disjoint regression batches executed: **290/290** `test_algorithm*.py` and **26/26** `test_[!a]*.py`, total **316/316 executed PASS**. Separate earlier safety-blocked `test_alpha*.py` not attempted, do not claim entire repository.
- One early synthetic-only test exposed a *wrong source completeness assumption* (quiet market tape mistakenly treated as missing a trade exactly at t), fixed and retested **BEFORE scanning actual source**, without changing any prereg thresholds or historical outcomes. Historical source data and previous v12/v24/v25 etc unaffected.

## Scientific decision and recommended v30

**DECISION: NO APPROVED TRADING ALGORITHM.** v29 succeeded technically and scientifically in replacing 934 arbitrary pricing snapshots with 15 first onset triggers, but the attempted "muted price response then breakout" mechanism produced only ONE case and NO directional barrier hit. Any claim that this idea works is unsupported.

The NEW post-result cue of same-direction taker-flow and original top-five depth change warrants a **new, truly independent preregistered** v30 falsification, not optimizing current 15 triggers. Register exact flow and depth alignment feature/threshold (`aligned>0` as observational branch if chosen), minimum source-quality, news release known-at clock, competing 1% barriers, fixed cooldown and transaction-cost proxy BEFORE accessing different nonadjacent original days and more assets. Include "no onset" negative controls and treat initial +1% barrier as nonexecutable unless original quote crossing/fees are tested. Do not treat Sept05 original reserved source or Nov1–12 independent source as ordinary development data unless separately authorized by its own frozen protocol.

Immutable Nov v12 plan SHA256 **`6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`** preserved. Trader/PAPER/live, main, schedules, credentials, paid services, real accounts unmodified. Manual R lease released after completion.
