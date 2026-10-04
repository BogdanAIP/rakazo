# Rakazo Trading — roadmap

Status: **draft implementation through P11C-7; P12-0 native Bot template; no running paper scheduler or live trading**  
Created: 2026-10-03; bot-product decision: 2026-10-04  
Owner: Rakazo product; source of truth for this extension.  
Related: [ChatGPT + Rakazo roadmap](../chatgpt-rakazo-roadmap.md), [research register](./RESEARCH.md), [P11 internal paper lifecycle](./P11-TRUSTED-PAPER-WORKER.md) and [P12 native Trading Bot](./P12-NATIVE-BOT.md).

**Product identity:** the deliverable is an ordinary **user-created Rakazo Bot** with a strategy, conversation, memory, Tasks/Runs and optional Routines—not a parallel trading app or separate agent runtime. The verified paper ledger and independent Risk Manager belong to Rakazo backend and must be explicitly bound to that Bot. P11 has owner/space-scoped virtual journals, **not yet Bot-bound**; the next integration gate is P12-1. Existing Routine prompts, LLM instructions and generic tool access do not authorize virtual-money changes or live orders.

**Numbering:** the broad P0–P9 product-phase table below is a high-level plan; code implementation slices P0–P12 are tracked in individual `docs/trading/P*.md` documents. Their numbers are not interchangeable.

## 1. Product goal

Build an optional, self-hosted research and trading capability **inside Rakazo**, not a standalone agent/control plane. Analyze dynamically discovered eligible instruments (BTC/ETH **and altcoins**), spot, dated and perpetual futures, CEX, DEX and DeFi opportunities; generate **concrete, falsifiable, timestamped trading signals**; test strategies out of sample; paper-trade; and, only after a distinct approval gate, connect the user's own trading account. A valid result can be **NO TRADE**. No promise of profit or guaranteed alpha.

The product has two complementary roles, represented through one native Rakazo Trading Bot:
- **AI Researcher:** market discovery, hypotheses, signals, explanations, simulation and strategy improvement.
- **Own-account trader:** controlled execution of an approved versioned strategy on the user's account, initially paper-only.

No prop-firm workflow in the initial scope; preserve room for a future adapter without making one a prerequisite.

## 2. Architectural constraints and existing-system compatibility

- Keep **one Rakazo** as durable control plane (auth, permissions, jobs, events, audits, leases, recovery, web UI and Windows Host when useful). Shared contracts/core belong in existing packages. No CAP, OpenResearch, parallel planner or second proprietary trading control server.
- ChatGPT via the **existing Plugin R** is the interactive reasoning and supervision surface, not a guaranteed background clock, real-time safety controller or credential store. Rakazo Worker executes deterministic schedules, data ingestion, order reconciliation, risk gates and emergency stops. Optional explicitly configured remote/model API is necessary for unattended LLM analysis; ChatGPT subscription does not grant backend API calls.
- Preserve the established manually launched Rakazo application, one existing R tunnel and paired Windows Host; no Windows autostart, new tunnel, new pairing or unmanaged sidecar. A trading engine may be an **owned, supervised child/service** behind a Rakazo provider contract, not an independent user-facing orchestrator. Clean shutdown must not blanket-kill unrelated processes.
- **Default deny:** initially read-only market data, no exchange keys, no wallet signing and no execution. Paper and live modes must be separate capabilities with explicit individual user approval. No action in this documentation starts anything.
- Provider-neutral adapters and deterministic offline tests first; use native APIs/SDKs selectively behind contracts, with CCXT as a useful abstraction, not an excuse to erase exchange-specific order semantics.
- The public repo must never contain keys, seed phrases, account details, real transaction/user data, IP addresses, private URLs or identifiable local machine details. Use placeholders and synthetic fixtures.

## 3. Product surfaces

