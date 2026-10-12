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

## Update: Cross-margin, drawdown circuit breaker and monotonic stop protection

**Validated locally:** targeted core/contracts risk and decision-schema tests 22/22 passing. Native/Postgres replay runs are checked separately in exact-head GitHub CI.

- Correct the isolated-margin approximation in entry preview: on the currently modeled account-wide cross margin, unused marked equity also backs the new position. Estimate whether total existing plus proposed stop-risk remains above a conservative gross-maintenance reserve; additionally require the previously defined 20–35% gross market shock stress plus residual 25% equity reserve. These are **not** actual OKX liquidation prices, and gap slippage may exceed modeled limits.
- The native preview reconstructs a trusted marked-equity high-watermark from append-only simulator snapshots; fallback preview uses at least the initial 1,000 USDT high-watermark because older custom snapshots lack historical native equity. The model never supplies the peak.
- Drawdown policy for *new entries* only, all relative to historical peak: conservative ≥2.5% halve new per-idea and open-risk budgets; ≥5% freeze new entries. Moderate ≥5% halve, ≥10% freeze. Aggressive ≥8% halve, ≥15% freeze. Existing positions are **not** arbitrarily closed by this policy; protective stop/funding cycles still run. Conservative/medium/aggressive risk targets remain separate.
- New native-only `tighten_stop` decision may move a long stop **up** or a short stop **down**, with verified market price still on the safe side of the new stop and exact tick precision. It cannot remove a stop, widen it, or free stored risk budgets before a realized fill. The decision and resulting owner-scoped control change are committed with the research tick and replayable journal state.
- The originator requested the ability to withstand temporary sharp wicks. Therefore default stops are informed by observed volatility/structure **before entry**, but stopping risk remains enforceable. A wider/disabled tactical stop would require a separately modeled emergency backstop, complete correlated stress testing and audited independent approval; it is explicitly **not implemented** here.
- Exact-head CI, Windows runtime and integration replays are mandatory before any automatic PAPER trading session. Generic mobile Expo incompatibility is a separate CI issue and should not be mistaken for a passing full suite.

## Update: losing-idea recovery and recovery-rate accounting

- **Conservative new-entry catastrophe envelope**: include a simultaneous full 100% collapse of ALL gross long notional and a 200% adverse price increase (price 3× entry) of ALL gross short notional. Do not net hedge legs; preserve >25% verified marked equity as reserve and account for gross maintenance. This is a deliberately severe deterministic PAPER admission condition, not an actual venue liquidation formula. Shorts can rise beyond the tested scenario; no guarantee of zero liquidation exists. The original 35/25/20% risk-stress checks and per-idea loss caps remain required.
- **Falling-knife protection**: when native marked price has moved against an existing position, an add-to-existing-position request is rejected unless at least 20 consecutive confirmed candles demonstrate two separate local extrema and a confirmed neckline break in the recovery direction. This is one conservative heuristic; out-of-sample value is not proven. It does not override remaining margin, stop-loss and catastrophe checks. A double bottom/top is not a reliable promise of reversal.
- **Recovery Rate first slice**: native hash-verified full journal replay now computes an episode score per **native positionId**, with real entry/exit fill quantity and price, commissions, signed funding and intermediate marked PnL. An episode counts as underwater only when marked net PnL moves below max(0.5% of cumulative entered notional, 0.05 USDT), so ordinary opening fees alone do not classify every trade as a recovery. It counts as recovered ONLY after the whole position closes at strictly positive net PnL. Liquidations never qualify. Still-open recovering positions remain in the separate open-underwater counter, NOT the numerator.
- **Attribution scope and selection bias**: scale-ins and partial reductions on the same native positionId are combined. A hedge or a rotation with a NEW native positionId is **not yet** a unified multi-leg trading idea; the UI labels the metric position-level and does not claim otherwise. Unresolved losing positions must be displayed or reported alongside the recovery percentage, because the completed-trades-only denominator can be misleading. Next step: persistent, auditable multi-position idea lineage with a single net-PnL/worst-drawdown series including all hedges and subsequent rotations.
- **Qualification:** local Windows focused 30/30 core tests pass, but full CI on the updated head and the new native-backed journal integration test are pending. PAPER trading is not started and PR #50 remains draft.

