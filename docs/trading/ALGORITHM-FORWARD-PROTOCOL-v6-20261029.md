# Algorithm Discovery v6 — frozen forward-only research protocol

**Preregistered on 2026-10-29 before requesting any post-freeze forward-price outcome. Research only; no trading.**

The existing v5 frozen 50-market universe and its two authenticated public API snapshot rounds are the only inputs to the *first* v6 event cohort. These events have already been inspected (5 co-movement, 7 opposition, 38 abstentions); hence it is NOT honest to call selection of the representation itself blinded. However, **forward candle returns must not be opened or analysed before the freeze manifest is written**. Do not relabel old July–September backtests as independent validation.

## Primary preregistered descriptive hypothesis

Among **CO_MOVEMENT** events only, define a hypothetical direction `sign(change of forecast funding rate)`. Hypothesis H1: the resulting one-hour next-open-to-future-open signed mid/last-trade return is positive, and remains positive after symmetric fixed costs of **7 bps per executed side** (stress: 14 bps per side). This is a *falsifiable research hypothesis*, not established directional inference: Open Interest does not reveal aggressor side or whether longs/shorts dominate.

**All other events abstain** in the primary hypothesis. The 7 OPPOSITION events are a descriptive *negative control*, not an opportunistic alternate strategy. The 37 flat funding forecasts and 1 rolled funding period also abstain. No thresholds are optimized on this cohort; original 50 ranked constituents and all invalid cases remain in reports.

## Exact causal timeline

- Each instrument's event is available only after **both second-snapshot HTTP responses have completed**, never on a settlement time or exchange-generated `ts`.
- A separate immutable freeze manifest is written *before scoring or downloading forward-price outcomes*, with the host's UTC creation time, the exact bytes SHA-256 of the panel and verified labels, 50 source ranks and primary hypothetical directions.
- For the first cohort, every instrument shares ONE execution boundary: **the first 15-minute UTC bar open strictly later than BOTH the last full capture receipt and the freeze manifest creation time **plus a fixed five-minute guard****. This prevents pretending the earlier 18:30 UTC open was still available after the research hypothesis was frozen. The file creation timestamp is part of the freeze; no retroactive execution.
- Entry = OHLC trade price `open` at the frozen entry-bar timestamp. Primary exit = `open` exactly 60 minutes later (four 15-minute bars). Secondary diagnostic exit = `open` exactly 15 minutes later. For reproducibility, prices are read only from **confirmed** `bar=15m` official OKX candles, and the exit-bar must itself be completed before scoring. This deliberately sacrifices immediacy for strong source verification.
- No synthetic candles, missing-open interpolation, forward filling, previous candle close substitution, zero-funding assumptions, or selecting the more favorable intrabar high/low. Missing, stale, reordered or unconfirmed price evidence means **ABSTAIN_MISSING_VALID_PRICES**, never a zero-return trade.
- Price requests after the freeze are restricted to `GET /api/v5/market/candles?instId=<frozen>&bar=15m&limit=...`, using original public response bytes, actual request-start/complete-receipt times, response checksums, instrument identity, chronological and 15-minute alignment checks.
- Forward outcome retrieval is permitted only once *the primary exit candle has fully completed*: minimum `entry_open + 75 minutes`. A value observed after that is a retrospective **outcome**, not a real historical order fill. No unconfirmed or stale current price is a valid outcome.

## Endpoints/fees/model limitations

- The fixed-notional proxy uses 10% **initial portfolio equity per qualifying market**; across 5 simultaneous events, total nominal allocation <=50% for this one cohort. Simple gross payoff: `0.1 * side * (exit_open / entry_open - 1)`. Approximate two-sided cost: `0.1 * fee_side * (1 + exit_open / entry_open)`. Do not aggregate across future overlapping cohorts without a separate portfolio exposure budget.
- Report gross, 7bps/side net and 14bps/side stressed net, all 50 statuses and actual entries. Cash non-trade is 0%; price-only or randomized controls must be predeclared before any **new** independent validation sample.
- These are OKX trade candles, not tradable guaranteed execution or mark-price candles. Model omits spread dynamics/impact, fill queue, trading fee tier uncertainty, currency conversion, funding cashflows, contract value/lot rounding, liquidation, margin usage and outages.
- Forecast funding is not a settled funding payment. Historical publication timestamps for previous archived funding still unknown.

## Statistical interpretation and stopping rule

**One 50-market observation cohort = one correlated time block, not 50 independent samples.** All 5 primary candidates share broad market shocks. A single block can be an instrumentation and falsification test ONLY. Do not calculate or claim a significant p-value, performance edge, daily return, Sharpe ratio, or safe leverage from it.

The protocol would require at least 30 **non-overlapping future time blocks over at least 10 separate UTC days**, at least 100 qualifying events spanning at least 20 unique markets, documented historical PIT membership and full coverage, realistic executions and settlement cashflows, and predeclared dependence-aware (day-block) uncertainty and multiple-testing control before claiming an independently replicated advantage. Those thresholds are **research gates**, not statistical proof by themselves. If any gate fails, report `INSUFFICIENT_INDEPENDENT_EVIDENCE` without hypothesis flipping or post-hoc respecification.

## Safety and execution

The freeze, capture, and score tools are offline or **public read-only**; no API key, account, PAPER, live order, server scheduler, autonomous retry loop or main merge. Manual individual bounded capture only. File writes use new unique paths and SHA-256 linking. No tools may trade or copy research events into active Trader.

**Frozen primary:** `CO_MOVEMENT -> sign(funding forecast delta) -> 60-minute confirmed-candle open/open net equity proxy at 7bps per side`. Every other grouping is descriptive and must not be selected as a winner on this cohort.