- **Native Rakazo Bots interface** is the entry point: create one or more Trading Bots through the existing `bots.create` contract; each bot retains its own thread, model, instructions, memory, Runs and optional disabled-by-default Routines. Progressively expose Trading: Discovery, Signals, Research, Strategies, Paper, Portfolio, Journal, Risk, Connections inside the bot. Native mobile surfaces can safely degrade to read-only/approvals until equivalence is implemented.
- Plugin R tools, once authorized: list markets and data freshness; scan; inspect a signal and its evidence; launch/review backtests; list paper/live positions; pause/disable a strategy; request a time-limited execution approval; see incidents/journal. Never expose raw keys or wallet secrets in tool responses.
- Signal notifications via optional event integrations; event and alert delivery must be durable and deduplicated.

## 4. Architecture (conceptual)

User / ChatGPT via Plugin R -> existing Rakazo Bot (thread, model, Tasks/Runs, optional Routines) -> Rakazo appContract -> trading research and trusted Worker -> Bot-bound paper ledger + independent risk gateway + market-data adapters -> separately authorized execution adapters (future) -> CEX / DEX / DeFi providers.

AI outputs are **proposals**, never privileged order commands. Validate them with a typed schema and deterministic risk checks. Every action includes provenance, mode, identity, strategy version, signal ID, timestamp, TTL and idempotency reference.

Research, execution, portfolio reconciliation and risk control must work even if the chat disconnects; no unsolicited live actions can be triggered by a narrative answer.

## 5. Scope by market

| Track | Instruments and coverage | Distinct considerations |
| --- | --- | --- |
| CEX spot | Dynamically listed eligible base/quote pairs, including altcoins; multi-exchange quotes | listings/delistings, precision/min notional, fees, depth, spread |
| CEX derivatives | Dated futures and perpetuals, LONG/SHORT | contract size, margin mode, leverage, funding/basis, mark/index prices, liquidation, reduce-only |
| DEX trading | On-chain swaps and order books/perps where supported | chain IDs, token verification, transaction simulation, gas, MEV, chain finality |
| DeFi research | Lending, LP/vaults, rates, yield and protocol health | smart-contract/oracle/bridge risk, liquidation, withdrawal liquidity |
| Portfolio | Cross-venue, correlated exposure and actual asset inventory | net exposure, concentration, funding/fees, custody/counterparty risk |

Candidate connectors for evaluation (NOT an eligibility/permission claim): BingX, Bybit, OKX, MEXC, CoinEx and additional CEX; Hyperliquid, dYdX, GMX, Jupiter, Uniswap, Raydium; Aave, Morpho, Pendle, Curve. See RESEARCH.md for verification gates. Exchange/KYC/region and product availability must be checked separately, especially for Russian citizenship/residency and VPN usage; never use VPN to circumvent prohibited access. Legal review must cite the applicable law's actual effective dates and published registry, not label an ordinary exchange “licensed” by assumption.

## 6. Market discovery and signal specification

Do not hard-code BTC/USDT or any tiny fixed asset list. Refresh the exchange instrument catalog, normalize symbols/contract metadata and preserve delisted histories. Fetch a broad universe, then **filter before expensive analysis** by: tradability and account eligibility, price/volume quality, age/listing status, market and order-book liquidity, spread, fees, slippage estimate, volatility, funding, open interest (if present), suspicious activity, concentration and freshness. Log exclusions, missing data and exact source timestamps.

Use multi-timeframe technical/order-flow data, futures funding/open-interest/basis, cross-venue prices, applicable event/news signals and on-chain indicators with their confidence/quality limitations. Comparisons must account for fees, spread, slippage, financing, borrow, gas and funding. No manufactured numerical “confidence” percentages unless calibrated and validated.

**Typed signal, minimum fields:**
- unique signal ID, creation/expiry timestamps, venue/product/market, symbol, instrument precision and data-source freshness;
- strategy ID+version, evidence/data snapshot, assumption and invalidation condition;
- action: LONG / SHORT / SPOT BUY / SPOT SELL / REDUCE / CLOSE / **NO_TRADE**;
- executable entry trigger/zone, order type, stop, one or more take-profit rules or exit algorithm; explicit cancel condition and TTL;
- estimated size and max loss in portfolio currency, account/margin mode, leverage only if approved, expected fees/funding/gas/slippage and payoff/risk scenario;
- risk-gateway verdict and execution status; no order without explicit live capability, independent validation and account authorization.

