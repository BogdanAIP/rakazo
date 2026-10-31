# Algorithm Discovery v21 — 15-second source, 8-second feature window, 3-second settlement: preregistered protocol

**UTC 2026-10-31. This protocol is committed BEFORE collecting ANY v21 market source.** Research-only. The 1.66s local-receipt minus exchange-event timestamp difference measured on Oct30 in v20 is NOT a measured network delay or a calibrated Windows/exchange time offset. Two read-only attempts to inspect Windows Time Service status through connected R returned remote internal errors; no independent clock authority or offset evidence is available, and NO correction factor is used.

## Exact finite test: 2 NEW captures, no retries to chase results

Exactly one bounded **15-second public `books` and `trades-all` WebSocket recording** each in the fixed order `BTC-USDT-SWAP` then `SOL-USDT-SWAP`. New unique raw folders `ws-v21-oct31-btc-01`, `ws-v21-oct31-sol-01` in the existing research source root. All source content is retained exactly as it arrives, with original UTC and monotonic receipt timestamps, logical message bytes, ordinal, event classification and SHA256. Reuse original read-only public WS collector unchanged with process-local 15-second override. The 15-second source must pass a generalized full-original-file v18 auditor with exact original source hash, ACK, full snapshot, gapless *book* sequence, valid book quotes, unique trade ID, source timestamps and resource limits. **The public trades feed is NOT proven gapless or totally synchronized with books.** One attempt per symbol, no opportunistic repeat or fallback; preserve failure honestly.

The 15s capture is divided by source-local receipt clock, measured from original synchronized start:
- **[0s,4s):** warm-up book state (no taker flow features).
- **[4s,12s):** pre-fixed 8-second FEATURE period.
- **[12s,15s):** exactly 3 seconds additional SETTLING; data received here may be examined only at **true decision time after +15s**, never earlier. It does not extend feature time or retroactively make a trade prediction at +12s.

## Two same-exchange-clock book-watermark anchors, measured without fitting

Determine **S** = exchange `book.data[0].ts` of the *last valid incremental book update received strictly before local +4,000 ms*. Determine **E** likewise of last valid incremental book update received strictly before local +12,000 ms. Both selected by local complete-receipt order, fixed at collection, no result-based selection. Require `S < E`, report observed `E-S`. These are **book exchange-time boundaries**, only an exploratory proxy for an 8s event-time interval; book and trade streams need not have matching engine chronology. Do not infer a calibrated relationship between either exchange timestamp and local receipt clock.

For each received `trades-all` individual fill `f` with `S <= trade.ts < E`:
- **base_available_count**: received locally by +12s (and after the collection starts);
- **settled_available_count**: received locally by +15s (and after start);
- **incremental_recovered_count**: received in [12s,15s) and not available by +12s.
Also count total frames received in settling, their book/trade breakdown, out-of-feature trades, trade exchange timestamps older than S, future beyond E, and number of fills that were in feature event-time yet arrived before/after +12s.

For descriptive per-event-time-bin coverage, use *only* bins k=0..7 defined as `[S +1000*k, S+1000*(k+1))` and **only when** these bins are contained in `[S,E)`; if `E-S<8000ms`, any trailing bins outside E must be explicitly unavailable (not marked as empty source of no fills). Report number of distinct trade-containing bins at +12 and +15 and whether settling increased them. This coverage is **not** a v14/v15 hypothesis signal and does not replace their frozen source-quality threshold.

Report a clock-status observation separately as `WINDOWS_TIME_SERVICE_UNVERIFIED` (local read-only query failed). No network time-server query, `w32tm /resync`, OS clock modification, external REST, private API or trading action.

## Causality, negative findings and next steps

If no late historical feature-time trades arrive, report **0**, not a failure. If an archive/source fails validation, do not substitute another capture or infer PnL. All results must say `can_trade=false`, `can_start_paper=false`, `future_price_labels_accessed=false`, `actual_decision_time=source_end_at_15s`, and `no_alpha_claim=true`. Do not present +12s as a prediction time if data was allowed to arrive through +15s.

This is a source-timing engineering experiment only, not a test of profitable algorithms. A future *new* registered v22 source-only hypothesis could incorporate a fixed 3-second settle and then be scored only on new market data *after* its own decision time, but v21 data are not available for post-hoc profitable selection. All v12 original Nov1–Nov12 60-slot preregistration remains immutable. Existing v14/v15 formulas, v6–v20 negative/abstaining results, active Trader/PAPER/live, main branch, automation and paid services untouched.
