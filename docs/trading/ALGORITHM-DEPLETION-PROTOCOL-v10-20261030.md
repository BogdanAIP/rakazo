# Algorithm Discovery v10 — preregistered visible-depth depletion and marketable quote stress

**PREREGISTRATION 2026-10-30 UTC. Commit this file, all evaluator code and synthetic tests BEFORE the FIRST NEW v10 source capture.** This is scientific research only, not a tradable strategy or financial recommendation.

## Why this test is distinct

The prior v6 OI/funding direction (−0.1434% modeled initial equity in one hour), v7 single-snapshot opposition (−0.3481% modeled initial equity in one hour), and v9 quote-readdition reversal (−0.03957 signed next-second midpoint bps over 17 dependent observations) were **negative pilot hypotheses**. Do not change their signs or pretend v9's taker-only positive was independently validated.

v10 asks whether a **reduction of visible opposite-side depth**, sustained while aggressor flow points toward it, provides *short-term directional continuation* sufficient to overcome the spread and assumed fees. This is NOT identification of actual fills versus cancellations, whale identity, smart money, or a newly proven computational-complexity algorithm.

## New locked source cohort

Exactly eight fresh **8-second** explicitly user-triggered public-only OKX WS captures, in this order:
1. BTC-USDT-SWAP run01
2. SOL-USDT-SWAP run01
3. BTC run02
4. SOL run02
5. BTC run03
6. SOL run03
7. BTC run04
8. SOL run04.

No v8/v9 observation is eligible. All raw book snapshots/incremental deltas (`books`) must be SHA-verifiable, `prevSeqId→seqId` continuous and the two public channels available. Trades are from the individually reported `trades-all` taker feed; **missing trades cannot be ruled out with a sequence counter**, and there is no exchange-wide total order across the two connections. Capture starts only after ACKs+snapshot. Keep failed/incomplete attempts in the report, not count them as zero-return samples or replace them with favorable reruns. Only exactly one bounded 8-second run per named source folder, manually invoked with no schedule or automatic retries.

## Immutable source-second and outcome logic

Use existing `algorithm_ws_audit_v8.py` and `algorithm_ws_buckets_v8.py` *unaltered* to generate eight fixed 1-second bins. Let second index `t∈{1,2,3,4,5}`, such that bin `t-1` is the prior state and `t+2` will be the OUTCOME. Require each of bins `t-1,t,t+2` have `status=OBSERVED_BOTH` and nonzero best bid and ask. All data in bin t is available only at **the end of second t**. Do not select using `t+2` price movement.

`F_t = (taker_buy_contracts_t - taker_sell_contracts_t)/(taker_buy_contracts_t + taker_sell_contracts_t)`. Zero F abstains.

Let `Dask_t = (ask_reduced_contracts_t > ask_added_contracts_t) AND (top5_ask_contracts_t < top5_ask_contracts_{t-1})`; symmetrically `Dbid_t = (bid_reduced_contracts_t > bid_added_contracts_t) AND (top5_bid_contracts_t < top5_bid_contracts_{t-1})`. These are displayed **quote amount updates**, not causally matched fills. Note additions/reductions over the 400-level ordinary book can far exceed changes in its top 5. Both conditions are required exactly as written, with no tuned threshold.

**Primary selection and direction**:
- `F_t>0 AND Dask_t` => hypothetical **buy/long**;
- `F_t<0 AND Dbid_t` => hypothetical **sell/short**;
- all other seconds => **abstain from primary**.
No magnitude threshold or event cherry-picking. Each qualifying source-second contributes one equal observation to the primary descriptive mean; overlapping `t` outcomes within a run are **correlated** and must not be treated as independent experiments.

Price endpoint at t = LAST book quote observed in second t, and t+2 = LAST quote observed in second t+2. **Two-second horizon.** Indicative marketable entry/exit proxies, at the best quotes:
- LONG: entry `ask_t`, exit `bid_{t+2}`; gross bps `10000*(bid_{t+2}/ask_t - 1)`;
- SHORT: entry `bid_t`, exit `ask_{t+2}`; gross bps `10000*(1 - ask_{t+2}/bid_t)`.
- Fixed fee stress: **7 bps per executed side** (14 bps total of entry notional for each hypothetical trade), illustrative net `gross_bps-14`. This assumes perfect fills at those quotes and omits even more real slippage, contract depth, impact, network latency and funding. A **negative score is a strong rejection of economic feasibility in this optimistic scenario**; a positive score does NOT prove actual profitability.

Secondary *non-tradable* indicator: signed next-2sec midquote move, `direction*10000*(mid_{t+2}/mid_t -1)`. Do not substitute this for the primary executable-proxy result after seeing prices.

Predeclared controls:
- On the **identical qualifying source-seconds**, report a zero-position/cash baseline of 0bps (no cost) and the **opposite** direction's marketable bid/ask gross & net proxy, as a symmetry/negative-control (not a newly optimized reverse strategy).
- Report the `FLOW_ONLY` predictor (direction = `sign F_t`) on **all** quality-valid t including those without depletion, with the same marketable quotes+fees. Report that sample count, score and mean alongside the primary. Clearly state it is a larger, different subset; it is not an apples-to-apples causal estimate.
- Report a **price-only** prior-midquote momentum baseline direction = sign(`mid_t-mid_{t-1}`) on those quality-valid t with nonzero prior mid change, same t/t+2 marketable quotes and 7bps-side cost; again separate n and scope.

## Verdict and anti-overfitting

- If no eligible events: `INSUFFICIENT_PRIMARY_EVENTS`.
- If any of 8 predeclared captures is absent/corrupt/gapped: `INCOMPLETE_OR_REJECTED_SOURCE_COHORT`, report the number of source-valid windows and do not silently replace.
- Otherwise positive primary **mean 14bps-cost net quote crossing proxy** => `DESCRIPTIVELY_POSITIVE_NOT_VALIDATED`; zero or negative => `NEGATIVE_PILOT_NOT_VALIDATED`. No per-coin winner selection, threshold change, horizon change, excluding zero-move bins, sign reversal or optimized fees.
- Report per-run, per-symbol and total counts, all rejected/abstained opportunities and raw source SHA/UTC, no p-value, Sharpe, liquidity guarantees or production/PAPER readiness.
- 8 × 8s on one date with BTC/SOL is merely **instrumentation and prospective falsification**, not an independent OOS statistical benchmark. A future serious discovery requires diverse days, block dependence handling, realistic bid/ask fills, lots, fee tier, mark/index and funding, a predeclared holdout and corrections for multiple attempts.

Use research branch only. No trades, authentication, automation, paid data or merge into main.