Signal display is a research output, not a guarantee that the market will meet the trigger or that any order has been placed. When evidence is stale, missing or ambiguous, abstain / NO_TRADE.

## 7. Research and experiment hygiene

- Historical data normalized with source/venue, timezone, gaps, splits/relistings and delisted assets as applicable; prevent survivorship, look-ahead and data leakage.
- Deterministic baselines first; compare AI/ML with simple benchmark and no-trade, not only against best-looking backtest. Version and reproduce datasets, parameters, code/model and signal outputs.
- Time-series train/validation/test, walk-forward and unseen periods; record total and risk-adjusted results, max drawdown, turnover, fees, funding, borrowing, market impact/slippage, liquidation and adverse conditions. No “best strategy” claim from a single historical optimization.
- Compare Freqtrade/FreqAI vs Hummingbot/Condor in an **evaluation spike**, reusing existing engines under Rakazo supervision rather than implementing both forever by default; NautilusTrader as a later alternative for execution/event sourcing; CCXT as data/connectivity helper; Qlib/TradingAgents as optional research references. Record license, maintenance, support coverage, paper/live parity and recovery evidence before dependency decision.
- ML/LLM generated strategy must pass the same offline, walk-forward and paper tests; model retraining **cannot silently promote** a new strategy or risk policy to live.

## 8. Independent risk and safety contract

- Hard, user-configurable per-order risk, daily loss, total drawdown, maximum open positions, venue/symbol concentration, leverage, correlated portfolio exposure, price deviation and allowed instruments/products. Risk checks fail closed. Model and strategy code cannot modify/remove them.
- User may kill-switch trading without consulting an AI; alerts and audit trail for every rejection and limit breach. User approval for live mode is specific to account, venue, strategy version, instrument class, maximum envelope and time. Revoke safely.
- Execution state machine: intent -> approval -> submit (unique client order ID) -> ACK/UNKNOWN -> exchange reconciliation -> partial/full fill/cancel -> journal. Never blindly retry after network failure, VPN disconnect, timeout or restart. Compare exchange state first; preserve deduplication and correct stop/reduce-only semantics. Test rejects, stale prices, partial fills, market halts and exchange delistings.
- Exchange keys: read-only first; distinct trade permission if live enabled; no withdrawal permission; encrypt at rest, least privilege, venue-allowed IP restriction if feasible, rotation/revocation, never in chat/logs. Wallet signing isolated behind explicit transaction and spend approval, chain/token/contract allowlists, bounded allowances, nonce tracking and pre-sign simulation. No unrestricted LLM access to signing.
- Perp-specific circuit breakers: mark price and collateral, funding, liquidation buffer, isolated/cross-margin awareness, liquidation warning, position sizing and existing open-order exposure. DeFi-specific: malicious token/contract protection, gas/MEV, oracle/bridge/smart-contract risk and finality/reorg handling.
- Always distinguish technical reachability (including VPN), exchange contractual/KYC permission, and applicable legal/tax obligations. No automatic registration or deposit; document user checks without embedding personal details.
- If Rakazo is manually stopped, local trading jobs do not continue. An always-on VPS executor is a **separate opt-in deployment decision**, subordinate to Rakazo's authority and with independently enforced risk limits; no covert autostart.

## 9. Product phases and acceptance gates (broad plan; see P12 for current code slices)

