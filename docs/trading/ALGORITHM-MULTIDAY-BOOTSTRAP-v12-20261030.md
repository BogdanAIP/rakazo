# Algorithm Discovery v12 — initialized 12-day study and manual operations

**Initialized on the user's Rakazo Windows research host on 2026-10-30, BEFORE first scheduled date.** Not an AI trade model. No trading/PAPER accounts, orders, login credentials, active Trader agent, automatic monitoring, or main branch changes.

## Evidence: frozen study and exact integrity anchor

- Root: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/multiday-v12-20261030/`
- Real immutable calendar: `plan.json`, bytewise SHA-256 **`6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`**.
- Exact input 50-market universe `universe-50-20261029.json`, SHA-256 **`3193fcab0a38e6a881d5b26e28efb1db59e60a0e051a8084112a19f53274a9d3`**; original historical market screen provenance is incomplete, so no certified survivorship-free universe.
- Original initial readiness report at source root `multiday-v12-20261030-initial-readiness.json`, SHA-256 **`03572b32df0e38ce1360a4799bb1f205de81747dcd7fbc3232ca663720af1b78`**.
- Current state: **0/60 verified captures, 0/60 explicit missing, 60/60 future unregistered, 0 future price labels, NO registered trading model, NO economic outcomes**. Dates were future when initialized; do not make past source up to fill the schedule.
- Plan: exactly **5 different frozen symbols assigned per UTC day**, no substitutions; the first ten days cover the 50-symbol dated universe once, last two days revisit the initial ten. Each assigned cell can be registered **once only** with a genuine source capture or an explicitly recorded failure.

## Sealed schedule (UTC, instrument names below abbreviate the exact -USDT-SWAP suffix)

| UTC day | Split | Five frozen symbols |
| --- | --- | --- |
| 2026-11-01 | Development | ETH, BTC, ZEC, SOL, PEPE |
| 2026-11-02 | Development | XRP, DOGE, NEAR, HYPE, INIT |
| 2026-11-03 | Development | PUMP, WLD, SUI, UNI, ENA |
| 2026-11-04 | Development | BCH, BNB, APR, FIL, CAP |
| 2026-11-05 | Development | ADA, BEAT, LINK, BLUR, LTC |
| 2026-11-06 | Development | ARB, TRUMP, DOOD, LIT, STRK |
| 2026-11-07 | Validation | AAVE, ONDO, IRYS, TAO, XPL |
| 2026-11-08 | Validation | AVAX, PENGU, DOT, INJ, TIA |
| 2026-11-09 | Validation | ETHW, USELESS, CHIP, OKB, GRASS |
| 2026-11-10 | Holdout | XLM, APT, SHIB, OP, VVV |
| 2026-11-11 | Holdout | ETH, BTC, ZEC, SOL, PEPE |
| 2026-11-12 | Holdout | XRP, DOGE, NEAR, HYPE, INIT |

The source roster is from a prior screen, not checked against live instrument listings for these future dates. If an instrument ceases trading, an empty or failed source is recorded. Do **not** replace it with a more promising coin.

**Candidate model freeze cut-off: before 2026-11-07 00:00 UTC.** At or after that time, code rejects any first-time model seal; both validation and later holdout must remain excluded from any claim if no pre-validated model exists. No strategy has yet been frozen or accepted. Three holdout days alone do not prove independent edge.

## Operator runbook: manual only, no scheduled collector

Use the isolated Windows research checkout:
`C:\Users\eahra\rakazo-alpha-multiday-v12-20261030`

In each example below, replace the correct UTC date, symbol and source directory with an **assigned** market/day. Do not run these before the assigned UTC day. The commands do **not** connect to accounts, create orders, or score profitability.

**Example for 2026-11-01 and ETH** (on that actual UTC day):

```bat
cd /d C:\Users\eahra\rakazo-alpha-multiday-v12-20261030

python scripts\trading\algorithm_ws_capture_v8.py --symbol ETH-USDT-SWAP --out-dir C:\Users\eahra\RakazoRuntime\trading-live-data-20261011\alpha-research\pit-captures\ws-v12-2026-11-01-ETH

python scripts\trading\algorithm_multiday_registry_v12.py register --study C:\Users\eahra\RakazoRuntime\trading-live-data-20261011\alpha-research\pit-captures\multiday-v12-20261030 --date 2026-11-01 --symbol ETH-USDT-SWAP --capture C:\Users\eahra\RakazoRuntime\trading-live-data-20261011\alpha-research\pit-captures\ws-v12-2026-11-01-ETH

python scripts\trading\algorithm_multiday_registry_v12.py report --study C:\Users\eahra\RakazoRuntime\trading-live-data-20261011\alpha-research\pit-captures\multiday-v12-20261030
```

If the preassigned source cannot be captured or audited, record **the real source failure** instead of retrying to find a favorable observation:

```bat
python scripts\trading\algorithm_multiday_registry_v12.py register --study C:\Users\eahra\RakazoRuntime\trading-live-data-20261011\alpha-research\pit-captures\multiday-v12-20261030 --date 2026-11-01 --symbol ETH-USDT-SWAP --missing-reason "Public book or taker-feed source unavailable"
```

All commands must be manually initiated for the designated day, and source network operations are bounded to an eight-second pair of public WebSocket connections, not a daemon. No automatic all-day task is running. If a source or tool is blocked for safety, **do not circumvent** that restriction or change to an undocumented alternate endpoint.

The registry appends `entries/000001.json`, `000002.json` etc. Each entry has an exclusively created filename, original source SHA, previous entry SHA, its own canonical SHA and its parent plan SHA. On a new source registration or report, all already recorded raw-source files are independently re-verified, not blindly trusted. This is **local tamper detection**, not a digital signature of the exchange or protection against someone who rewrites every file and all hashes; published plan and checkpoints help anchor provenance.

## What is deliberately NOT done

No quote/price labels were collected for v12. In v11 the future market-depth request was explicitly blocked and its 60–90 second eligibility expired. That result is **not** repaired by trying a different endpoint or inserting historical OHLC data. The v12 source registry stores only trustworthy received-at source events, not returns. Any later future-outcome provision must be a **separately authorized and authenticated** source with exact post-observation local and exchange timing; SHA alone does not establish source identity or real fills.

No model/specification has been sealed, and the model-seal function will require a complete deterministic model specification and exact Git code commit, preserving the original spec bytewise before validation. If no trustworthy labels or candidate model exist by Nov7, **validation and holdout cannot be claimed**; the collected data can still be documented as exploratory source evidence.

Predeclared minimum for any meaningful generalization discussion: 30+ separated time blocks on 10+ days, 100+ qualified events across 20+ different markets, credible future labels, realistic fees/contract lots/marketable bid-ask fills/slippage/mark/funding, holdout by day, and clustered/multiple-test-aware uncertainty. A mere count is NOT proof of profitability.

**Initial state: SOURCE_ONLY_AWAITING_FUTURE_DAYS_AND_AUTHENTIC_OUTCOMES. No alpha claim and no trading authorization.**
