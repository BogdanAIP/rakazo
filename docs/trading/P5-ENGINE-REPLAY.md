# P5 — External engine evaluation and deterministic offline accounting

Status: DRAFT. No running trading engine, exchange keys, orders or new local service.
Baseline dependency: P4 public perpetual context, then standalone **pure core function** `replayExplicitTradingFills()`. This PR creates a reusable evaluation contract; it does **not** assert market-beating returns or simulate real order fills.

## What to reuse instead of reimplementing

| Candidate | Verified official functionality | Integration intent / blocker |
| --- | --- | --- |
| Freqtrade | Historical backtesting, fee option for entry/exit, dry-run, spot and futures, Telegram/webUI; lookahead-analysis and recursive-analysis | First comparative external experiment runner behind a **Rakazo-owned adapter**. GPL-3.0: do not copy/link source into Apache-2.0 Rakazo without a separate license review. Dry-run is not identical to exchange execution. |
| FreqAI | Feature engineering, target labels, periodically retrained ML, historical backtests emulating periodic retraining | Optional offline model experiments after a simple deterministic baseline, time-series leakage guards and resource measurement. Not a real-time privileged agent. |
| Hummingbot | Apache-2.0 modular CEX/DEX connectors, maker/algorithmic bots and Gateway ecosystem | Second comparative research track when we test order-book and DEX/maker behaviour. Keep its lifecycle managed by Rakazo; do not run independent autonomous control loops. |
| Rakazo | Existing permissioned control plane, Plugin R, Worker, events, audit and Windows Host | Owns experiment identity, read-only artifact registry, risk approvals and future supervised paper service. Not replaced by another framework. |

Official sources (revalidate version and terms before installing):
- https://www.freqtrade.io/en/stable/
- https://www.freqtrade.io/en/stable/backtesting/
- https://www.freqtrade.io/en/stable/strategy-101/
- https://www.freqtrade.io/en/stable/lookahead-analysis/
- https://www.freqtrade.io/en/stable/freqai/
- https://github.com/freqtrade/freqtrade/blob/develop/LICENSE
- https://github.com/hummingbot/hummingbot
- https://hummingbot.org/

## Offline accounting contract (current implementation)

`packages/contracts/src/trading-replay.ts` defines an explicit dataset ID, immutable algorithm/strategy versions, one quote currency, consecutive **non-overlapping** historical fill scenarios and fully specified fee/slippage assumptions. It enforces `decisionAt < enteredAt < exitedAt` to reject same-time signal/fills and disallows leverage in this initial experiment. Report includes entry and exit adjusted fill prices, gross PnL, adverse slippage impact, round-trip taker fees, cash funding per actual settlement and equity after each closed trade.

- SPOT long: **no funding**; future long/short: **mandatory historical fundingCoverage** for entire holding period. An independently constructed, source-verified settlement calendar must establish `expectedSettlementTimes`; each must have exactly one aligned historical funding rate **and mark price**. No missing rate may default silently to zero.
- Signed settlement rate: long funding cashflow = minus position-base-quantity × event mark price × rate; short is opposite. This is a research approximation for a linear quote-settled perp only. Do **not** feed an inverse or quanto product without another tested accounting adapter.
- Fees are explicit bps on entry and exit executed notional. Price slippage is adversarial to both sides. Position sizing is reference quote-notional divided by the adjusted entry price. The result is deterministic from the supplied fixture and bounded arithmetic.
- Equity and maximum drawdown here are based only on **realized exits**, not intratrade margin/liquidation or mark-to-market drawdown. No gas, borrow, taxes, idle cash return, partial fills, market impact, spread/liquidity dynamics, contract lot-size rounding, exchange-specific execution restrictions or perpetual liquidation mechanics are simulated.
- `datasetSha256` is a caller-supplied identity, **not cryptographic proof of fixture integrity** unless a separate external runner computes it from canonical historical input and verifies it.
- No actual strategy entries are generated in this module. Next runner must derive fills strictly from point-in-time signals using the following bar's open or a documented executable price proxy, with a fixed universe including delisted assets and a deterministic funding calendar. It must preserve train/validation/test splits and allow no-trade benchmarks.
- Do not import code from GPL dependencies into this package. Consume versioned external backtest outputs through a documented data-only bridge only after attribution/license review.

## Acceptance and next stage

Tests use synthetic fixture data for entry/exit fees, cost comparison, positive and negative funding for longs/shorts, missing/wrong-date settlement fail-closed, chronology, duplicate IDs, quote mixing, no-leverage and realized drawdown. Require exact-head CI and independent results; neither past performance nor synthetic green tests prove a tradable edge.

Following stacked stage: **pure paper decision policy** with explicit user-configured risk envelope and independent kill switch. Paper order intents stay typed `paper_only`; no exchange transport and no API key. Only after forward tests, reconciliation and human permissions should a live adapter be considered.