| Phase | Deliverable | Completion evidence / gate |
| --- | --- | --- |
| P0 — Foundation & audit | Map existing Rakazo contracts/jobs/auth/permissions/storage; inventory candidate licenses and API rules; settle module boundaries; capture baseline | ADR + test plan; zero runtime impact; documentation only |
| P1 — Market data | Read-only CEX connectors beginning with BingX plus one comparison venue; instrument discovery incl. altcoins and spot/perps | Live public feed + offline fixtures; freshness, pagination, clock, reconnect, rate-limit and precision tests |
| P2 — Research baseline | Market scanner and typed signals, NO_TRADE, event journal; simple strategies | Reproducible signals from recorded data; stale/missing-data abstention; explanations cite snapshots |
| P3 — Trading engine evaluation | Compare Freqtrade/FreqAI and Hummingbot/Condor behind Rakazo-owned interface | License/maintenance/connector support, backtest parity, resource use and failure/recovery study; select **one** primary engine |
| P4 — Historical experiments | Full costs, walk-forward, ML/LLM research; spot + altcoins + perpetual/dated futures if venue supports | Unseen-period report with costs, overfit checks, benchmark and failure cases |
| P5 — Paper trading | Real-time simulated execution, independent risk gateway and full reconciliation | Spot and derivative paper cases; VPN/API outage, reject, partial fill, restart, duplicate and kill-switch tests |
| P6 — CEX own-account live gate | One specifically permitted account/venue and minimum privileges; explicit approval, tiny predefined limits | Successful KYC/terms/compliance review, opt-in funding, post-trade independent journal reconciliation; **no automatic rollout** |
| P7 — DEX/perps expansion | Hyperliquid testnet and selected DEX protocols, approved wallet boundary | Testnet end-to-end tx simulation, chain/reorg/nonce/gas/allowance tests; separate live signing approval |
| P8 — DeFi Research | Read-only lending/LP/rate/risk dashboard and simulated transactions | Risk model and protocol/source provenance, no auto-allocation |
| P9 — Optional persistence | Supervised optional remote executor, events, multi-venue portfolio | Owner-approved architecture, secret isolation, stop/recovery and alert tests; retains single Rakazo control plane |

Parallel tracks are allowed for **read-only research**. P6/P7 live permissions require all earlier applicable risk, reliability and legal gates. No hardcoded performance or calendar deadline is implied.

## 10. First executable backlog (start here)

1. Inspect current appContract, permissions, Worker/jobs, provider registration, event/journal and deployment ownership; write a small integration ADR, no schema changes yet.
2. Create read-only market and signal contracts plus synthetic fixtures and offline tests; model symbol/contract metadata for spot, dated and perpetual futures.
3. Prototype BingX public spot/perp catalog + candles and one additional exchange feed **without API keys**, with documented regional/product eligibility checks; avoid secret-bearing commits.
4. Evaluate Freqtrade BingX connector, Hummingbot BingX spot connector, FreqAI and Condor against explicit acceptance tests. Do not fork or embed a whole parallel orchestrator before decision.
5. Implement scanner baseline: broad discoverable universe incl. altcoins -> objective quality/liquidity filters -> optional candidate shortlist -> concrete signal or NO_TRADE. Show timestamps, fee assumptions and reasons.
6. Add paper-only execution and deterministic independent risk checks before any plan for account/key connection.
7. Define staged, separate futures and DEX testing with the same position/journal/risk semantics, plus domain-specific safeguards.

## 11. Decision log / non-goals

- **2026-10-04:** This extension delivers a **native user-created Rakazo Trading Bot** (not just reusable trading APIs). P12-0 implements the schema-validated research profile for existing `bots.create`; P12-1 must bind a distinct ledger/policy to an immutable Bot identity with safe archive/duplicate/restart behavior. No automatic Bot creation, paper routine, worker or live order is activated.

- **2026-10-03:** Trading is an **optional module inside existing Rakazo**; one local control plane and existing Plugin R; no CAP/OpenResearch dependency.
- **2026-10-03:** Support both own-account trading and AI researcher, CEX spot + altcoins, dated/perpetual futures, DEX and DeFi Research; broad discovery and concrete signals, including NO_TRADE.
- **2026-10-03:** Research/paper default; no live trading, funding, wallet signing or secret ingestion until separately authorized, tested and allowed.
- **2026-10-03:** No assumption that locally running ChatGPT is a 24/7 unattended inference service or that a particular RAM/GPU size is mandatory. Measure actual resource budgets, consider optional cloud executor only with explicit approval.
- Not in initial implementation: prop challenges, copy-trade referrals, HFT, MEV exploitation, autonomous legal circumvention, hidden risk-limit overrides or claimed guaranteed profitability.
