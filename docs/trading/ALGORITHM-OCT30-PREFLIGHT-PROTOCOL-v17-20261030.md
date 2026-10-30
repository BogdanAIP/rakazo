# Algorithm Discovery v17 — 2026-10-30 same-day exploratory source-only preflight

**Committed BEFORE new source recording on 2026-10-30.** User asked why wait until Nov 1. Answer: there is no technical reason to wait for raw source capture, but the existing v12 November 1–12 immutable study must remain untouched. Today's two sources are a **SEPARATE** unscheduled exploratory audit and do NOT enter v12 development, validation, holdout or independent testing. No account/order/private/API, no PAPER, no paid sources, no automatic background monitor.

## Frozen acquisition order

Exactly one 8-second public OKX two-stream WebSocket recording for `BTC-USDT-SWAP`, then one 8-second recording for `SOL-USDT-SWAP`. Use existing `algorithm_ws_capture_v8.py` unmodified and source folders `ws-v17-oct30-btc-01` and `ws-v17-oct30-sol-01` respectively. No favorable rerun on weak/nonqualifying observations. Retain failed attempt metadata; never substitute Nov sources.

The capture uses public `books` incremental sequence (continuity checked) and public `trades-all` taker fills, original per-WebSocket message SHA, receive timestamps and source ordinals. Trade stream is NOT independently certified gapless, the two WS streams do NOT have a shared exchange order and ordinary book may exclude RPI liquidity. Source-only v17 results are NOT PnL.

## Two hypotheses registered BEFORE data

Use exactly the immutable ChatGPT-authored v14/v15 proposal IDs, with no changes to their formulas:

- `flow-memory-flip-20261030`: early and late 4-second taker signed flows have opposite sign, but midquote late 4 seconds retains original sign; hypothetical direction opposite original sign.
- `impact-efficiency-decay-20261030`: both halves' signed taker flow keep the same sign, but midquote displacement per net signed contract decreases while remaining nonnegative; hypothetical direction opposite the flow.

For each verified raw capture, derive both via existing explicit allowlisted `source_only_signal()`, not executing AI text. Source quality and abstention conditions are frozen in registered proposal and implementation. If a candidate is registered after the source's start, reject; no after-data hypothesis proposals can be counted as prospective. These two rules are mutually incompatible on a fixed source window since first requires flow sign flip, second flow same sign. Two candidate checks on one source are **ONE market-time observation**, not two independent trading experiments.

## Evidence output and conclusion

Write immutable per-source JSON with exact source manifest SHA, source raw logical message SHA, capture UTC, signal-rule IDs, eligibility and abstention reason, and no future quote. `can_trade=false`, `can_start_paper=false`, `realized_pnl=null`; no ex-post direction, horizon or fees tuning. Four source-only candidate evaluations across two market captures can yield zero, one or two eligible events; outcomes remain UNLABELED in every case.

**Success criterion for v17:** demonstrate an immediate safe manual research session on the same day, not profitable alpha. This pilot is strictly outside the v12 60-cell calendar and not evidence of independent return forecasting. Future quote/archive retrieval still requires a separately authorized authentic later source; do not bypass previously blocked live REST requests.
