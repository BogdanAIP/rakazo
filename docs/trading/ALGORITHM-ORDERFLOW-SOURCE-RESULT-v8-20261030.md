# Algorithm Discovery v8 — live incremental-orderbook and per-fill trade source pilot

**2026-10-30 UTC. Source experiment and infrastructure validation only. No forward-price outcome scoring, simulated returns, or trades.**

## Motivation: independent mechanism, not a retuned indicator

Earlier locked directional tests failed: v6 OI+forecast-funding baseline net **−0.143426%** initial-equity proxy (5 candidate directions, single market hour); v7 ordinary book-depth vs last-100 taker opposition baseline net **−0.348130%** (26 directions, single market hour). These were negative, correlated one-time pilot results, **not a proof that all plausible orderflow strategies fail**.

A single point-in-time book and truncated last-100 fills cannot tell whether displayed passive liquidity replenished or vanished after active taker flow. This v8 experiment tests the *measurement pipeline* needed for a different hypothesis.

## Public channels and documented semantics

The v8 source protocol [ALGORITHM-ORDERFLOW-PROTOCOL-v8-20261030.md](ALGORITHM-ORDERFLOW-PROTOCOL-v8-20261030.md) was committed **before** v8 live source acquisition.

- Public WebSocket `wss://ws.okx.com:8443/ws/v5/public`, `books` for 100-ms incremental 400-level ordinary (non-RPI) order-book data. Rebuild from snapshot, verify each update's `prevSeqId` equals previous accepted `seqId`.
- Separate public business WS `wss://ws.okx.com:8443/ws/v5/business`, `trades-all` for unaggregated taker-perspective fills. One trade per emitted data message, but no documented lossless trade sequence number or total ordering together with `books`; cannot guarantee missed-fill detection.
- The obsolete order-book `checksum` value is now fixed to `0`, not an integrity check. Never assert cryptographic or sequencing integrity from it. Read-only sources, no login or trading API endpoints.

Primary references: https://www.okx.com/docs-v5/en/ ; https://www.okx.com/docs-v5/trick_en/ ; https://www.okx.com/docs-v5/log_en/ (June 2026 checksum change).

## Captured live observations (separate eight-second intervals)

| Source characteristic | BTC-USDT-SWAP | SOL-USDT-SWAP |
| --- | ---: | ---: |
| UTC capture | 04:18:30.014–04:18:38.017 | 04:19:38.420–04:19:46.424 |
| Original WebSocket data/control messages | **4,940** | **346** |
| Sequence-verified book updates in full interval | **80** | **79** |
| Per-fill taker trades in fixed interval | **4,581** | **259** |
| Book sequence chain continuity | **PASS** | **PASS** |
| Fixed 1-second bins with both book updates and trades | **7/8** | **8/8** |
| Taker buy volume, contract units only | 11,755.23 | 301.64 |
| Taker sell volume, contract units only | 2,184.66 | 1,409.19 |
| Taker imbalance within the SAME SYMBOL and 8s window | +0.686560 | −0.647376 |
| Displayed readdition events to a price level previously reduced, bid side | 2,832 | 258 |
| Displayed readdition events to a price level previously reduced, ask side | 2,183 | 313 |
| Independent alpha proven | **NO** | **NO** |
| Real or PAPER orders | **NONE** | **NONE** |

**Interpretation limitations:** The above are two **different, nonsimultaneous** 8-second market intervals, not a market-neutral paired test. Derivatives sizes are in **contracts** with different contract multipliers; raw BTC and SOL totals **cannot** be directly compared as USDT capital or USDT volume. Individual second-level imbalances for sparse windows can vary dramatically. No future returns or p-values were computed.

The readdition metric counts *observed price-level quantity increases after earlier reductions* within a fixed window. It is a purely observable **quote-readdition proxy**, **not proof** of a specific maker adding orders after getting filled, true absorption, a manipulation, or net institutional trading. Reductions may be executed, canceled, modified, moved, or aggregated. It can count the same price level repeatedly; the full-depth rate differs across tick sizes and market dynamics. No global causal book/trade event sequence exists across the two WS connections.

## Important instrumentation findings and explicit fixes

