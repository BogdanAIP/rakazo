# Algorithm Discovery v28 — 66 predeclared clock-only anchors: strong price moves vs ordinary market context

**Executed manually in Rakazo on 2026-10-31 UTC. Research-only exploration, NOT a new statistically independent validation or a profitable strategy.** User challenged the narrative developed from two exciting NEAR price jumps. We therefore evaluated **EVERY** preregistered timer-selected anchor, including nonmoving, falling and rising periods, with authentic previously stored original OKX L2, tick trades, BTC/ETH minute candles, NEAR hourly open interest and a dated but nonexhaustive news registry.

Original v28 prereg before the v28 full source-join calculation: `docs/trading/ALGORITHM-MATCHED-CONTROLS-PROTOCOL-v28-20261031.md`, commit `6ab75f333ba0560bfc3807083811dfa39d0e9653`. The source archive days themselves had been partially inspected in v23–v27, so this was NEVER a fresh holdout. No new market data downloaded or accessed; UTC Sep05 and original Nov v12 research holdouts were explicitly left unchanged.

## Exactly 66 source-timestamp-selected anchors (not cherry-picked winners)

Each day 2026-09-03 and 2026-09-04:
- UTC 02:00, 02:15, ... 09:00 inclusive = **29 anchors/day**.
- UTC 14:00, 14:15, 14:30, 14:45 = **4 anchors/day**.
- Together **33/day × 2 days = 66**. No selection based on later prices/news. Sep04 19:15 previously inspected large winner is deliberately OUT OF SCOPE because corresponding official UTC+8 Sep05 1m/taker archive would overlap the reserved original Sep05 UTC holdout. Both original Sep03 14:45 extreme win and Sep03 08:45 / Sep04 07:30 loss examples are INCLUDED.

For every one of 66 exact t, the immutable output contains:
1. Original NEAR 400-level L2 as-of best bid/ask prices/sizes t−30sec and t, original fixed v23 `delta_top_imbalance` condition and source quote quality.
2. **Genuine executed public OKX taker trades**, grouped in [t−300s,t−30s) and [t−30s,t) with original trade IDs, sides and contract quantities, signed volume/buy share and trade intensity ratio. Source timestamps and UTC+8 date labels verified; **no post-signal trade records used as presignal features**. Zero-trade window's share is NULL, never 50% or "no demand".
3. Authentic original OKX historical 1m confirmed CLOSE for NEAR, BTC, ETH at exact last COMPLETED minute ending at t and targets +5,+15,+60min; original six official ZIPs were already SHA-anchored in v27, 1440 consecutive 1-minute rows each. Market control equals simple `(BTC+ETH)/2`; excess = NEAR return minus control. No claim of a calibrated market beta or tradable bid/ask fill.
4. NEAR historical 1h open-interest snapshot **two hour marks STRICTLY before signal hour**, percent historical change; its actual release/publication at those hour marks was never independently proven, so this is a BACKGROUND descriptor, **NOT certified point-in-time ex-ante data for trading**. All four previously verified actual source HTTP response rows reconciled on overlapping timestamps.
5. TEN previously curated v26 news items with initial publication UTC/reliability; classify already published AND occurred vs announced FUTURE scheduled, never future hourly liquidation report. It is a **posthoc curated incomplete news list**, so zero catalogued items is NOT "no market news."

Fixed descriptive outcome labels:
- 60m NEAR original minute close gain >=+100bps = `EXTREME_UP`; drop <=−100bps = `EXTREME_DOWN`; otherwise `NONEXTREME`.
- Independently, 60m NEAR minus equal-weight BTC+ETH >=+100bps = `NEAR_RELATIVE_UP`; <=−100bps = `NEAR_RELATIVE_DOWN`.
These outcome bins and 5/15/60m horizons were frozen before v28 calculation, not optimized against v28 results. The 15-minute anchor step creates **overlap** with hourly outcomes and does not provide 66 independent observations. No inferential p-values or optimized entry/exit threshold.

## Actual results — 66 complete authentic multi-source comparisons

| 60-minute absolute NEAR return class | Anchors | Market days | v23 pressure-shock eligible | Eligible LONG | Eligible SHORT |
|---|---:|---:|---:|---:|---:|
| **EXTREME_UP** (NEAR >=+1%) | **17** | Sep03,Sep04 | **3** | **1** | **2 wrong-direction shorts** |
| **EXTREME_DOWN** (NEAR <=−1%) | **8** | Sep03,Sep04 | **2** | 0 | **2 shorts** |
| **NONEXTREME** (|NEAR|<1%) | **41** | Sep03,Sep04 | **9** | 4 | 5 |
| **Total** | **66** | ONLY 2 adjacent days | **14** | **5** | **9** |

