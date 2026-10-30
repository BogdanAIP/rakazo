# Algorithm Discovery v18 — new 12-second BTC/SOL WebSocket source-coverage evidence

**UTC 2026-10-30. Manual read-only source collection completed; no account/PAPER/trading actions.** Preregistered v18 acquisition and diagnostics in `docs/trading/ALGORITHM-SOURCE-COVERAGE-PROTOCOL-v18-20261030.md` (first Git commit `8c5202f3d87aacfc5e57a7254b63066c5395a45d`) **BEFORE** either new 12s source. Original v17 source-only abstentions not recomputed or removed, original v12 November research plan and two v14/v15 AI hypotheses unchanged.

## Two independent new source recordings, ONE per predeclared symbol

Existing `algorithm_ws_capture_v8.py` unmodified; separate bounded v18 wrapper selects its process-local 12s duration and saves original logical WebSocket book+trade messages, source receive timestamps and SHA. New independent 12s auditor `algorithm_ws_12s_coverage_v18.py` replays original per-source ordinal, per-frame SHA, both subscription ACKs, original full book snapshot, every book delta sequence `prevSeqId→seqId`, non-crossed book, unique individual taker tradeIds and source UTC/monotonic clocks. Exactly two 12-second sessions; no favorable retries.

| Raw folder | UTC start — end | Duration | Original WS logical messages | Manifest SHA-256 | Raw messages SHA-256 |
| --- | --- | ---: | ---: | --- | --- |
| `ws-v18-oct30-btc-01` | 12:44:14.951 — 12:44:26.965 | 12.014 s | 436 | `85b4888a085452e189bbef28e84aec89443f2dbc833af3a63e5c2859a9d439b6` | `46625c77050beac1453e4599b9fffcbf4fb49ffcb6b4393324bd8e208d6ec2fa` |
| `ws-v18-oct30-sol-01` | 12:44:45.844 — 12:44:57.855 | 12.011 s | 180 | `e21cc763d6993d044cf6aeb99f028a4709f0fe5e055756c411a5c09d4a98d1c6` | `e5ba926edbe0e964e5847fc467939c3281d5fb2cfb879968a9066e80c26dd44f` |

Both original sources pass independent source audit. Combined **616 original logical messages**. Book sequence is verified, but per-fill `trades-all` does NOT provide a gaplessly certified full history or exchange-certified total ordering against book messages.

Windows private local raw source root: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures`. Both source folders are located there, with their original `manifest.json` and `messages.jsonl`. Audited reports alongside:
- BTC `ws-v18-oct30-btc-01-coverage.json`, exact SHA-256 `65e38658faff78672b86006bf96867702d82913dbed97115a80f416612e01080`.
- SOL `ws-v18-oct30-sol-01-coverage.json`, exact SHA-256 `edd406baa0a623f591f051357a0d67101a4cc008bfd6b7a66f5ee2d4c9594e8d`.

## Main *source quality* diagnostic

| Measure | BTC | SOL |
| --- | ---: | ---: |
| Complete 1s bins containing both book update and individual taker fill | **11 / 12** | **10 / 12** |
| Fixed full-window fraction | **91.67%** | **83.33%** |
| Book-only seconds | 1 | 2 |
| Trade-only seconds | 0 | 0 |
| Neither-book-nor-trades seconds | 0 | 0 |
| Incremental book updates counted inside 12s | 120 | 119 |
| Received, timestamp-gated individual taker fills | 185 | 54 |
| Book+trade joint-second counts across the **five PREDEFINED overlapping 8s windows** [0..7,1..8,2..9,3..10,4..11] | **[7, 8, 8, 8, 8]** | **[6, 7, 8, 8, 8]** |

The BTC 0th second had ten book updates but no accepted taker fill; all seconds 1..11 had both. SOL seconds 0 and 1 had ten book updates each but no accepted taker fill; seconds 2..11 had both. Therefore there is no evidence of lost book subscription, and the prior v17 4/8 results can be affected by sparse coincident fills in short windows and market timing rather than total source failure.

**Important caution:** the five 8s windows overlap heavily; they cannot be treated as independent observations or selected by maximum apparent quality to fabricate signals. This was a DATA COVERAGE study and no v14/v15 8s prediction was made from the new 12s recordings. Earlier v17 BTC and SOL each had 4/8 joint seconds on separate windows; comparing them with v18 is descriptive only, **NOT** a randomized experiment proving that longer windows cause improved coverage. An 8-second prediction cannot be automatically inferred from 12s without predeclaring a fixed 8s subwindow selection and preserving its true decision time.

## Software integrity

New code `scripts/trading/algorithm_capture_12s_v18.py`, `scripts/trading/algorithm_ws_12s_coverage_v18.py`, synthetic test `scripts/trading/test_algorithm_ws_12s_coverage_v18.py`. All 3 new tests passed prior to first v18 capture. After all recordings, regression checks passed in two **nonoverlapping** groups: **209 tests** matching `test_algorithm*.py` and **26** matching `test_[!a]*.py`, totaling **235/235 checks executed and passed**. Prior `test_alpha*.py` group was safety-blocked in v16 and not rerun, so do not report full-suite testing as completed here.

The untouched v12 November plan SHA is `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf` and none of today's raw sources enter that calendar, development, validation or holdout. Existing active Trader/PAPER/main, paid services, private APIs and automated schedules were not changed.

## Next separately frozen technical step, no hindsight

Before collecting **another** raw public source, prospectively register a deterministic transformation of a 12-second capture into **one fixed trailing eight-second slice** (indices 4..11), which uses first four seconds only as a book-state warm-up. Restore last-known bid/ask from the original book replay, include valid per-fill taker flow and report exact snapshot age and tail decision time. Verify full source SHA and book sequence. Do not retroactively create profitable predictions from v18, do not select best of five overlapping windows. This would allow application of existing two v14/v15 source-only rules without weakening their >=6/8 threshold. Still requires independent authenticated future quote labels, bids/asks, realistic fees/contracts, broader multi-day holdout and cost-aware inference before any trading/alpha claims.

**Verdict:** Same-day manually invoked 12-second public-source acquisition is functional and has materially better observed per-second joint data coverage in these two captures. **No qualifying alpha, no future price labels, and no measured returns.**