1. The live BTC source produced **one incremental update with 448 ask levels** and another with 403, exceeding the **400-level book image depth**. The original offline validator incorrectly used 400 as a **per-update maximum**, so it failed. Source text was retained unchanged. Raised only the bounded per-update limit to **1,000**, retaining strict price order, positive/nonnegative size, duplication, sequence, crossed book, raw SHA and bounded source size. Added a regression test where 448 succeeds and 1,001 fails.
2. OKX sometimes emits `trades-all` messages before the subscription ACK. Raw event history preserves them, but the data cannot enter a synchronized 8-second observation window until **both ACKs and a full book snapshot** arrive. The auditor refuses an unauthenticated in-window data event. Fixed window starts after both connections are ready.
3. Added independent tests for raw logical WS message hash, source identity and channel allowlist, synthetic sequence gap, duplicate trade ID, crossed book and exact one-second bucket accounting.
4. Fixed 1-second series reject incomplete bins for joint observations. For this run BTC contained **7/8** valid joint bins and SOL **8/8**. Splitting bid and ask price-level readdition counts was implemented *after examining pilot sources* and is therefore **exploratory engineering**, not pre-frozen predictive discovery. The first generated per-second files were superseded by new `-seconds-v2.json` files; original immutable files were never overwritten.

## Evidence and exact cryptographic hashes

Local research root: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`. All raw message payloads are logical UTF-8 WebSocket text messages with complete local receipt timestamps, and hash-checked; they are not raw TLS/network frame bytes.

| File or folder | SHA-256 (exact bytes) |
| --- | --- |
| `ws-v8-btc-20261030-trial01/manifest.json` | `82dddbf6b403693e891ba4b532b995179985167f194c43c16da65e475e4bc895` |
| `ws-v8-btc-20261030-trial01-audit.json` | `7eacdc109c6dc43c15c00afa4a00795abc5fa8fc306761d30ef1d7609512cf0c` |
| `ws-v8-btc-20261030-trial01-seconds-v2.json` | `e76d9e96d215dd9f25d17003783423ebb49ebba1bf82a925f9efcf6a78b6e39f` |
| `ws-v8-sol-20261030-trial01/manifest.json` | `84af7ebf8276cb327df9f98f6a16371d2b2d09c898e5196a617f1b5a81f0afaf` |
| `ws-v8-sol-20261030-trial01-audit.json` | `5e1fd42c24b1e6e913d67e7dee0b4cc7fc5b6f0e690a92004331ed6eaaa4a49b` |
| `ws-v8-sol-20261030-trial01-seconds-v2.json` | `a9a3f7e282e4cd450cbdb6ee83e9b0d422a7dfd8d52e7bc1b336c5311dcce015` |

The manifest contains the exact SHA-256 of its `messages.jsonl`, every logical frame has its own SHA and receipt timestamp, and the offline audit **replays original payloads**, reconstructs the book and verifies sequence continuity before extracting features.

Source files: `scripts/trading/algorithm_ws_capture_v8.py`, `algorithm_ws_audit_v8.py`, `algorithm_ws_buckets_v8.py`; tests `test_algorithm_ws_audit_v8.py` and `test_algorithm_ws_buckets_v8.py`. No auto background worker, no external paid source, no active Trader/PAPER edits, no main merge.

## Next falsifiable hypothesis (planned, NOT frozen or tested)

For genuinely *new, independent future observations*, compare a **passive-liquidity response mechanism** to null, taker-flow-only, and price-only controls rather than immediately outputting long/short orders:

- Divide future **predeclared fixed-duration**, sequence-valid WS windows into one-second bins.
- Define signed aggressive taker flow, **side-specific reductions of visible book quantity**, and later same-price readdition conditional on prior reduction, all measured with receipt chronology. Freeze the exact feature arithmetic, quality gates, timing and null comparisons before accessing independent future return labels.
- For a buy-dominant episode, ask whether renewed displayed ask-side depth is associated with a lower subsequent midprice drift *than comparable buy-dominant episodes without that recovery*; symmetrically for sell-dominant episodes with bid-side recovery. This is a falsifiable observational hypothesis **not proof of execution-to-quote matching or passive fill absorption**.
- Evaluate **future** targets, not within-window price, with conservative next-eligible execution and realistically sized futures contract round-trip costs, settled funding if applicable and execution model. Reserve proper holdout days and dependence-aware evaluation; do not choose the best horizon, threshold, side, or subset after seeing prices.

Current sample comprises only **two short, sequentially observed instruments**, already inspected. It cannot establish predictive edge. For generalizable tests, first prove reproducible complete data collection across many disjoint windows, and admit that trade stream gaplessness cannot be established without stronger guarantees. Repeat on additional days and benchmark controls before drawing any inference about market prediction.

**Result: v8 collection and causal-book-sequencing infrastructure FEASIBLE and live-tested, forecasting hypothesis NOT YET TESTED, trading NOT ENABLED.**
