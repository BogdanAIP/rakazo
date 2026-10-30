# Algorithm Discovery v19 — fixed trailing 8s prospective source-only pilot, 30 October 2026

**Completed on the user's Rakazo Windows research machine on 2026-10-30 UTC.** Strictly public read-only WS source collection, never traded or modified active Trader/PAPER/live, automations, credentials or main. This is a source quality/eligibility experiment, not a profitable alpha backtest.

## Protocol, original and amendment

Original v19 protocol `docs/trading/ALGORITHM-FIXED-TAIL-PROTOCOL-v19-20261030.md` was committed **before** new source capture (`cdb5588c438cef8af4476fe322e3c7d7838d9a9a`). It fixes exactly one 12s public WS capture each for BTC-USDT-SWAP then SOL-USDT-SWAP, with **ONLY** the last 8 seconds (source indices 4–11) feeding two already registered ChatGPT research hypotheses. The first 4 seconds prepare source book state, not taker-flow feature counts. No opportunistic selection of one of five overlapping 8s slices; no reuse of v18 raw files.

An engineering error appeared AFTER original BTC collection: initial v19 postprocessing compared strict tail exchange-time-gated fills against v18 original 12s receipt-based event counts as if the two were identical. They are not: **73** BTC messages received in the tail came from taker executions timestamped by the exchange BEFORE the tail started. Original BTC raw files were preserved unchanged, no future quote/result was read, and BTC was NOT recaptured. The source-only adapter was corrected to **exclude** delayed pre-tail executions and report both counts, and a synthetic test was added before SOL capture. This is explicitly a *post-BTC source instrumentation amendment*, not an unmodified fully precommitted evaluation. Details, original BTC SHA and rationale: `docs/trading/ALGORITHM-FIXED-TAIL-AMENDMENT-v19-20261030.md`. Both v14/v15 mathematical signal definitions, >=6 of 8 source quality, 5 minimum fills per half, 5-minute hypothetical horizon, and no-future-data guards stayed **unchanged**. No market outcome was inspected.

## Exactly two NEW original public WS recordings

Immutable private research source root:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`.

| Detail | BTC-USDT-SWAP | SOL-USDT-SWAP |
| --- | --- | --- |
| Original raw folder | `ws-v19-oct30-btc-01` | `ws-v19-oct30-sol-01` |
| 2026-10-30 UTC start–end | 13:01:32.005–13:01:44.018 | 13:05:32.082–13:05:44.097 |
| Actual duration | 12.013 s | 12.015 s |
| Original logical WS messages | **331** | **301** |
| Original manifest SHA-256 | `bb28fd01195f449ebce05a518839f13f3c69cfe4a5957cd6b24ae171619b6688` | `af56a1183f213265a343bd8d3b09d2c9b9dcfd40e4e109cfa3b2473337f3a7c6` |
| Original `messages.jsonl` SHA-256 | `6c29b0d7c14bdee10b78a61fa15ed6963758fffae26e388a3928c0fa424b2167` | `3660e1705fa69895e90e2792425fb613a546842e7ccefbd5433de20b9a9ea55d` |
| Original independent 12s receipt-based trailing-window joint seconds | **7 / 8** | **6 / 8** |
| **Strict v19 trailing-window joint seconds**, requires exchange execution time in tail | **5 / 8** | **5 / 8** |
| Received-in-tail trades with exchange time before tail, *excluded* | **73 fills** | **1 fill** |
| Two unchanged v14/v15 AI hypotheses checked | 2 | 2 |
| Eligible source-only directions, threshold >=6/8 | **0** | **0** |

Both complete 12s original sources passed the independent v18 SHA/sequence/ordinal audit. The strict v19 tail is deterministic, derived from exactly source seconds 4–11. The time of prediction is the actual local original 12s capture end. This is NOT independent proof the public `trades-all` feed is gapless or book/trade sockets share a matching-engine event order.

## Exact immutable source-only outputs

Saved under the same private research root:

- `ws-v19-oct30-btc-01-tail-source-only.json`, SHA256 `98f0ba116f45ca804ba5409dbff81fe2131f76d268183df23e5e89dda3dc3416`.
- `ws-v19-oct30-sol-01-tail-source-only.json`, SHA256 `e72eed82c8cc3da12c4109d8628ed7d080864cc5ebd2988de8f9e186ae1297e1`.

For **both** BTC and SOL, **both** candidate rules `flow-memory-flip-20261030` and `impact-efficiency-decay-20261030` returned `SOURCE_QUALITY_ABSTAIN`, `hypothetical_direction=null`, `eligible=false`. No five-minute exchange outcome price, return or PnL was acquired or evaluated, no v12 November cohort cell filled, and no actual/paper order sent. Four candidate eligibility checks on two market-time sources count as only **two distinct source observations**, with zero eligible signals; do not relabel abstentions as losses or wins.

This is scientifically useful: treating local receipt time alone as execution time can falsely make a source look more complete. In the BTC source 73 delayed trades would otherwise contaminate the fixed 8s taker-flow features. **v18's 11/12 BTC and 10/12 SOL completeness were *receipt-time* quality figures, not guaranteed exchange-time-aligned prediction windows.** More raw messages or longer capture do not automatically yield more valid prospective observations.

## Code, tests and integrity

v19 source-only read/replay adapter `scripts/trading/algorithm_fixed_tail_v19.py`; synthetic test `scripts/trading/test_algorithm_fixed_tail_v19.py`, including a delayed-fill test proving that even when the 12s receipt-only auditor counts a bin, the strict 8s tail must exclude an execution originating earlier.

All **6/6** new special tests passed before SOL capture. After both sources, disjoint broad regression groups passed **215 `test_algorithm*.py` + 26 `test_[!a]*.py` = 241 tests passed**. The additional `test_alpha*.py` group had previously been blocked by tool safety and was not run here; don't describe this as the full all-tests suite. Dedicated research branch `research/algorithm-discovery-fixed-tail-v19-2026-10-30` and isolated Windows worktree `C:/Users/eahra/rakazo-alpha-tail-v19`, no edits to main.

The original v12 immutable Nov1–Nov12 source-plan SHA remains **`6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`**, as checked independently after v19 sources. No source was taken from or written into that plan's future 60 observation slots.

## Next precommitted experiment and meaningful limitation

A next, separate **event-time latency** study could quantify distribution of `receive_utc_ms - trade_exchange_ts` and book quote ages by instrument/time of day before any tuning; then compare a *fixed*, noncherry-picked watermark/settling rule to the same >=6/8 criteria on **new sources only**, without retroactively refitting v19 or treating delayed trades as fresh. Alternatively investigate whether capture can preserve reliable exchange-time synchronized events despite WebSocket delivery jitter. Any new rule must be explicitly registered before its new source.

For financial conclusions: need separately authenticated, available five-minute later bid/ask exchange archival evidence plus cost-aware quote-crossing proxies, realistic fee tiers, funding/slippage/contract lots, enough independently separated market-days and truly frozen holdout. **v19 has zero eligible source decisions and no validated alpha, nor a negative economic return.**

All tasks manually launched through ChatGPT/Rakazo; laptop can be off between bounded sessions. No autonomous daemon or market order service.