## Pre-entry recovery capacity: reserve planned additions BEFORE opening

The owner's requirement is to keep enough capacity for potential/necessary averaging, not to wait until a position is deeply underwater to search for unused cash or portfolio risk.

- New native PAPER entries reserve **at least 50% of initial entry notional** for future additions to that same position. The AI may propose a larger `plannedRecoveryNotionalQuote`; an independent risk gate chooses the larger amount. This 50% is a deliberately provisional research allocation, not an optimal ratio or a promise that one/two future additions will save the trade.
- The reserve is **capacity** in whole-account admission calculations, not a transfer, wallet lock, automatically placed ladder or standing averaging order. It includes separate long/short gross catastrophe exposure, a projected stop-risk budget for the reserved part, and a corresponding initial-margin envelope. Other proposed positions are denied if they would consume that committed capacity.
- Persist the still-unused quote and stop-risk reservation with each position's existing hash-verified protective plan; expose the amount in the original PAPER comparison journal. Recalculate on actual fills and reduce the reservation when an allowed scale-in uses it. Partial fills of the original order add their proportional future reserve, not consume it.
- A later AI `addToPositionId` requires enough unspent reserve **and** a fresh market structure signal for underwater adds **and** new independent risk checks. If the original plan cannot support the additional entry, the engine denies the request instead of silently borrowing another position's reserve. Stop widening and automatic Martingale are not implemented.
- This is a first-stage **allocation envelope**, not a priced execution ladder. The chosen prices, indicators, separate recovery-idea lineage, and rules to explicitly change a reserve remain future work. It is possible for an entry to be refused even when wallet balance seems high: promised recovery risk/capital cannot be counted twice.
- Test the effect of this envelope on all three independent strategies, the 50–100% down-gap cases, positive-profit completed recovery scores, and zero-depth execution. PAPER remains user-started, not deployed; never claim zero probability of liquidation.

## Second slice: two ordered, persisted recovery price steps

**Purpose:** convert the pre-entry reserve into an optional, auditable two-step recovery plan, rather than deciding where to average only after a loss.

- The AI can propose `recoverySteps: [{stepId, triggerPriceQuote, allocationPercent}, ...]` with exactly two distinct steps, positive integer allocations totaling 100%, alongside the already booked future quote allocation. Without such explicit steps, older PAPER proposal records remain reserve-only for backward compatibility. This is a migration-compatible first slice; full mandatory staged enrollment has not been enabled for all legacy code paths.
- The risk admission also validates that the two prices are ordered progressively **toward** the pre-chosen HARD stop but do not cross it. Long: `hardStop < step2 < step1 < entry`. Short: `entry < step1 < step2 < hardStop`. Thus a 20%-down planned recovery cannot coexist with a hard stop only 3% below entry; the model must reduce notional and adopt an internally consistent stop and risk budget, or return no_trade.
- Tranche sizes are calculated using the validated pre-booked quote reserve. The system stores immutable trigger prices and stage IDs alongside the existing hashed position protection record, with per-stage remaining notional and the first verified time each price was reached.
- **Touching a level does not place an order.** A later native PAPER `proposal` must identify `addToPositionId` **and** `recoveryStepId`; the stage must already have been touched, have sufficient unused allocation, and pass an independent confirmed-reversal gate as well as leverage, stop, funding, venue, liquidity and catastrophic reserve checks. An absent stage, unvisited price, missing reversal or exhausted stage blocks the new addition.
- Partial fills consume only their own stage. Native journal comparisons expose both stage levels, unused amounts and whether an authenticated price observation has reached them.
- A key remaining validation item: a false double-bottom or a gap through the hard stop can still cause losses. A pre-entry two-stage plan is not a liquidation guarantee, does not automatically buy, and cannot manufacture a liquidity source.
