# Rakazo Trading — candidate and evidence register

Status: **research backlog, not verified integrations or endorsements**. Reviewed for planning 2026-10-03. Check live docs, licenses, terms, geographic/KYC rules, product eligibility, price/rate limits and recent incidents **again before implementation and before any real-money use**. A supported software connector is not permission for a person in a given jurisdiction to trade.

## Engines and reusable ideas

| Candidate | What to examine | Primary source | Gate |
| --- | --- | --- | --- |
| Freqtrade / FreqAI | Spot/perpetual connector coverage, backtesting, dry run, ML/retraining and REST API; BingX support detail | https://github.com/freqtrade/freqtrade ; https://www.freqtrade.io/ | Can a Rakazo-owned adapter supervise its lifecycle and reconcile paper/live orders? |
| Hummingbot / Gateway / Condor | CEX/DEX connectors and agent/risk design; separate usable trading functions from its own orchestration | https://github.com/hummingbot/hummingbot ; https://hummingbot.org/ | No second privileged agent/control plane; license and API fit |
| NautilusTrader | Event-driven backtest/live parity, order lifecycle, reconnect | https://github.com/nautechsystems/nautilus_trader | Complexity, product/venue coverage, independent risk gate |
| CCXT | Exchange discovery and public REST, symbol/market normalization | https://github.com/ccxt/ccxt | Explicitly handle exchange-specific order semantics and WS gaps |
| Qlib / RD-Agent | Quant and AI hypothesis research | https://github.com/microsoft/qlib ; https://github.com/microsoft/RD-Agent | Adapt assets/data to crypto without look-ahead |
| TradingAgents | Collaborative AI research reference only | https://github.com/TauricResearch/TradingAgents | Keep research subordinate to Rakazo; no live privileges |

## Venue / protocol investigation tracks

| Track | Candidates / primary docs | Confirm before any account or private operation |
| --- | --- | --- |
| CEX spot/futures | BingX https://bingx-api.github.io/docs/ ; Bybit https://bybit-exchange.github.io/docs/ ; OKX https://www.okx.com/docs-v5/en/ ; MEXC https://www.mexc.com/api-docs ; CoinEx https://docs.coinex.com/api/v2/ | Current citizenship/residency/KYC eligibility, product-level terms, demo options, keys/scopes, withdrawal prohibition, API/funding, regional restrictions and incident status |
| On-chain order book / perps | Hyperliquid https://hyperliquid.gitbook.io/hyperliquid-docs/ ; dYdX https://docs.dydx.exchange/ ; GMX https://docs.gmx.io/ | Testnet, oracle, collateral, liquidation and official front-end/API restrictions |
| Swap/LP DEX | Jupiter https://dev.jup.ag/ ; Uniswap https://developers.uniswap.org/ ; Raydium https://docs.raydium.io/ | Verified token/contract/chain, aggregator and API usage restrictions, allowances, simulation, slippage/MEV, gas and custody |
| DeFi analysis (read only first) | Aave https://aave.com/docs ; Morpho https://docs.morpho.org/ ; Pendle https://docs.pendle.finance/ ; Curve https://docs.curve.finance/ | Lending/vault/LP and liquidation mechanics, oracle and bridge risk, liquidity and smart-contract audit context |

## Regulatory/operational questions (must not be assumed resolved)

- Separate: Russian legal effective dates and investor/intermediary rules; actual published Russian regulatory registries; exchange-specific Russian citizenship/residency restrictions; specific product and location; deposit/withdrawal routes and tax records.
- Network reachability via a VPN is not contractual authorization or a substitute for accurate KYC. Do not advise misrepresentation or geographic restriction bypass.
- For all venues, record the timestamp and official URL of **each** applicable restrictions/terms page at approval time. Do not call a firm regulated without its regulator/registry status.
- This file is a research checklist, **not** a statement that any of these venues is currently permitted for a particular user.

## Evaluation record template

Date / candidate / version or commit / license / official documentation URL / supported markets / public data / paper-test availability / API rate limits / state recovery / independent risk controls / auth/key custody / legal/KYC verification / memory and CPU observed / conclusion with gaps / owner.

## Decision criteria

Select a primary reusable trading engine after comparable **read-only, backtest and paper** experiments: completeness of spot and futures contracts, altcoin instrument discovery, deterministic accounting and risk, reconcilable order states, FreqAI/AI hooks, operating cost, security, supported license and maintenance. Avoid selecting from branding or backtest return alone.
