# Three AI-managed PAPER experiments — integration and safety status

**Target**: conservative, moderate and aggressive AI-directed, independent 1,000-USDT virtual accounts; multiple USDT perpetual pairs, isolated hedged long and short legs, bounded leverage, reproducible 14-day comparison. This is a development plan, **not a declaration that derivatives PAPER trading or the trial is running**.

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
- Conservative/Moderate/Aggressive profile maximum leverage: 1x/2x/3x respectively. All are PAPER defaults, not adaptive AI permissions.

## Missing work before running the 14-day experiment

1. **Read-only futures evidence adapter**: normalized contract mapping and versioned public quote/funding snapshots from the existing Market Resolver + selected Skill. No private exchange keys.
2. **Append-only futures margin ledger**: long/short independent lots per owner/account/venue/symbol; isolated margin, reserved collateral, mark-to-market equity, realized/unrealized P&L, entry/exit fees, funding and maintenance-tier aware liquidation; deterministic restart/replay and accounting invariants.
3. **Order simulator**: market/limit order state, expiry and partial fills, latency/slippage, reduce-only and cancel, bracket stop/take-profit and protective handling through worker checks. Price snapshots cannot guarantee fills, gap stops or real exchange liquidation outcomes.
4. **AI proposal schema/runtime**: source-grounded analysis through Market Skills/Resolver, proposes instrument/side/leverage/size/entry/exit/expiry, or NO_TRADE. Mandatory verified quote/provenance, fresh authority and deterministic independent Risk/Policy Core gate; model/provider quota failure must pause new entries. No silent fallback to an unrelated algorithm.
5. **Three independent accounts**: 1,000 virtual USDT each, separate persistent journals and risk attribution; user-approved start, pause/stop, and position protection/recovery. Avoid auto-starting any existing 10,000-USDT account. No unattended perpetual Start before integrated tests.
6. **Test suite and experiment report**: unit/property and PostgreSQL ledger invariants, offline strategy replays, Chromium account-to-journal, multi-pair hedge/short/long/funding/liquidation and restart tests. Compare 14 days **starting only when all three experiments are actually running**, reporting start/end timestamps, data gaps, risk-adjusted P&L after simulated costs, drawdown, executed vs rejected plans, provider outages and market regime.

A 14-day report may inform further PAPER iteration. Two weeks of outcomes are not enough to prove long-run robustness or authorize real-money trading. Live exchange routing, actual credentials and real trading remain explicitly disabled until separately requested and reviewed.

### Calculation scope caveat

Current `previewPaperPerpetualProposal` uses a simplified **isolated margin assumption**, user-supplied (trusted-data-only) maintenance margin bps and static stop slippage. It deliberately rejects stops too close to the estimated maintenance threshold. This is a conservative **proposal gate**, not an accurate OKX/BingX liquidation price: actual contract multipliers, risk tiers, mark price, funding, fees, forced execution and gap/slippage vary. The future derivatives ledger must independently revalidate margin/liquidation using verified venue rules and never treat this preview as permission.
