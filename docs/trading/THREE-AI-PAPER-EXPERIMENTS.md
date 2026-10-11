# Three AI-managed PAPER experiments — integration and safety status

**Target**: one owner-controlled account in normal operation, with a selectable strategy. During evaluation, compare conservative, moderate and aggressive AI strategies in three independent 1,000-USDT virtual portfolios on equivalent market data; multiple USDT perpetual pairs, separate hedge legs, explicit margin semantics, configurable bounded leverage and a reproducible 14-day comparison. This is a development plan, **not a declaration that derivatives PAPER trading or the trial is running**.

## Accepted execution engine — 2026-10-11

Owner decision: **use NautilusTrader** for futures PAPER execution. This supersedes the custom futures simulator implementation steps below.

### Strategy comparison and leverage clarification

Owner clarification: the three strategies are experimental alternatives for comparison, not a requirement for three exchange accounts in normal operation. Each PAPER strategy has an independent virtual 1,000-USDT budget so one strategy's trades do not consume another strategy's test capital. Normal operation uses one account and a selected strategy. The experiment should use the same market timeline and record strategy/version, decisions, risk limits, costs and start/end timestamps.

Owner-approved initial experiment leverage ceilings: **conservative 5x, moderate 10x, aggressive 20x**. The AI may choose lower leverage per trade within the currently owner-approved account ceiling. Existing loss budgets and exposure limits are not automatically increased.

The Futures journal must expose an editable account leverage ceiling, initially populated with the strategy's 5x/10x/20x setting. Display the selected exchange, contract, margin mode, applicable position tier, current owner ceiling and current venue maximum. An owner may explicitly change the account ceiling through a reviewed, revision-fenced command; the configuration change must be journaled.

Venue maximum is instrument- and margin/tier-specific, not a hard-coded universal exchange number. Source public contract metadata and position-tier limits from the selected exchange adapter (for OKX, public position tiers expose maxLever and maxSz). Enforce the relevant tier after including current and proposed exposure; when an exact account-specific maximum requires private data, do not claim that public metadata proves personal account eligibility. PAPER remains public-data-only.

Effective permissible leverage for each proposed entry is the minimum of the owner-approved ceiling and the fresh applicable venue maximum, also subject to independent risk and margin checks. Reject invalid/stale/missing venue limits and independently revalidate before execution. Never silently execute at a different leverage than the recorded proposal. Where several instruments are selected, show their individual ceilings and enforce each separately. The journal setting applies to subsequent entries; existing positions retain their recorded leverage unless a separately specified position-management action is implemented.

Implementation status: these are accepted requirements. Existing source defaults and proposal/ledger schemas still need migration away from 1x/2x/3x; the owner UI is not yet implemented. The R execution connection is unavailable at this checkpoint, so no installed runtime setting has changed.



- NautilusTrader owns order matching, order lifecycle, positions, fees, funding and account balances. Rakazo owns human Start/Pause/End, finite sessions, model selection, Market research provenance, independent deterministic permission/risk checks and the existing Spot/Futures journal.
- The journal is an idempotent projection of engine events. There must be one authoritative account balance; Rakazo must not independently recalculate a competing simulated wallet.
- Preserve three independent 1,000-USDT virtual portfolios for comparison, a single-account normal mode, multiple pairs, separate long/short hedge positions and configurable leverage ceilings. Selecting an engine does not grant permission to start a trading session.
- Pin the tested native Rust/PyO3 engine API and package version. Current qualification used NautilusTrader 1.231.0 on native Windows/Python 3.12. Do not mix its legacy Cython sandbox API with native engine capabilities, or stable 1.x with documentation examples for 2.x.
- Five offline synthetic qualification scenarios verified hedge, two instruments, leverage 1/2/3, partial reduce-only close, fees, funding settlement and crash liquidation. These are component tests, not evidence of a completed integration or trading profitability.
- Margin semantics remain an integration requirement: the tested account-wide configuration offsets hedge exposure and is different from the current custom isolated-lot accounting. Verify supported margin configuration and explicit gross-risk limits before mapping available balance or liquidation into the journal. Do not silently retain isolated-margin labels for account-wide results.
- Next acceptance checks: real-time PAPER data delivery and funding; native engine event persistence and deterministic restart recovery; owner/revision/expiry fencing; independent risk denial; journal projection; full browser Start→worker→engine→journal→Pause/Close flow.
- Existing uncommitted custom-engine work is preserved for review and reusable orchestration/UI pieces; expansion of custom matching/accounting is paused. No runtime switch, merge or 14-day experiment start is implied by this decision.

