# Algorithm Discovery v27 — preregistered post-hoc market beta controls and OI provenance

2026-10-31. Created and committed **BEFORE requesting any new BTC/ETH/NEAR minute OHLC records or historical open-interest rows**. We already know the 4 outcomes from prior v24/v25; this is a POST-OUTCOME CAUSAL-MECHANISM DIAGNOSTIC, NOT new out-of-sample prediction or algorithm validation.

## Four frozen original L2 shock examples (already outcome-selected)

- 2026-09-03 08:45 UTC: NEAR-USDT-SWAP long shock, historical 60m proxy loss.
- 2026-09-03 14:45 UTC: NEAR long shock, historical 60m proxy strong win, actual taker buying confirmed.
- 2026-09-04 07:30 UTC: NEAR long shock, historical loss.
- 2026-09-04 19:15 UTC: NEAR long shock, historical strong win; **original Sep05 UTC+8 tick-trade archive deliberately NOT accessed to preserve Sep05 UTC holdout**.

BTC-USDT-SWAP and ETH-USDT-SWAP are **predeclared unweighted cross-market controls**. NEAR is the subject. No choosing another coin because of its realized outcome or price direction. Same venue/instrument type. We use historical **1-minute candle CLOSE** to compare directions, NOT bid/ask to claim realistic trade PnL. The last strictly completed minute before a signal at T is minute candle starting `T−1minute` (bar close at T). At every comparison target `T+offset`, use the exactly completed minute candle starting `T+offset−1minute`, never the candle starting at T+offset (which contains future prices). Relative offsets fixed BEFORE reading new candle data: -30m, -5m, 0m, +5m, +15m, +30m, +60m. No candle-to-book fills.

Price return for each asset on each horizon h: `10_000 * (close(T+h)/close(T)−1)` bps, and lookback `10_000 * (close(T)/close(T−lag)−1)`. For each h, **fixed control market** `(BTC_bps+ETH_bps)/2` (not a fitted regression beta), NEAR **excess** `NEAR_bps−fixed_control_bps`. This is a simple equal-weight divergence, not an estimated causal factor or financial regression residual, and a small positive difference does not prove NEAR-specific news.

## Immutable historical data retrieval rules

First attempt **public historical** OKX `GET /api/v5/market/history-candles` with `bar=1m`, `instId` only one of the three exact frozen IDs, `after=T+65min` milliseconds, `limit=100`. This is NOT `/api/v5/market/books` (previously blocked live REST); we will NOT probe a previously denied live quote endpoint. Twelve bounded, read-only REST requests maximum (4 events ×3 assets), **one request per event/asset, no retry on rate/error**, max12s HTTP timeout. If a request fails, record `SOURCE_UNAVAILABLE` and do not substitute a different market, date or synthetic candles. Reject any returned UTC timestamp outside the single explicitly selected day and within/after Sep05 (holdout), missing/duplicate minute bins, OHLC inconsistent, unsupported schema or wrong symbol. Preserve original JSON bytes and HTTP source URL/status/headers/SHA in immutable on-host research folder; do not publish large raw sources.

If historical REST is unavailable, consult official historical **module2** catalogue, dateAggrType daily, UTC+8 archival convention. However do NOT download the UTC+8 Sep05 archive as its content would overlap the reserved Sep05 UTC holdout. Do not silently mix coarsened daily articles with 1-minute quotes.

## Open interest and liquidations

Separately, one read-only request per EVENT against official `GET /api/v5/rubik/stat/contracts/open-interest-history` for NEAR-USDT-SWAP `period=1H`, `end=T+120min`, `limit=100`; preserve true UTC timestamps if returned. If historical requested Sept03/04 records are absent or the endpoint returns only newer data, report **UNAVAILABLE**. The endpoint is limited to most recent 1,440 records by provider; do not infer history exists just because endpoint exists. An hourly OI point with ambiguous completed-bar timing must not be promoted to a known-at-14:45 observation without proving publication semantics. Price+OI change cannot distinguish who opened/closed a contract or prove liquidation.

**No historical original OKX NEAR liquidation-per-minute file was independently established.** Provider's liquidation-orders public WebSocket transmits RECENT events and explicitly warns it is not all liquidations. Do not use live snapshot as historical. Third-party completed hour totals are hindsight, not signal-time data. Report `LIQUIDATION_HISTORY_UNVERIFIED` unless independently authentic timestamped historical data exists. No claims of short squeeze, spoofing or venue misconduct.

## Method and source-integrity checks

Maintain UTC and complete-bar gating (lookahead), units bps, source provenance and counts. For missing data leave numerical cells NULL and include cause. No arithmetic from candle high/low as if those were tradable entry/exit. Compare original four scenarios as **post-hoc examples**; do NOT infer statistical significance from 4 cases. Aggregate cross-market control over three-minute pre-event etc only descriptively. No confidence/PnL or eventual model training under this study.

New code/test/output should reside in separate research branch `research/algorithm-discovery-crossmarket-v27-2026-10-31`; on-host sources remain private, immutable and SHA-bound. The separate Oct/Nov v12 60-slot plan, v14/v15 source-only hypotheses, active Trader/PAPER/live, main, credentials, paid subscriptions and automations unchanged. No background/scheduled work or real orders.
