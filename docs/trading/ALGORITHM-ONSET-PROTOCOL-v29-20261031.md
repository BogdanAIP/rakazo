# Algorithm Discovery v29 — source-time onset of executed orderflow, NOT fixed-interval price cherry-picking

**2026-10-31 UTC, frozen BEFORE ANY v29 candidate scanning or outcome calculation.** v24–v28 already examined portions of the **same two market days**, so this is openly **POST-HOC DEVELOPMENT / MECHANISM TEST**, NOT a fresh holdout, novel validated algorithm, or permission for trading. Main research question: *When genuine executed taker flow suddenly accelerates, is muted immediate price response (possible passive absorption) followed by different market-relative first-passage behavior than already-moving prices?* This is falsifiable. It does **not** assume spoofing, actual maker cancellation or causal news.

## Original source boundaries and original holdouts

Use *only* the six already validated official OKX one-minute historical ZIPs for NEAR-USDT-SWAP, BTC-USDT-SWAP, ETH-USDT-SWAP, UTC+8 archive day labels 2026-09-03 and 2026-09-04; and two originally saved official NEAR-USDT-SWAP real tick-trade ZIPs from the same UTC+8 archive days. Verify source SHA via existing `algorithm_module2_crossmarket_v27.archive_bars` and `algorithm_controls_v28.load_trades`. The archive day labels cover 2026-09-02 16:00 through 2026-09-04 15:59 UTC. NEVER download/open UTC+8 Sep05 ZIP (overlaps untouched 2026-09-05 UTC holdout), change frozen Nov1–12 v12 plan or launch Trader/PAPER/live. All source HTTP requests prohibited in v29; fully offline and manual.

For any source-level L2 diagnostics, only cached original 2026-09-03/04 400-level daily orderbook `.data`, SHA receipts, and immutable v24 prior source-replay checkpoints may be read. Historical archived exchange event time does not certify real-time delivery; source timestamps can have uncalibrated host/venue offsets and missing incremental L2 sequence IDs (v20–v22). No participant/order identity in public L2.

## Exact predetermined 1-minute DECISION GRID and detector (not outcome-selected)

Both UTC calendar days, all minute boundaries `T` in:
- 02:00, 02:01, ..., 09:00 UTC inclusive: **421** minute decisions/day.
- 14:00, 14:01, ..., 14:45 UTC inclusive: **46** decisions/day.
- Exactly **467/day x2=934 decision minutes**, no subset chosen by subsequent return. Time windows deliberately keep T+60min within already cached original UTC+8 files (until 15:59 UTC), including the Sep03 14:45 jump and many no-move controls, but excluding Sep04 19:15 whose original UTC+8 Sep05 trade/archive source is reserved.

**At each T only original trades timestamped strictly < T**, plus minute CLOSE from bar `[T−1min,T)` and older. Two disjoint authentic taker windows:
- prior baseline `[T−360sec,T−60sec)`: total `V5` contracts and number of executed trades, length 300s;
- recent `[T−60sec,T)`: total `V1` contracts, number, buy volume B and sell volume S, length 60s.
No future trade or future candle may appear in these features. Zero baseline V5 => detector ABSTAINS (no divide-by-zero extrapolation). Detector requires **at least 5 actual trades** in last minute, `V1/(V5/5) >= 3.0` (at least triple past-five-minute volume-per-minute baseline), and `abs((B−S)/V1) >= 0.60` (at least 80% directional taker share). Direction = sign(B−S). These are **arbitrary preregistered pilot thresholds**, not optimized using v29 outcomes.
- Last fully completed NEAR minute CLOSE at T relative to completed minute CLOSE at T−60sec. `drift_bps=10,000*(close(T−60)/close(T−120)−1)`.
- If `abs(drift_bps)<=5.0` classify `MUTED_PRICE_RESPONSE` (a *candidate for* absorption, NOT proof of absorption), else `VISIBLE_PRICE_RESPONSE` (strong taker pressure already accompanied by price change). Same universal detector, two classifications, no filtering out an inconvenient class.
- To avoid multiple readings of the same burst, **global 60-minute cooldown** applies after FIRST qualifying minute T, regardless of muted/visible type or direction. A qualifying minute inside cooldown is explicitly recorded as `SUPPRESSED_DUPLICATE`; all 934 minute decisions retained, including `NO_SIGNAL`, `BASELINE_ZERO`, and source-missing abstentions. Cooldown does not depend on future prices, loss or win.

## Fixed source-only historical outcomes, no chosen holding horizon

For each independent-from-cooldown detector trigger, compute from future *minute CLOSE* only, for EVERY h=1..60 completed minutes:
- direction-adjusted NEAR excursion `d*10,000*(NEAR_close(T+h)/NEAR_close(T)-1)`; T price is close from bar `[T−1min,T)`.
- FIRST POSITIVE BARRIER `>=+100bps`, or FIRST ADVERSE BARRIER `<=−100bps`, whichever occurs first by minute. If neither happens within 60min, `CENSORED_60MIN`. This is **NOT executable return/exit**: minute close and exchange timestamp do not equal market-order fills, crossed bid/ask, fees, funding or slippage. A 60-minute MAX OBSERVATION horizon is censoring, not an empirically chosen optimal trading holding period.
- At trigger T and each barrier time record BTC and ETH same-minute closes, equal-weight BTC/ETH drift `(BTC_pct+ETH_pct)/2`, and NEAR excess vs market. For all triggers record +5min, +15min, +60min market control returns too (fixed, descriptive).
- At each onset event, for **independent original orderbook L2 corroboration** where an authentic source quote can be recovered strictly as-of `T−60sec` and T with a following <=5sec bracket and preceding quote <=5sec age, measure ORIGINAL bid/ask midpoint change, displayed best-level quantity and imbalance. This does not change classification/eligibility; missing L2 as-of must be reported `UNAVAILABLE`, not imputed. Exactly timestamped L2 can be generated from already SHA-checked v24 book `.data` and immutable replay checkpoints, never a live API.
- Historical NEAR OI two hour marks before signal hour may be DESCRIPTIVE ONLY because their availability at actual signal is unverified. Curated v26 date-cited news can be shown known-before T but is not an exhaustive "no news" detector.

## Reporting and guardrails

Persist complete source SHA, exactly **934** minute decisions (including abstentions), all qualifying candidate minute stamps, suppressed count and source-only earliest onset triggers. Summarize by day and MUTED/VISIBLE group: how many triggers and independent 60m cooldown groups, how many positive-first/adverse-first/censored, time to threshold, median market-relative move, and nontrigger minute count. A zero-trigger group is an honest negative result. **No changing thresholds or horizon after seeing results**, no new asset/date or "best horizon" claim, no statistical significance from 2 adjacent known days, no retuning to find profit.

Do NOT assign spoofing/manipulation from L2 data. Do NOT claim verified liquidation or realized PnL from OI/market candles. Do NOT include post-trigger taker flow, OI or NEWS in a presignal feature. Historical global minute bars/archives with UTC timestamps are not verified realtime receipt-time trading inputs.

New isolated GitHub branch `research/algorithm-discovery-onset-v29-2026-10-31` and separate SHA-bound raw results under existing private `alpha-research/onset-v29/`. Run dedicated synthetic tests plus bounded broader disjoint tests, preserve original November plan and scheduled Trader. Explicit manual finite session; release R desktop control afterward.
