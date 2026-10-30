# Algorithm Discovery v9 — PREREGISTERED next-second quote readdition experiment

**Registered 2026-10-30 before collecting any v9 orderbook/trade source message.** The v8 BTC and SOL eight-second source pilots were inspected. This is an exploratory preregistered OUTCOME lock on fresh captures, **not independent strategy-family discovery**. No crypto orders, PAPER, active Trader, main branch, API keys, paid data, scheduler or background monitoring.

## Input and cohort locked up front

Use unchanged public, no-login OKX WS capture/replay from `algorithm_ws_capture_v8.py`, `algorithm_ws_audit_v8.py`, `algorithm_ws_buckets_v8.py`. Each source capture lasts **exactly 8 seconds** after confirmed subscriptions and full book snapshot. Capture exactly six **new** manual, bounded datasets in this order: BTC-USDT-SWAP run01, SOL-USDT-SWAP run01, BTC run02, SOL run02, BTC run03, SOL run03. Store each unique raw folder; never overwrite evidence or substitute the prior v8 training/pilot examples. Keep even zero-event, failed, disconnected, or negative captures in an attempt register; if corrupt, mark and exclude based on existing source-quality rules **without retrying for more favorable samples**. The UTC periods will be sequential rather than synchronized. No meaningful financial replication inference from six captures on one day.

## Primary hypothesis and exact feature arithmetic

Use the existing audited eight **one-second, receipt-binned** source rows `t=0..7`. Available information at the END of second `t` is only that bin's book-and-trade messages; never use any message in second `t+1` to decide eligibility/direction.

For each of **t=0..6**:
1. Require bin[t] `status=OBSERVED_BOTH`, bin[t+1] `status=OBSERVED_BOTH`; bid/ask on both bins; `fill_count>=1`; book-updates>=1. Missing prices are **abstain**, not zero returns.
2. Let `F_t = (buy_taker_contracts-sell_taker_contracts)/(buy+sell)`, taken only within one symbol and current 1-sec bin. If `F_t=0` abstain.
3. Define `bid_readd_t` and `ask_readd_t` as the **counts of increased displayed price-level quantity where that same price level was previously reduced in this 8-second record**, with no attribution to an execution or identified market maker. This counter can revisit the same price level repeatedly and includes reductions before the t-second, not evidence of person-level absorption.
4. A **passive-opposition** event exists if the sign of aggression `F_t` points to MORE readdition on its opposing passive side: `F_t>0 and ask_readd_t>bid_readd_t`, or `F_t<0 and bid_readd_t>ask_readd_t`. Strict comparison; ties abstain from primary. No sample-specific threshold, liquidity normalization, variable horizon or minimum fill-size optimization.
5. **Frozen primary predictor:** for each qualified event, forecast the **opposite** of the aggressive taker side over next 1-sec bin. If current taker buy majority, predicted move is DOWN; if taker sell majority, predicted move is UP.
6. Let `M_t=(best_bid_t+best_ask_t)/2`, from LAST book update received in bin `t`, and `M_{t+1}` similarly in next second. Primary outcome (not an executable PnL) is `-sign(F_t)*10000*(M_{t+1}/M_t-1)` in basis points. **H1:** its across-all-qualified-events average is POSITIVE. Do not condition on realized direction, spread, volatility, price returns, largest or smallest fill count, time of day, or market. Include zero price changes as zero.
7. **Predeclared alternative and null:** always also report the sign-of-taker continuation forecast `+sign(F_t)` on exactly the same qualifying rows (therefore its signed bps is the negative of H1), and the **0 midprice-change** null with its mean absolute error in bps. Report all eligible bins and 1-sec outcomes, number positive/negative/zero, and per instrument/run plus raw H1 signed-bps total; do NOT pick winners ex post.
8. For context and to avoid confusion with profitable execution: report a fixed 14-bps round-trip **illustrative transaction-drag** stress (7bps each side), subtracted from the 1-sec signed-bps score, with clear warning it is NOT a tradable fill/backtest; actual spread, queue, funding, tick size and margin are not accounted for. Fee assumptions and times cannot be optimized after seeing data.

## Timing and source integrity

Every WS event must have full local UTC receipt and per-source ordinal/hash; any `books` `prevSeqId` gap, malformed bid/ask, crossed book, duplicate trade IDs, impossible time, corrupted source hash, or missing full book snapshot must result in a **REJECTED CAPTURE** for prospective scoring. Already existing offline auditor provides this gate. Trade channel has no certified missing-message detection; cannot claim complete all-fill capture, only records received. Two channels have no exchange-certified total ordering: receipt bin correlation is descriptive rather than causal execution matching. All six source datasets are collected **only AFTER this protocol Git commit**.

A capture is limited to 12,000 logical WS messages, 12MB unencoded WS payloads, 8sec window, per-message source hashes. No account/auth/order routes. No automatic restarts or scheduler. `source_digest, capture_start, capture_end` must be retained for each run. Freeze full evaluation code and synthetic regression tests **before the first of six recordings**.

## Reporting and decision

- This is **single-day tiny feasibility/falsification**, not statistically independent validation. Treat 42 potential next-second observations as correlated within runs, with same market shocks. Do not claim p-values, Sharpe, reliable prediction, algorithmic ETH complexity breakthrough, daily % returns, or safe leverage.
- H1 is supported **descriptively** only if the strictly fixed evaluated subset has `mean_signed_mid_move_bps>0`, but **not** statistically or economically validated.
- If mean <=0, call NEGATIVE; if there are 0 qualified events or source corruption, call INSUFFICIENT/UNSCORABLE, not success.
- Do not mine the six captures to change signs/horizon/thresholds or extract a favorite coin; analyze competing causal representations in a *new protocol* and new future data if needed.
- Before any real trading relevance: independent sessions over many UTC days, verified trade gap controls, bid/ask execution, contract multipliers, funding and fees, control for market beta and data leakage, dependence-aware statistical uncertainty and multiple hypothesis search.

**Core hypothesis frozen:** `taker pressure opposed by same-price opposite-side book readdition -> opposite next-second midprice change`. For each qualifying source-second, the fully stated outcome is next-second **midquote** drift, NOT a round-trip execution price or position PnL.
