# Algorithm Discovery v23 — registered temporal-response mapping, not a 5-minute trading strategy

**Created 2026-10-31 BEFORE v23 replay/feature/outcome extraction.** This is DEVELOPMENT / exploratory hypothesis-testing of temporal response on ONE already-existing official OKX archive, not independent validation and not prospective alpha. There is no claim that these patterns are genuinely novel in financial science. We intentionally do NOT use previous hand-inspected 2026-09-02 12:00→12:05 quotes or the surrounding time block to select a horizon.

## Fixed genuine input and structural limitations

Offline original public official OKX 400-level L2 `NEAR-USDT-SWAP` UTC 2026-09-02, tar SHA-256 `33ee27aa5d740255ef01f76f3a7183606e2f5bff6898931605857906b55bf337` and uncompressed `.data` SHA-256 `e15dc177dc4a4e6ee6df2813d79c62e2b34a161fea9d9d4641df8e54fa7bb06b`, obtained in v22 before v23, preserved in `alpha-research/official-l2-v22/NEAR-2026-09-02/`. Source contains 400-level `snapshot` and incremental `update` NDJSON with exchange `ts`, `bids/asks` price + size. **No trade/taker flow**, so this experiment does NOT retest v14/v15 taker-flow hypotheses, and must NOT treat book delta as an executed trade. No source seq IDs: the archive's losslessness cannot be independently proved.

Use original bounded, SHA-anchored v22 decompressed spool to replay *only through the latest needed horizon*, respecting actual snapshots/updates, deletion qty=0, bid<ask, event nondecreasing time; never use first event after target as its quote. Quote availability requires `0 <= target-exchange_asof <= 5000ms` AND `0 < first_next_exchange_ts-target <= 5000ms`; otherwise explicit UNAVAILABLE outcome. No borrowing candle OHLC, forward filling stale quotes or trading-order assumptions.

## ALL freeze choices prior to new historical study evaluation

**Anchor selection**: two development blocks on the same day, inclusive every 15 minutes:
- 2026-09-02 UTC **02:00 through 09:00** inclusive (29 anchors).
- 2026-09-02 UTC **14:00 through 21:00** inclusive (29 anchors).

Exactly 58 fixed anchors, none within 10:00–14:00, thus excluding previously manually inspected noon price example and a surrounding buffer. Every anchor is chosen by timestamp, not known market movement, spread, liquidity or signal strength.

**Pre-signal feature times**: EXACTLY `t-30s` and `t`. The feature is constructed at `t` from bid/ask and top-of-book displayed sizes only, with an as-of quote strictly before any event AFTER `t`. No volume of future updates is used to select the feature.

**Eight outcome horizons**: 10, 30, 60, 120, 300, 900, 1800, 3600 seconds. The original 5min=300s is ONE of EIGHT comparisons, not favored in optimization. All eight outcomes are retained and displayed, including negative values and unavailable observations. Horizons are nested, overlap in time, and are NOT eight independent observations per signal. Some forecast windows from adjacent 15m anchors overlap; 58 anchors in one UTC day are NOT independent market-days.

**Candidate 0 — descriptive baseline (not an AI invention):**
`I_t=(best_bid_size_t-best_ask_size_t)/(best_bid_size_t+best_ask_size_t)`.
If `I_t >= 0.30`, direction long; if `I_t <= -0.30`, direction short; else abstain. This is a simple top-of-book imbalance baseline for temporal-response calibration, not a novel algorithm.

**Candidate 1 — original exploratory 'liquidity-pressure shock without contemporaneous price adaptation' condition (not proven novel):**
`dI=I_t - I_{t-30s}`, `mid=(best_bid+best_ask)/2`, `delta_mid_30s_bps=10000*(mid_t/mid_tminus30-1)`. If `|dI| >= 0.50` AND `|delta_mid_30s_bps| <= 3.0`, direction = sign(dI), else abstain. Economic hypothesis to falsify: sudden quote-side pressure change without proportional immediate midquote adaptation may predict later direction. This is a PREDECLARED illustrative candidate, not an asserted new alpha.

Both candidates produce direction long/short/ABSTAIN at t. Counts and source quotes are stored for all 58 anchors. No after-the-fact tuning of 0.30, 0.50, 3.0 or horizons based on v23 results. Both candidates applied to same anchor are not independent events. Abstentions excluded from fee-summary denominator but still reported, not reclassified as losses/wins.

**Economic proxy per eligible direction:** long buy at anchor ask, sell at horizon bid; short sell at anchor bid, buy back at horizon ask, using archived top of book. Report signed midprice movement in bps separately from crossing-spread gross proxy and hypothetical fee deductions with pre-fixed 5bps PER SIDE baseline and 7bps PER SIDE stress (v16 formulas). No realized fills/PnL/funding/impact/lots/actual account fee or execution certainty.

**Summary** for every candidate/horizon: anchors_total58, eligible, complete scored, missing outcomes, mean signed midquote bps, gross crossing quote bps and assumed net bps, plus median net and positive net fraction. NO confidence interval claiming independence, no significant p-values, no optimization that picks a best horizon as a validated strategy.

## Reproducibility and fail-closed behavior

Implement separate `scripts/trading/algorithm_temporal_response_v23.py` with immutable, SHA-chain-bounded checkpoints and a sidecar result file. Each checkpoint contains original uncompressed byte offset, book state, target quote status and processed events; original tar/SHA/receipt rechecked. Staged replay by explicit manual calls only (max100k events and <=10 seconds each), no daemon, no paid data, no private endpoints, no current market REST query, no orders/PAPER. Tests must demonstrate no target quote lookahead, fixed anchors/horizons, no trade inference, fee math sign direction, missing data handling, no checkpoint tampering, no overwrite.

**Interpretation guard:** This **ONE-DAY** historical source response map is an exploratory engineering and research demonstration. Even if either hypothesis has an interesting horizon profile, it is NOT evidence of durable profitability until prospectively frozen and replicated across independent days/assets with independent historical L2 sources and a true holdout not used during discovery. Preserve existing v12 Nov1–12 calendar, all v14/v15 frozen hypotheses and production Trader/PAPER, main, credentials, paid sources and automations unchanged.

**If no eligible observations, report all abstentions and stop; do not retroactively loosen conditions.**
