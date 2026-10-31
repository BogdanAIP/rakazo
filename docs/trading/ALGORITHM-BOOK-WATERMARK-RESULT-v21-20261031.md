# Algorithm Discovery v21 — 31 October 2026: book-time watermark + fixed 3-second settling experiment

**Experiment ACTUALLY EXECUTED 2026-10-31 UTC on connected Rakazo Windows, manual and bounded, research-only.** Precommitted protocol `docs/trading/ALGORITHM-BOOK-WATERMARK-PROTOCOL-v21-20261031.md` in Git commit `f96f7ff65d1ba9c0b67d70f48b1e2e48e7e8fcd9`, **BEFORE both fresh sources**. The original v12 November 60-slot research calendar and prior v14/v15 mathematical hypotheses are untouched.

## Method and vital clock limitation

The predeclared experiment uses two **NEW** 15-second public `books` + `trades-all` WS recordings, BTC followed by SOL. Per original synchronized source receipt clock: 0–4s warm-up, 4–12s feature window, 12–15s fixed settling. Real decision time is at/after the end of the **full fifteen seconds**, not artificially +12s.

Both source files were independently reaudited for original manifest/raw-message SHA, source ordinals, book subscription ACK and full snapshot, book `seqId/prevSeqId` continuity, best bid/ask validity, individual trade IDs and timestamp sanity. The original 12s verifier was parameterized with a strict `expected_seconds=15` for v21; its default 12s behavior and tests remain unchanged.

A **single exchange-book-clock** proxy (not a scientifically proved exchange matching-order clock) was chosen before source retrieval: S is the last incremental book `data[0].ts` received before local source start+4s, E is last before +12s. The fixed feature-time interval is `[S,E)`. The audit counts received taker fills whose exchange execution time lies in that interval at the original +12s cutoff and after 3 extra seconds at +15s. Per-second coverage is reported only for book-watermark-covered exchange-time seconds; no retroactive selection of windows.

Two remote read-only `w32tm /query /status` attempts returned internal errors before any v21 source acquisition. **No independent Windows/exchange clock offset was established.** The previously observed common ~1.66s apparent difference from v20 was NOT subtracted as if it were certified network latency. Cross-connection total matching-engine order is not independently proven. Trades-all is not independently certified gapless.

## Two REAL new independent original market-time source recordings

Original immutable raw root:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`

| Evidence | BTC-USDT-SWAP | SOL-USDT-SWAP |
|---|---|---|
| Source raw folder | `ws-v21-oct31-btc-01` | `ws-v21-oct31-sol-01` |
| UTC original source start to end | 2026-10-31 05:25:29.569 – 05:25:44.578 | 2026-10-31 05:26:11.861 – 05:26:26.875 |
| Source duration | 15.009 seconds | 15.014 seconds |
| Original logical WS messages | **177** | **145** |
| Original manifest SHA-256 | `bfe0591e3b7687da32398da27377a67428084ffb2fc95a97b330d3ac10673cdd` | `2b590d1dabe57d57b738e1097ea92a64e43613de4ebf564136ff03397e8fdf0b` |
| Original `messages.jsonl` SHA-256 | `c5dff0e6676157f1b5e3580ca3ddb138e9bafe202473e7c35e146498eae310cd` | `2eb38a1142429d85c6f9a10836f0e74f0e4c4c2143e055999756e338eac583a5` |
| Fixed exchange book-anchor span E–S | 8000 ms | 8000 ms |
| Source-original individual taker fills with trade.ts in [S,E), available by +12s | **21** | **2** |
| Same set available by REAL +15s decision | **21** | **2** |
| **New feature-time fills recovered during fixed 3s settling** | **0** | **0** |
| Exchange-book-time seconds with at least one eligible received trade before settle | **5/8** | **1/8** |
| Seconds with trade after settle | **5/8** | **1/8** |
| Additional valid incremental book updates received during settling | 29 | 27 |
| All individual trade messages arriving during settling, regardless of feature window | 1 | 0 |
| Output original immutable local report | `ws-v21-oct31-btc-01-settling.json` | `ws-v21-oct31-sol-01-settling.json` |
| Report SHA-256 | `f455d6ee0b36c3f49fdd5237635f43ec4229fd096357cbaefddc54f9438c142f` | `95786c85303ebaf5a5e70c75af62b0382de1675d25a91cd0dc1a73cd04410bd1` |

Both original full 15s public WS sources passed audited original hash and book-chain checks. In the actual collection call for each market, the desktop tool returned an internal error **after** the bounded collection interval; however exact unique original folders with saved full source were already present. **No market recapture, retry-to-find-a-signal or overwrite occurred.** Subsequent separate OFFLINE source audit ran successfully and wrote each immutable report only once.

## Scientific interpretation, not performance

For the two captured samples, a fixed **3-second settling period recovered ZERO additional trades whose exchange event timestamps fit the book-derived feature interval.** BTC received one other trade in settling, but its exchange time did not fit that interval; SOL received none. The book feed continued streaming in settling for both.

Thus there is **no evidence from THESE TWO samples** that adding 3 seconds to the decision helps the completeness of the fixed feature observations. This is not proof that waiting never helps, not proof of synchronized exchange/book clocks and not a statistically powered independent test. No alternative settle duration was data-mined and no historical source was selectively repeated for better quality. The apparent 5/8 and 1/8 coverage values count **trade-containing exchange-book-time bins**, NOT the v14/v15 requirement of simultaneous book and trade updates based on the original eight-second source. Do NOT promote these counts into candidate trading signals.

**No v14/v15 predictions formed.** `future_price_labels_accessed=false`, `realized_pnl=null`, `can_trade=false`, `can_start_paper=false`. No authenticated five-minute later bid/ask outcomes or fee-adjusted return calculation exists; no profitable algorithm has been demonstrated.

## Code and regression tests

- `scripts/trading/algorithm_capture_15s_v21.py`: single bounded 15s public WS source capture, original v8 collector file untouched; no background service.
- `scripts/trading/algorithm_ws_12s_coverage_v18.py`: v21 branch parameterized exact 15s duration, retains default original 12s auditor.
- `scripts/trading/algorithm_book_settling_v21.py`: fully OFFLINE immutable raw replay / book exchange-time anchors / late historical taker receipts and true decision timestamp.
- `scripts/trading/test_algorithm_book_settling_v21.py`: **4/4** synthetic tests passed. An initial synthetic case accidentally simulated backwards exchange timestamps; the independent auditor correctly rejected it, and the fixture was corrected without weakening chronological guards. No production market data had yet been gathered at the time of this fixture fix.
- After real source collection: **224** tests matching `test_algorithm*.py` + **26** matching `test_[!a]*.py` = **250 executed tests, all passed**, on v21 separate worktree. The additional `test_alpha*.py` group previously blocked by tool safety was not rerun and is NOT counted in the 250.
- Current results and unchanged Nov v12 original plan SHA-256 `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf` were checked on the Windows research host.

## Recommended next independent experiment (DO NOT launch implicitly)

A realistic **v22** method must first independently observe/calibrate the computer's time synchronization and collect more independent market days. If using a waiting or event watermark, a new registered candidate should define source feature boundaries **and the true delayed decision time** before new sources. The outcome must reference later authentic L2 best bid/ask, with fee/lot/slippage scenario, rather than an earlier clock cutoff. Any use of the v21 data to select an ideal settle period is exploratory and must not be counted as independent confirmation.

**All v21 work was manual via connected ChatGPT/Rakazo; laptop may be off between sessions. v12, Trader, PAPER, live accounts, main, paid services and schedules unchanged.**