Among the **17** extreme-up outcomes only **ONE** had the original source-only signal predicting LONG. Two other pressure-shock eligible examples predicted SHORT in the face of future >=+1% returns. The old book-only signal misses many strong future returns and may give exactly opposite direction; it cannot be celebrated as a general signal just because Sep03 14:45 happened to win.

By day: Sep03 33 anchors = 8 extreme up,2 extreme down,23 nonextreme; Sep04 33 anchors = 9 extreme up,6 extreme down,18 nonextreme. **No cases removed** based on pretrade news, liquidity quality or outcome.

Directionless 60m broad-market reference: of17 absolute NEAR extreme ups, **12** also gained >=+1% *relative* to equal-weight BTC/ETH, while **5** were not 1% above broad market. The 66 all-case relative return classes comprised 12 large NEAR-relative rises, 4 large NEAR-relative declines and 50 moderate relative movements. A simple price rally therefore cannot establish a uniquely NEAR-specific causal mechanism.

## Source-presignal feature distributions (descriptive, not predictive inference)

| Original presignal evidence | EXTREME_UP (17 anchors) | NONEXTREME (41 anchors) | EXTREME_DOWN (8 anchors) |
|---|---:|---:|---:|
| **Median previous-30s genuine taker BUY share of contracts**, nonempty intervals only | **47.98%** (n=16) | **55.51%** (n=39) | **12.46%** (n=5) |
| Median |Δ top-of-book bid/ask size imbalance| | 0.687 | 0.655 | 0.440 |
| Median ratio of 30s vs preceding270s trade intensity | 0.301 | 0.512 | 0.372 |
| Median ORIGINAL historical 1h OI change based on earlier UTC hourly points; **publication at signal NOT verified** | −0.311% | −0.065% | −0.258% |
| Number of anchors with >=1 item from the already **curated 10-item news registry** in previous2h | **6/17** | **4/41** | **5/8** |

This refutes the tempting simplistic posthoc narrative that "large visible bid adds + a large aggressive buyer fraction = future major upside." The best old poster child Sep03 14:45 did have 91.4% aggressive buyer-taker share in preceding30s, but the median across OTHER price-up observation anchors was not unusually high. Some strong future upside even followed near-zero/zero recent executed buys. A random fixed timer may precede a move by tens of minutes, so little immediate 30second pressure is expected. This itself motivates studying **onset/change points** rather than blindly predicting +60minute return from arbitrary time anchors.

The group news-count imbalance above is not evidence that any specific article caused a future move: (a) v26's ten news items were intentionally curated AFTER the original win analysis, (b) many 15-minute overlapping anchors share the SAME ONE publication, (c) "no matching article" is not "no news", and (d) risk-on or macro news can move BTC/ETH and NEAR together. Formal news-causality claims cannot be made.

## Why the apparent large sample was misleading: episode overlap sensitivity

AFTER the original frozen v28 full cohort analysis, we ran a separately labelled, reproducible 60-minute window **overlap audit** against its exact SHA (not a new model). For each same-direction extreme class, merge hour outcome intervals [t,t+60min) if they overlap, independently within UTC day. This yielded:

- The **17 EXTREME_UP anchor rows** collapse into only **5 overlapping same-class hour-window groups**: Sep03 02:00–03:30 (3 anchors), Sep03 05:30–06:30 (1), Sep03 14:00–15:45 (4), Sep04 06:00–07:45 (4), Sep04 08:00–10:00 (5).
- The **8 EXTREME_DOWN rows** collapse into only **4 overlapping same-class groups**: Sep03 03:15–04:45 (2 anchors), Sep04 04:30–06:00 (3), Sep04 07:15–08:15 (1), Sep04 14:00–15:15 (2).
- Even those five/four groups are NOT statistically independent across direction or time: a rising and falling hour-window group can overlap. There are still just **TWO market days**.

