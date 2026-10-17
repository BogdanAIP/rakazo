# P7 — Closed-candle spot walk-forward runner

Status: separate stacked **DRAFT** branch after PR #7. Pure deterministic offline research only: no exchange key, account access, user-machine update, live API, paper order or scheduled task.

## Verified prior work

- P2 `researchClosedHourBreakout()`: prior 20 confirmed 1H bars determine high/low, mean quote volume and range; the latest closed bar is the *test bar*, never included in its own preceding baseline.
- P5 `replayExplicitTradingFills()`: records supplied after-decision fills, explicit entry/exit fees, adverse slip, separate quote equity and realized-only drawdown.
- P6 `evaluateTradingPaperRisk()`: still an entirely separate inert research preview; a historical successful experiment **does not authorize** even a virtual paper order.

## New strictly defined experiment

`runSpotCandleWalkforward()` takes 22–250 chronological, contiguous, confirmed OKX **spot** hourly candles for exactly one instrument, explicit initial virtual quote balance, fixed notional, fee/slippage assumptions, max allowed opening gap and a caller-supplied dataset identifier. First 20 bars form the prior baseline. Starting with bar 21:

1. At exactly its close, analyze only the 20 prior bars plus that newly closed bar. `NO_TRADE` adds no virtual fill.
2. After a research-only spot-buy proposal, test only the **next bar OPEN** as an entry-price proxy; assign a notional synthetic fill time +1ms relative to that open so it is strictly after the signal. This is a modelling convention, **not** proof of executable 1ms latency. Reject when next open has not reached the trigger, already exceeds the illustrative target, breaches the chosen opening-gap limit or invalidates the stop.
3. Only after deciding entry from open, use the next bar's complete OHLC for its exit, never for its signal. If both stop and target fall within its range, choose **stop first** to avoid optimistic intrabar ordering. Otherwise target if touched, else exit at that bar's close. No positive target opening-gap improvement or invented intrabar sequence.
4. The resulting historical scenario passes through the independent P5 fee/slippage accounting. A missing/failed fill has **no invented return**: zero executed trades yield `replay=null`; counters separately record candidate signals, NO_TRADE and skipped entries.
5. Declines mixed/gapped instruments, bad OHLC, unsupported derivatives, notional above initial virtual funds, missing cost assumptions, currency/chronology/precision errors and P5 balance exhaustion.

## Explicit limits and further gates

- This **one-next-bar horizon** is a controlled proof of a point-in-time experiment, not a claim that a breakout strategy should always exit after 1 hour. It does not model order-book queues, maker/taker fill probability, stop slippage beyond the explicit assumption, gap-through-stop after later bars, partial fills, mark-to-market, taxes, delisted-history universe selection, continuous portfolio exposure or futures funding.
- The next bar's open is a price proxy rather than an immediately executable real order. Entries are after signal creation by model convention only. Actual forward paper service needs a timestamped quote/book snapshot, persistent reservations, durable journal, recovery and independent risk checks.
- The supplied SHA-256 dataset ID is **not** a calculated integrity proof; the future canonical ingestion pipeline must compute the content digest itself, preserve source, listing/delisting and missing data and version the entire historical universe.
- Out-of-sample comparisons require frozen strategy parameters, fixed train/validation/test temporal splits, fees and negative regimes, a no-trade baseline and a published coverage/rejection log. Backtest returns are not forecasts or financial recommendations.
- Futures expansion must separately validate exact contract face value, settlement currency, funding **history** and complete calendars, mark/index basis, liquidity and liquidation stress. No synthetic zero funding.

## Acceptance criteria

Tests: same-bar stop+target conservatively stop-first; target alone; exit on next-bar close; no entry after below-trigger or excessive gap; flat market NO_TRADE with null replay; chronological decision before entry; rejection of gaps, mixed instrument, unsupported futures, absent cost inputs and initial borrowing. Verify exact-head TypeScript, unit, Biome, Windows Host/API and integration CI. Do not merge/deploy automatically.