References: [NautilusTrader pinned release](https://github.com/nautechsystems/nautilus_trader/releases/tag/v1.231.0), [native liquidation example](https://github.com/nautechsystems/nautilus_trader/blob/v1.231.0/examples/backtest/liquidation_demo.py), [installation/version guidance](https://nautilustrader.io/docs/latest/getting_started/installation/).

## Reuse-first audit (Market index, 2026-10-11)

Before adding code, the existing owner-curated Market catalog was searched. The relevant *knowledge and market-data* routes already exist:

| Requirement | Existing Resolver / Skill | Use and limits |
| --- | --- | --- |
| Perpetual quotes, funding, open interest | `futures.data` Resolver → `okx-cex-market` (priority 1), Kraken analytics, CCXT public endpoints, BingX public APIs | **Read-only**. Choose current, validated exchange-specific symbol/contract metadata, then normalize snapshots. A Resolver selection grants no execution rights. |
| Multi-exchange market data | `ccxt-mcp` from `ccxt/ccxt` | Reuse public OHLCV, bid/ask, funding/OI where available; never supply authenticated order credentials or use live execution. |
| Margin, funding and liquidation research | `kraken-futures-risk`, `recipe-funding-rate-scan` | Adapt conceptual risk checks to PAPER; do **not** invoke leverage-change, order or cancel commands. Their Kraken-specific liquidation mechanics are not assumed to describe OKX/BingX. |
| Technical market research | `okx-cex-market`, `sentiment-analyst` | Read-only Skill source for normalized AI proposal. Needs supported installed implementation, safe API, provenance and owner approval to select. |
| Backtests and reproducibility | `backtest.quant`, `strategy.framework`, `alpaca-trading-backtest`, `recipe-paper-strategy-backtest` | Research patterns only; reject any real broker submission. Replay trading decisions against archived timestamped data. |
| Paper order lifecycle patterns | `trading.paper`, `alpaca-trading-paper-trading` | Reference workflow only: Alpaca paper accounts/order types are **not** our OKX/BingX perpetual hedge engine. |

We did **not** install packages or execute third-party Skill shell commands in this audit. Specific skill names are catalog entries, not evidence that their optional runtime/provider access is configured.

## Already implemented and reused

- `packages/core/src/trading-paper-experiments.ts`: three immutable 1,000-USDT strategy budgets and hedge bucket identities; the existing account-create screen preloads these. These are not automatic three-account provisioning.
- Existing trusted spot PAPER ledger, approval gates, journal, worker scheduler, restart pause and protected exits remain the sole *live in-app* trading path. No spot behavior may be silently converted to derivatives.
- `packages/core/src/trading-paper-perpetual-preview.ts` (new): read-only BigInt fixed-point proposed long/short assessment for one owner ledger, venue, swap instrument and profile. Explicitly checks leverage, stop/take-profit direction, notional, exposure, account collateral, open position slots, daily and concurrent stop-risk budgets, slippage/fees and whether loss at stop would exhaust simulated isolated maintenance collateral. Opposite hedge legs get distinct bucket keys. An `inert_preview` **does not reserve margin, open a position, simulate funding, trigger liquidation, or submit any order**.
- Historical source defaults currently use Conservative/Moderate/Aggressive maximum leverage 1x/2x/3x. The approved target is 5x/10x/20x with a journal setting and venue-specific enforcement as described above; source migration remains pending.

## Historical custom-engine plan — superseded by the accepted engine decision

1. **Read-only futures evidence adapter**: normalized contract mapping and versioned public quote/funding snapshots from the existing Market Resolver + selected Skill. No private exchange keys.
2. **Append-only futures margin ledger**: long/short independent lots per owner/account/venue/symbol; isolated margin, reserved collateral, mark-to-market equity, realized/unrealized P&L, entry/exit fees, funding and maintenance-tier aware liquidation; deterministic restart/replay and accounting invariants.
3. **Order simulator**: market/limit order state, expiry and partial fills, latency/slippage, reduce-only and cancel, bracket stop/take-profit and protective handling through worker checks. Price snapshots cannot guarantee fills, gap stops or real exchange liquidation outcomes.
4. **AI proposal schema/runtime**: source-grounded analysis through Market Skills/Resolver, proposes instrument/side/leverage/size/entry/exit/expiry, or NO_TRADE. Mandatory verified quote/provenance, fresh authority and deterministic independent Risk/Policy Core gate; model/provider quota failure must pause new entries. No silent fallback to an unrelated algorithm.
5. **Three independent accounts**: 1,000 virtual USDT each, separate persistent journals and risk attribution; user-approved start, pause/stop, and position protection/recovery. Avoid auto-starting any existing 10,000-USDT account. No unattended perpetual Start before integrated tests.
6. **Test suite and experiment report**: unit/property and PostgreSQL ledger invariants, offline strategy replays, Chromium account-to-journal, multi-pair hedge/short/long/funding/liquidation and restart tests. Compare 14 days **starting only when all three experiments are actually running**, reporting start/end timestamps, data gaps, risk-adjusted P&L after simulated costs, drawdown, executed vs rejected plans, provider outages and market regime.

A 14-day report may inform further PAPER iteration. Two weeks of outcomes are not enough to prove long-run robustness or authorize real-money trading. Live exchange routing, actual credentials and real trading remain explicitly disabled until separately requested and reviewed.

### Calculation scope caveat

Current `previewPaperPerpetualProposal` uses a simplified **isolated margin assumption**, user-supplied (trusted-data-only) maintenance margin bps and static stop slippage. It deliberately rejects stops too close to the estimated maintenance threshold. This is a conservative **proposal gate**, not an accurate OKX/BingX liquidation price: actual contract multipliers, risk tiers, mark price, funding, fees, forced execution and gap/slippage vary. The future derivatives ledger must independently revalidate margin/liquidation using verified venue rules and never treat this preview as permission.
