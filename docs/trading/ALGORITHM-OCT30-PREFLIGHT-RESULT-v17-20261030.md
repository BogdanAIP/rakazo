# Algorithm Discovery v17 — first same-day October 30 manual preflight completed

**Actual source collection and evaluation completed 2026-10-30 UTC, research only.** User correctly asked why collection was deferred until 2026-11-01. That date was an arbitrary organizer's selection for the frozen v12 12-day cohort, **not** a technical limit of ChatGPT, Rakazo or public OKX WebSocket feeds. v17 starts a SEPARATE experimental track today, leaving November v12 unchanged.

## Original protocol and post-source engineering correction

Primary v17 plan committed **BEFORE** source capture at `7d421e751ff3682632b5315039ab1f3fc9fe3ba6` (`docs/trading/ALGORITHM-OCT30-PREFLIGHT-PROTOCOL-v17-20261030.md`), specifying exactly one eight-second public WS source BTC-USDT-SWAP followed by SOL-USDT-SWAP; evaluate both previously registered v14/v15 ChatGPT source-only hypotheses without future labels.

An initially erroneous engineering check required source end-start EXACTLY 8000 ms. First BTC source was naturally 8009 ms. After BTC was recorded, code was corrected to accept 7500–8500 ms with no other hypothesis selection/threshold changes. This is **post-source instrumentation correction**; the first attempt was retained, no price outcome was inspected. The explicit original-source amendment is `docs/trading/ALGORITHM-OCT30-PREFLIGHT-AMENDMENT-v17-20261030.md`, commit `4b3f91c8cb21259b8d8a747363b11742c4849112`. SOL source was recorded only after correction. Therefore do not describe the full analysis pipeline as completely unchanged after its first source arrival.

## Two actual NEW eight-second sources captured

Public raw source root: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`. Each original full logical WS text, receive UTC, sequence and per-message SHA is preserved in its named folder. Both passes `algorithm_ws_buckets_v8.build_buckets` source replay and fixed sequence quality audit. Taker `trades-all` is not exchange-certified gapless; no shared exchange total order across the book/trade sockets.

| Frozen single-run market | Start to end UTC | Source logical WS messages | Original `manifest.json` SHA-256 | Original `messages.jsonl` SHA-256 | Complete book+trade seconds |
|---|---|---:|---|---|---:|
| `ws-v17-oct30-btc-01` | 12:36:00.238–12:36:08.247 | 131 | `06b81b5caaa9b3fce3a59331736ff115a20be1e9aeea8681e2f671c420065d6d` | `3bd6fc58545a4d9ba56f90becbabf795ac3428b89b1298bed9b8786f525a44a9` | 4/8 |
| `ws-v17-oct30-sol-01` | 12:37:10.758–12:37:18.759 | 110 | `5bf4aabc64f8732316c2f38dfa12b54d605e1af6fc31b7f3f3af037fbb89f65c` | `b963d59e33565a6f9c1f77b75143c1c939a8ecac06751e8a5756f6bcb596a75a` | 4/8 |

Exactly **241** original WebSocket logical messages were recorded across these two bursts. They are **two market-time sources**, **not four** independent financial observations despite checking two hypotheses on each.

## Source-only outcome: all four checks correctly abstained

Each previously registered exact AI proposal was locked *before* source start:

1. `flow-memory-flip-20261030`: taker flow sign flips between first and last four seconds but midprice continues the first sign.
2. `impact-efficiency-decay-20261030`: same-sign taker flow persists but signed quote movement per net taker contract decreases.

Both rules require **at least 6/8 complete one-second bins** containing both book and trade sources. Actual sources were 4/8 in both market windows. Hence the frozen quality rule returns `SOURCE_QUALITY_ABSTAIN` for every candidate on both BTC and SOL, with **zero eligible trading predictions**. Do not lower 6/8 after seeing the data to create artificial eligible signals. No future price was queried, no five-minute label was obtained, and no revenue/accuracy/profitability may be calculated.

All four source-only decisions are stored in immutable local research outputs:

- `ws-v17-oct30-btc-01-source-only.json`: SHA-256 `56ddf358c131e1cc17e4d3ecfeefa7ad6768a6a5a91e189d0f58c613d5a5f473`.
- `ws-v17-oct30-sol-01-source-only.json`: SHA-256 `0ebb51c57370200e186d12bdcc3e838196cbbf06ac1bcf6ad3e3f96cd3e8c9c6`.

Each file identifies original source SHA, two candidate-hypothesis ledger/proposal SHAs, precise source UTC, abstention reason, `realized_pnl=null`, `can_trade=false`, `can_start_paper=false`, zero future labels.

## Project and testing integrity

New research code `scripts/trading/algorithm_oct30_preflight_v17.py` and `test_algorithm_oct30_preflight_v17.py`. Dedicated research branch `research/algorithm-discovery-oct30-preflight-v17-2026-10-30`, Windows isolated worktree `C:/Users/eahra/rakazo-alpha-oct30-v17`. New exact source test suite **3/3 passed**; broad non-overlapping trading test sets **206 test_algorithm*.py + 26 test_[!a]*.py = 232 passed** in this new checkout. The remaining test_alpha* batch was previously safety-blocked in v16; do not assert complete all-suite proof or attempt a workaround.

The existing v12 immutable 60-slot November plan still has exact SHA-256 `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`, **unchanged**, with 0/60 November raw source records as of this day. This pilot is NOT counted toward its development, validation, holdout, or original 100-qualifying-event target. Active Trader/PAPER/real accounts, automation and main branch were not touched.

**Scientific interpretation:** Same-day manual research WORKS. The failure mode is short-window quality/data sparsity, not an inability to begin before November. The next separately preregistered source investigation should determine whether 8-second windows with `>=6/8` joint-second coverage are practicable, without relaxing data integrity after seeing outcomes. No proven profitable algorithm exists and authentic five-minute outcome prices are still to be established from real, trusted archival L2 evidence.
