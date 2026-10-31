# Algorithm Discovery v25 — AFTER-THE-FACT investigation of extreme quote moves (NOT a prediction test)

**2026-10-31. This is deliberately a POST-RESULT EXPLANATORY STUDY, because the source events were chosen AFTER observing the v24 60m hypothetical profit outcomes. Never relabel these as precommitted forecasts or independent alpha validation.**

## Immutable historical source

Use the already downloaded and checksum-anchored NEAR-USDT-SWAP 400lv official OKX 2026-09-03 and 2026-09-04 orderbook `.data` archives, their v24 immutable on-host original source receipts and per-day replay checkpoints. Nothing is downloaded or evaluated on the untouched v24 reserved date 2026-09-05. No new market data or trade API is required. There is no `trades-all` feed in these historical L2 sources. Book posted sizes **are NOT executed buy/sell volumes**. Book events include no reliable actor identities, causal trigger, independently proved exchange update gaplessness or signed content.

Prior registered v23 pressure-shock signal: absolute 30s change of top bid/ask quantity imbalance >=0.50, price mid drift <=3bps, signal long if positive; 60-minute exit was only one of eight horizons and was NOT shown robust. Two particular highest 60m outcomes:
- **2026-09-03 14:45:00 UTC**, long; v24 +228.22 bps fee5/side historical quote-crossing.
- **2026-09-04 19:15:00 UTC**, long; v24 +408.72 bps fee5/side historical quote-crossing.
Examine alongside **two negative or weak nonwinner pressure-shock anchors** chosen post hoc as explanatory controls:
- **2026-09-03 08:45 UTC**, long; v24 −41.87bps/60m despite a strong bid-size increase.
- **2026-09-04 07:30 UTC**, long; v24 −50.53bps/60m.
These four cases DO NOT form a representative or randomly sampled cohort; they are qualitative contrast examples, explicitly outcome-selected. Full 23 eligible shock signals on both days must also be retained and compared descriptively via exact v24 immutable outputs, not selectively omitted.

## Diagnostic windows and indicators (fixed now for reproducibility, not for statistical validation)

Use each signal's original actual exchange event-time, and restore the immediately preceding bounded original replay checkpoint state whose event time is strictly before signal minus10min; never use a later checkpoint. Replay original chronological `snapshot/update` records from that checkpoint, including complete snapshot resets and absolute qty changes for each level, without reading any future record into earlier as-of book state.

As-of targets (all relative to signal): −300, −60, −30, −10, 0, +10, +30, +60, +300, +900, +1800, +3600 seconds. The first record AFTER a target may be used for timestamp coverage bracket only, never its post-event book levels. Max age5s and future bracket5s. Report at each target: best bid/ask and sizes, mid, spread bps, top5 bid/ask displayed depth and depth imbalance; when present, report as-of source timestamp and quote age. Count incremental original book UPDATE frames and absolute-size-level increases/decreases in fixed event-time windows [−300s,−30s), [−30s,0), [0s,+300s), [+300s,+3600s). Full snapshots separately counted; do not interpret quantity reductions as executed trades, actual cancel orders or market sells/buys. Report original source checkpoint SHA and archive SHA. Stop if invalid sequence, timestamp reversal, crossed book, as-of stale quotes, missing source or tampered hashes.

For all 23 frozen v24 shock sources across the two dates, show the distribution of bid-size multipliers and 60m outcome, including losers and winners. DO NOT introduce a new rule based on the observed best case and then report its historical return as an unbiased prospective strategy.

External contemporaneous headlines can be consulted for **hypothesis generation only**; a general article about September 4 volatility is NOT proof it caused the exact 19:15 UTC NEAR move. Additional necessary sources to establish a mechanistic trigger would be independently timestamped taker trades, NEAR open interest and funding, verified liquidation prints, BTC/ETH market regime, and accurately timestamped specific news/social announcements; none of these is available inside the cached 400lv orderbook.

Result status MUST be `POST_HOC_EVENT_ATTRIBUTION_HYPOTHESIS_GENERATION_ONLY`, with `causal_attribution_established=false`, `novel_alpha_validated=false`, `can_trade=false`, `can_start_paper=false`. Never touch original v12 November plan, existing v23/v24 candidate rules, Trader/PAPER/main, or Sept05 holdout.
