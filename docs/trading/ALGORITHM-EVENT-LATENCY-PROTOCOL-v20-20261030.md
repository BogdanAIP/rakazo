# Algorithm Discovery v20 — independent event-time/receipt-time latency audit (pre-registered)

**UTC 2026-10-30. This research protocol is committed BEFORE any new v20 sources.** Manual foreground only. Neither a trading system nor an alpha trial. Original November v12 12-day/60-slot plan, all previous v6–v19 raw files and immutable candidate rules remain unchanged.

## Exact finite new-source experiment

Collect precisely **one new 12-second, public read-only OKX WS source** per frozen symbol in this order: BTC-USDT-SWAP then SOL-USDT-SWAP. Reuse the previously validated 12s raw source wrapper `scripts/trading/algorithm_capture_12s_v18.py` without changes, and independently audit original full raw source via `algorithm_ws_12s_coverage_v18.analyze()`. Keep all original 12s WS source envelopes, timestamps, monotonic receipt clocks, book sequence and per-message sha256 in NEW unique paths `ws-v20-oct30-btc-01`, `ws-v20-oct30-sol-01` under the existing local research root. No retries to select more favorable source quality. Failed attempt is recorded as a failure, not silently replaced.

The origin channels are existing public `books` (WS public) and `trades-all` (WS business). They have **different connections without exchange-certified total ordering**. Public trades cannot independently be proven complete. No REST future book request (blocked in v11), order/account APIs, paid providers, automation, main or Trader/PAPER changes.

## Fixed observation and diagnostic definitions

Work only after source raw manifests, raw-message hashes and sequence tests pass. Use original `start_utc_ms` and `end_utc_ms` from capture. Source-time for book is `data[0].ts`, and for trades it is the individual `data[0].ts` (both published exchange milliseconds). Local receipt time is `received_complete_utc_ms`. For all valid book snapshot/update frames and received individual taker fills whose COMPLETE LOCAL RECEIPT occurs strictly in original 12-second capture, compute apparent one-way event delay (milliseconds):

`delta_ms = received_complete_utc_ms - exchange_ts_ms`.

Report book and trade distributions **separately**, including n, min, p10, p50, p90, p99, max and counts of deltas <=0, 1–250, 251–500, 501–1000, 1001–2000, 2001–5000, >5000 ms. For deterministic quantiles sort integer deltas and use *nearest rank* `ceil(n*p/100)`, with p0 as minimum and p100 maximum. These are **apparent delays**, not confirmed transport latency: laptop clock skew vs exchange clock, WS queueing, serialization and server processing are unknown and may yield negative values. Do not clamp negatives to 0.

For each predeclared whole-second interval **0..11** relative to source start, separately count book update messages with valid receipt in bin and taker trades whose local receipt is in bin. For the predeclared **trailing 8-second interval indices 4..11**, also count taker fills with both receipt in bin and exchange trade ts inside fixed trailing eight seconds. These stricter filled seconds cannot outnumber the receipt-only seconds, and no pre-tail execution may be credited as in-tail even if received later. Maintain histograms of late executions received in tail with trade exchange time preceding tail, and of negative/zero/positive apparent delay. Record first/last UTC receipt, all original SHA references and exact provenance.

Every report records **both** `receipt-only trailing joint bins` and `exchange-time strict trailing joint bins`. No 6-of-8 relaxation, no backfilling future-unreceived fills, no "best" overlapping window. Interpret two 12s captures as two MARKET-TIME observations. The v14/v15 rules are NOT run to create financial predictions in v20; no 5-minute prices, fills or PnL are scored.

## Predeclared engineer-evaluable inference, not market claims

The primary exploratory question: **Are delayed early-execution trades received in trailing feature window a significant source of apparent coverage inflation?** Compare strict vs receipt-only trailing bins for each instrument, report difference and late-fill counts without claiming causation from two sessions.

A future v21 timestamp watermark / deterministic settling period (if warranted) MUST be independently preregistered with real decision time including any wait, and use NEW later sources only. No post-hoc changing timestamps, thresholds or retroactive promotion of v19 source-quality abstentions. Archive future-price authenticity remains unresolved and must not be bypassed.

**All results: SOURCE-LATENCY-DIAGNOSTICS-ONLY, forecast=null, realized_pnl=null, can_trade=false, can_start_paper=false.**
