# Algorithm Discovery v8 — bounded sequential microstructure experiment

**Research-only protocol authored 2026-10-30, before any v8 price-outcome research.** Previous v6 and v7 prospective one-hour pilots were **negative**. Do not optimize or disguise them. Work in a new isolated branch, no active Trader/PAPER/live, no credentials, paid sources, jobs or scheduled collectors.

## Sources — public WebSocket, not time-truncated REST

Official OKX API v5 public WebSocket (no account login):
- `wss://ws.okx.com:8443/ws/v5/public`, `books` channel (100ms ordinary non-RPI incremental level-2 changes). Public snapshots and updates include `seqId` and `prevSeqId`; use both per instrument. The old `checksum` is deprecated and fixed to `0`: **NEVER treat it as integrity evidence**.
- `wss://ws.okx.com:8443/ws/v5/business`, `trades-all` channel: individual trade records with taker-perspective buy/sell and trade size **in derivative contracts**. Unlike aggregated `trades`, one message represents an individual fill. No globally aligned orderbook/trade sequence is documented, so a cross-channel ordering inference is not certified.

References:
- https://www.okx.com/docs-v5/en/
- https://www.okx.com/docs-v5/trick_en/
- https://www.okx.com/docs-v5/log_en/ — 2026-06-23 checksum deprecation.

Public `books-l2-tbt` / `books50-l2-tbt` are VIP gated; **do not use** them or attempt login. RPI is not included in ordinary public `books`. A separate public `books-rpi` channel exists but has a different depth representation and will not be silently merged with `books`.

## Pilot capture definition

Collect ONE symbol per explicitly invoked manual bounded job, beginning with `BTC-USDT-SWAP` and potentially `SOL-USDT-SWAP` as separate pilot runs (not a 50-market market-wide test). Two independent WebSocket connections, 8-second observation period **after both subscriptions have been acknowledged and a full book snapshot has arrived**. Capture the raw complete JSON payload and the locally measured **complete receipt** UTC time for every relevant book/trade data frame. Preserve complete original bytes and SHA-256 source manifest in a uniquely named output directory. Preserve control frames too when useful. At runtime maintain a strict limit of total messages and total bytes; fail closed instead of silently truncating.

Each book update must link `prevSeqId` to the prior accepted `seqId`. Special OKX keepalive no-change frames can have `prevSeqId == seqId == previous seqId` and no levels; preserve them. On any discontinuity mark **sequence_gap**, invalidate the post-gap book until a new full verified snapshot; no inferred depletion/replenishment feature may bridge the gap. `checksum=0` is not proof of integrity. Book updates with size `0` mean deletion of that *displayed level*, but **not proof the order was cancelled**; it may have traded or been moved. Applied changes must maintain nonnegative quantities, ordered bid and ask, no cross or duplicate keys. Use Decimal without floating errors. As-of for every frame = its complete local receipt, never exchange `ts` alone.

For `trades-all`, require one fill per data object, valid `side` and `tradeId`, unique IDs within the bounded capture, nondecreasing exchange timestamps in received order; two fills in same millisecond need not have numerically ascending IDs. No claim of exchange-wide gapless trade capture unless the channel provides gap-detection guarantees. Counts and contract sizes are **not quote-volume without contract multipliers**.

## Measurement / distinct concepts

Reconstruct a genuine *time-evolving* top 5 or top 10 ordinary displayed-depth series using snapshot+delta replay. Separate the following as **observables**, not causal proof:
1. Count and cumulative signed changes of displayed depth at matching price levels over the 8 seconds, with sign-known quote additions and reductions; a reduction cannot be classified as a cancellation versus execution.
2. Continuous received taker trade buy/sell contract sums within the **same fixed interval**, with unique ids (unlike v7 recent-100 variable span). Cross-channel timestamp/race means a contemporaneous association is descriptive, not a trade-to-level match.
3. At best bid/ask and top-n, quote recovery after reductions as a **replenishment proxy**; it is not proven executed passive absorption.
4. Book sequence continuity, data freshness, event rate, crossed-book violations, trade gaps unknown, and time/market coverage.

For the first run produce source integrity and quality diagnostics only. **No future price outcomes, signals, hourly returns, pseudocapital or model optimization.** Use an independently fixed subsequent experiment to test whether measured quote recovery following aggressive flow predicts a later return or reduced realized volatility, matched to transparent baselines. Pre-register features and execution timing **before** future outcomes of that study are retrieved.

## Fail-closed safety

Public URLs allowlisted, no private/public trade action, login, API key, browser, scheduler, background workers, posting or trading commands. One run lasts <=8 seconds of observation, explicitly invoked by user in present chat; close both WS connections at end. Output file is immutable no overwrite, raw bytes hashes rechecked by the offline verifier. An interrupted capture, missing subscription/snapshot, loss of sequence, bytes/record cap, stale or mixed symbols must be reported as **not suitable for inference**; don't silently fabricate a restored sequence. Historical screen membership is not PIT-certified. Do not merge research into main.

Next: implement capture and offline tests, run short live source probe(s), report raw audit and controls, then design a separate future experiment. No promise of positive results.
