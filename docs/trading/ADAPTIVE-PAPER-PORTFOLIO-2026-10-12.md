# PAPER Portfolio Manager: adaptive exposure and portfolio-level risk (2026-10-12)

## User-approved experimental mandate

- Apply to all three independent 1,000 USDT PAPER profiles, not only aggressive.
- Aim to *measure*, not promise, geometric average daily return across the complete evaluation: conservative **1%**, moderate **2%**, aggressive **3%**. These are stretch research targets, NOT observed returns, guaranteed results, hard triggers to take trades, or intraday trading quotas.
- Calendar days with no trades still count; allow multi-day holds. Report strategy start/end equity, realized/unrealized PnL, funding, maker/taker fees, drawdown, win/loss distribution and all days, not only days with trades.
- Position sizing is decided by the configured model and must pass independent deterministic portfolio-wide risk checks. Do not maximize position size for its own sake.
- Decisions to wait, partially reduce, close, scale in or hedge should compare full-portfolio opportunity cost, liquidity and correlation. Long/short hedge legs remain distinct; hedging spends gross exposure and maintenance margin.
- An abrupt wick / liquidity sweep can trigger a poorly situated tight stop. Stops should reflect volatility and market structure, but **never simply disable the only enforceable loss boundary during a losing trade**. Temporary stop modification would require a separate explicit audited control, fresh market evidence and risk approval, independent catastrophic protection, and replayable tests. No change in this branch disables existing protective exits.
- Owner-controlled start/stop only. PAPER only; no exchange credentials, live order router or 24/7 auto-start.

## Implemented first slice on this branch

The existing futures risk preview now uses the verified native simulator **marked equity** and **gross current exposure** instead of the legacy static SPOT cap (500 / 1,000 / 1,500 USDT). Spot accounting and spot caps are untouched.

Stress guard rejects a proposed futures entry unless positive stressed equity remains **strictly greater than 25% of current marked equity** under a simultaneous adverse market move applied to **all gross positions and the proposal**, plus at least a **2% gross notional** margin buffer (or larger current contract maintenance rate).

Initial deliberately conservative *research parameters*:
- Conservative: 35% adverse gross-price shock.
- Moderate: 25% shock.
- Aggressive: 20% shock.

This simple fixed stress scenario does not predict actual stop fills, hedge path, margin tiers, funding or exchange liquidation; it cannot guarantee liquidation is remote. All existing per-idea/daily/concurrent loss caps, position count, leverage limits, lot sizing, verified venue limits and actual initial-margin checks remain enforced separately. Current static SPOT cap stays in existing account profiles for historical / spot compatibility, but the futures model prompt no longer receives it as a futures constraint.

**Additional implementation on this branch:** all same-symbol, same-direction scale-in lots now share one per-idea stop-risk budget (5/10/20 USDT), including the independent legacy fallback preview. A new AI `reduce` decision is accepted by the schema and the native worker can submit an existing position's explicitly bounded reduce-only market exit; the post-fill protective plan's remaining risk is scaled down. A partial exit does not free a position slot until that position is fully closed. This feature requires exact-head CI and an additional worker-level live simulation journey before deployment.

**Important limitation**: position quantity, stop and hedge intent are still model-supplied and independently vetted. The stress guard is a coarse gross-risk approximation and deliberately does NOT implement automatic add-to-existing-position, active stop amendments, hedging when all four slots are occupied, or rolling portfolio optimisation. Existing same-side proposals may open another position lot if there are free slots and remaining shared idea risk.

## Required second slice (NOT done)

1. Complete the bounded portfolio decision schema: the native `reduce` intent and shared same-side idea risk now exist, but worker-level integration tests and journaling need qualification. Still needed: add-to-existing, auditable hedge/rebalance with four occupied slots, and adjust-protective-plan. Reducing partially does not automatically free a position slot. Never bypass gross notional, risk or maintenance checks.
2. For every position adjustment, atomically recompute *whole trading-idea* stop-loss exposure, net liquidation scenarios, gross hedge collateral, daily drawdown, adverse fill slippage, correlated 20–40% shocks, maker/taker charges and funding, and compare reserve after the action to before. Stop widening/temporary stop suspension requires a separately documented maximum loss and independent emergency exit; it must never be authorized solely by model prose or a profitability target.
3. Stop placement: compute an evidence-grounded volatility/structure band (e.g. ATR, swing levels, public-order-book liquidity) with out-of-sample evaluation of stop-run wick frequency. Keep catastrophic protection; reject any entry with an unsafe distance-to-liquidation before order matching. Do not use a price dip alone as a reason to average down. Treat missing public data as deny / pause rather than pretending a stop would execute at its trigger.
4. Record a complete decision journal: source Market Skill, model ID, strategy version, signal timestamps, stress preflight inputs, original and amended exits, margin and equity, proposal vs accepted quantity, rejection reason and model's rationale. Protect event replay invariants on restart.
5. Compare staged 14-day PAPER experiments with identical public-market timelines and actual 1%/2%/3% *geometric average daily* benchmarks. Add 30/60/90-day walk-forward and event-stress tests before considering larger exposure. Any rolling objective must not override a kill switch or pressure the model to trade.

## Deployment gates

- Exact-head Typecheck / Lint / Unit / PostgreSQL / native simulator and browser E2E must pass.
- Review the new stress guard against liquidation conformance, multi-position short + long correlated shock, old journal compatibility and market-data outages.
- Ensure the installed Windows Nautilus Python runtime and private Rakazo worker actually use this exact branch. GitHub CI success alone is not a deployed user session.
- Start the three virtual accounts only after explicit owner Start; do not claim the 14-day experiment started from CI or sample fixtures.

This document specifies a staged PAPER experiment and intentionally does **not** promise a 1–3% average daily return or zero risk of liquidation.

## Update: native portfolio actions and wick diagnostics

Supersedes the older 'not implemented' statements above for these specific features.

- Native same-position scale-in: proposal.addToPositionId reuses the live position ID only when instrument, direction, leverage and the original protective stop/take-profit match. A second fill shares the same per-idea stop-risk cap. The native integration test confirmed an increase from 1.00 to 1.50 on the original position.
- Native close-before-entry rotation: proposal.replacePositionId closes an existing position reduce-only, reprojects the ledger, and opens a replacement only if the previous position has fully closed and fresh risk checks allow the new entry. A four-occupied-slot hedge rotation passed its native integration journey. Partial/unfilled exits reject the replacement.
- A public-candle volatility helper computes advisory true-range (ATR-like) and 90th percentile down/up-wicks from 14+ verified historical candles. The model receives these statistics as context; this is not a stop trigger, margin authority or liquidation prediction.
- Prior full rebalancing, stop modification/removal, multi-action portfolio optimisation and out-of-sample proof of stop placement remain unfinished. Missing model / market context must not grant execution access.
- New tests are tracked on PR #50. Keep this PR a draft until exact-head CI and native Windows replay qualification. PAPER remains owner-started only; the 14-day experiment is not running.