Original full 66-anchors JSON:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/controls-v28/NEAR-2026-09-03_04-66anchors-controls-v28.json`
SHA256 **`979c5fe4ba4a2925570349368fd8cfd415e94663c41ae9178dd5d56ed487cbb2`**.

Post-result episode SHA-bound audit:
`NEAR-2026-09-03_04-overlap-episodes-v28.json` SHA256 **`e5442cc1c543c02cd3e9329ffbf66609789a0fe2d8ce4f77ba46fc0f52907404`**.

## Fee illustration, additionally cross-referenced to **original frozen** v24 quotes

There were **14** original v23 `pressure_shock_without_mid_adaptation` eligible source anchors in this v28 66-timer cohort. Crossmatched each exact t and direction back to v24's fully immutable original 3600-second future L2 crossed bid/ask scenario (assumed fee5bps PER SIDE; actual fills, funding and real account fees are NOT verified).

- **8/14** cases returned positive hypothetical fee-adjusted quote crossing.
- Mean over all 14 (including BOTH extreme losses and wins) **+7.14bps**, median +10.71bps.
- **Separate, post-result fragility diagnostic**: removing just ONE best observed hypothetical win changes average to **−12.21bps**; removing the top TWO turns average **−32.24bps**. This does NOT replace the original primary sample or authorize dropping winners. It shows extreme sensitivity of any mean result from 14 overlapping, outcome-aware cases from just two market days.
- Consequently **neither positive sample mean nor apparent win rate validates a tradable rule**; exact v24 source inputs, immutable SHA and fee scenarios are preserved.

Original fee sensitivity output:
`NEAR-2026-09-03_04-66anchors-quote-fee-audit-v28.json` SHA256 **`e8b39c1379d211d0b41fa137510285ddb7b210a054c77efb57471bd03adc4e7e`**.
Again original archive original L2 includes no individual order IDs to establish spoof/cancel intent. No original 2026 historical complete minute NEAR OKX liquidation tape was independently authenticated; OI alone cannot identify liquidations.

## Reproducibility, tests and safety

- `scripts/trading/algorithm_controls_v28.py`: exact 66 timestamp-only cohort, source-original strict SHA audits, authentic two UTC+8 ZIP tick-trade sources, previously source-verified six UTC+8 minute candle ZIPs, 4 original OI REST responses checked for internal agreement, original v26 known-at news registry, strict no future values into presignal features, full 66 source/feature/outcome rows with fixed original 60m bins.
- `scripts/trading/test_algorithm_controls_v28.py`: **6** focused synthetic/source tests pass covering 66 anchors, non-lookahead trade windows, minute closes and scheduled news, conservative lagged OI and outcome bins.
- `scripts/trading/algorithm_controls_episode_audit_v28.py`: verified the locked v28 original output SHA before grouping overlapping 60m extreme windows, no claim of independent samples.
- `scripts/trading/algorithm_controls_cost_audit_v28.py`: verified locked v28 + v24 original SHAs before computing original 14 real-source fee-proxy outcomes; post hoc removal sensitivity explicitly labelled not a strategy.
- Broad disjoint already EXECUTED regressions **277/277** `test_algorithm*.py` and **26/26** `test_[!a]*.py`, total **303/303 executed tests PASSED**. The separately blocked `test_alpha*.py` group not run; do not imply all tests.

User’s immutable original Nov1–12 v12 calendar SHA256 still `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf` (reconfirm before completion). No real order, PAPER, private API, scheduled automation, paid provider, secrets, main branch or original Sep05 market source touched.

## Scientific next step: how to actually search for explanatory mechanisms and original algos

**v28 negative result matters:** one emblematic 91% buyer-taker share plus 22-fold visible bid level did NOT generalize to the rest of sixty-six timer anchors. The hypothesis needs mechanism refinement, not simply a shift from 5-minute to 60-minute holding or post-hoc removal of failures.

A defensible v29 research plan should be a NEW **ONSET-BASED**, explicitly source-time-limited event study:
1. Identify genuine changes of risk/liquidity regimes from PAST ONLY (e.g., as-of trade intensity jump or impact absorption), not a future 60m return. First mark event time where the predeclared online detector fires; suppress duplicate triggers with fixed cooldown to avoid counting the same price impulse again.
2. At each first valid trigger measure **future first passage/trajectory and competing stop events**, not an arbitrarily privileged 60min return. Record actual quote-crossing plus fees/funding/slippage bounds and all abstentions.
3. Distinguish BTC/ETH simultaneous broad impulse from NEAR relative residual, and independently timestamped news events and NEAR derivative OI/liquidation records known AT signal time. Source original orderbook/taker arrivals may have clock offset and missing seq proof (v20 and v22), so a true live usable strategy must account for receipt timestamps and information delay. Do not use v28's seen labels as a holdout.
4. Collect **new independently preregistered several days and several assets** with untouched primary source access, not 17 overlapping windows from two adjacent dates. Include no-event negative controls. The reserved Sep05 original and v12 Nov plan MUST not be looked at until their separate frozen rules require it.
5. Do not accuse manipulative spoofing or short-squeeze without original order-ID lifecycle and authenticated venue-specific forced-liquidation evidence.

**Scientific verdict:** New 66-timepoint real-source evidence substantially weakens the old top-of-book-only idea. Preliminary actionable insight is METHODOLOGICAL: discover event onset and market-relative response under source-latency constraints rather than mechanically optimize a fixed holding-time or mistake overlapping observations for independent discoveries. No original validated profitable algorithm yet.
