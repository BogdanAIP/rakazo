# P3 — Bounded public multi-altcoin sweep

Status: dependent implementation branch / research only. Relies on PR #3's typed public data and closed-candle breakout baseline.

## What this adds

- Authenticated Plugin R read procedure: `trading/sweep`, no keys, wallet signer, order interface, scheduled Worker job or live account.
- Discover **the whole available OKX SPOT catalog dynamically** (including altcoins), retrieve public spot 24h tickers, filter by explicit allowed quotes, 24h quote turnover, bid/ask spread and data freshness.
- Sort filtered candidates by **24h quote-volume for bounded sampling only**, not by expected return, then analyze up to `maxInstruments=5` sequentially from public confirmed 1H candles (default = 3).
- Each inspected instrument preserves its result: research-only conditional proposal or `NO_TRADE`, evidence, version, time and limitations. Unavailable/malformed price histories are **listed separately**, never replaced with invented data or another symbol.
- If last historical close and current spot bid/ask midpoint diverge by over 5%, do not expose the historic conditional entry as a current candidate; list that symbol as unavailable. This is a conservative safety filter, not a trading rule or an expected-profit metric.
- If ticker snapshot expires while a sweep is running, the whole response fails closed; never show a stale market sweep as current.
- HTTP count per user-invoked operation: three fixed OKX public instrument GETs + one fixed spot ticker GET + at most five single-symbol public history GETs, **sequentially**. Requests have timeouts, limits and redirects denied in the underlying adapters. No background polling, auto-repeat or bulk derivatives scans.

## Example for future deployed Rakazo Plugin R

```json
{"procedure":"trading/sweep","input":{"allowedQuotes":["USDT"],"minQuoteVolume24h":100000,"maxSpreadBps":40,"maxDataAgeMs":60000,"maxInstruments":3}}
```

The numeric thresholds are exploratory user-configurable prefilters, **not** endorsed live-trading risk limits.

## Exclusions

- No futures opportunities yet; the earlier OKX futures catalog is discovery-only, and the P2 single-instrument research can treat perpetual futures as conditional research only. Futures sweep requires unit-correct quote liquidity, mark/index checks, funding, open interest, contract face-value, settlement and liquidation scenarios.
- No ranking or financial recommendation based on purported AI confidence scores. No strategy fitting, fees/funding-aware backtest, portfolio optimization, independent risk manager or verified alpha yet.
- A successful API response does **not** establish regional, KYC or product eligibility for a particular person. VPN access is not permission to circumvent a platform's rules.
- No real-world exchange call, user computer access or funds were needed for development; fixtures are synthetic.

## Acceptance

Unit tests verify dynamic universe (not BTC-only), bounded sequential GET count, a proposed baseline and an abstention side-by-side, explicit unavailable results for failures, and rejection of historical entries diverging from current quotes. The exact head must pass package typechecks/unit tests and Biome for newly modified files before promotion; unrelated upstream CI failures must remain separately attributed. No automatic merge or deployment.
