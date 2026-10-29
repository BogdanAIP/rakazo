# Algorithm Discovery v4 — funding-conditioned evidence gate and matched-count falsification

**29 October 2026. Status: implemented, local tests passed; NO PAPER approval, NO verified predictive edge.** Branch `research/algorithm-discovery-pit-v4-2026-10-29`.

## Why the experiment changed

v1-v3 used only historical OHLCV. Their state-machine representations were distinguishable from specific comparators but overwhelmingly failed after costs. v4 tests whether independently archived **perpetual funding settlement observations** contain *incremental, historically lagged information* for rejecting a price-only v3 trade hypothesis. This is an ablation experiment, not an original trading theory.

Official data access: [OKX historical archive](https://www.okx.com/en-us/historical-data); [OKX perpetual funding mechanism](https://www.okx.com/en-us/help/perps-funding-fee-mechanism). OKX notes that funding settlement frequency can change. Do not assume every perpetual settles every 8 hours.

Only two markets have usable checked settlement archives **in the existing local research store**: BTC-USDT-SWAP (276 rows) and ETH-USDT-SWAP (276 rows), July–September 2026. Candles: 8,832 complete 15-minute bars per market, independently checked against the existing archive manifests. There are no timestamp-verified historical orderbook, OI or news datasets in the inspected research directory. Do not simulate these as actual observations.

## Data-integrity/availability limits

`algorithm_funding_v4.py` reconstructs all funding observations by reading the exact original CSV rows inside each ZIP; validates matching archive SHA-256, receipt, month/instrument, source schema, sorted event timestamps and exact equality with the intermediary funding JSON. Missing or tampered source evidence aborts the run.

**Critical limitation:** an archived funding settlement time is **not** a recorded publication or reception timestamp. This study uses two *hypothetical* post-settlement embargoes of 15 minutes and 60 minutes, and refuses entry without at least two settled observations passing the embargo, a fresh last observation (<=8 hours), and no more than 12 hours between prior and current settlements. These are design assumptions, not historical proof of information availability. Values that would only be published later are an unresolved lookahead risk. No causal/PIT claim can be based on an unspecified release history.

Price-only v3 decisions are generated from closed 15-minute bars. Funding gates apply **once at the beginning** of each existing target episode; a rejected entry cannot re-open midway through the same lease. No extra position direction or artificial trade is introduced.

Fixed gates:

- **price_coverage:** only requires a sufficiently fresh assumed-available funding pair; funding values do not change the price decision. This is the missingness control.
- **carry_receive:** admit a v3 directional entry only if its direction is opposite to the sign of the last *settled* funding rate. Past settled funding is not a guaranteed future cashflow.
- **funding_deceleration:** admit only if `direction * (last_settled_rate - previous_settled_rate) < 0`. This tests recent funding drift, not news/SMC/orderbook.
- **price_original:** the same v3 strategy without funding-availability conditioning.

All variants use the **identical** constant-quantity next-open linear-contract replay: notional 10% of initial equity, 7 bps per executed side (5 bp hypothetical fees + 2 bp slippage) and 14 bps per side in stress. **The simulated returns do NOT include actual funding settlements, mark price, contract-lot rounding, liquidation, stop execution or fill uncertainty.** A gain from filtering is not equivalent to fully accounted futures profitability.

Training first 60% and the already-exposed following 20% were evaluated separately, resetting price state at each partition. The final 20% of both candle datasets were not passed to algorithm evaluation. Previous exposure of these markets means neither reported partition is independent validation.

## Most interesting falsifiable result (not trading evidence)

ETH recovery-failure, **exposed development 20%**, funding-deceleration gate:

| Variant | 7 bps/side net (% of initial simulated equity) | 14 bps/side net | Executable episodes |
| --- | ---: | ---: | ---: |
| Ungated v3 price-only | +0.0936% | -0.6064% | 50 |
| Funding gate, assumed 15-minute embargo | +0.2999% | +0.0618% | 17 |
| Funding gate, assumed 60-minute embargo | +0.2602% | +0.0501% | 15 |

This appears to improve a particular already-seen ETH slice, **but cannot establish an advantage**. The two embargo assumptions are unverified and the user-visible development period is reused. Other markets, partitions and signals mostly remain negative. Model alternatives and latency scenarios must not be selected post hoc as if an out-of-sample discovery.

For BTC, all funding-filtered variants had negative net returns in both examined partitions and both cost scenarios. For ETH, all other displayed candidate/segment combinations remained negative after doubled cost, except the narrow recovery-failure/funding-deceleration development cases above.

## Turnover-matched nulls (separate implementation)

`algorithm_funding_null_v4.py` draws **256 deterministic random subsets per comparison** of available price-only v3 *episodes*, matching the funding gate's number of executable episodes. Each selected episode retains its real original direction, entry, exit and duration, so the null has matching modeled round-trip counts and selected holding-time mix. Exact additive episode PnL is independently checked against the full replay. This is an **ex-post, noncausal episode-selection diagnostic**, not an executable null trading system.

ETH selected case, assumed 15-minute embargo:

- Funding gate: 17 entries chosen from 50 eligible price episodes; candidate base net +0.2999%.
- 256 same-count nulls: base net median **+0.0355%**; discrete 95th percentile **+0.2829%**; fraction of nulls with net >= candidate **0.046875** (12/256).
- With 60-minute embargo: 15 chosen from 44 eligible; candidate +0.2602%; null median +0.0558%, 95th percentile +0.3258%; fraction null >= candidate **0.08203125** (21/256).

**Neither fraction is a significance p-value.** At least 32 related market × segment × candidate × embargo × funding-gate comparisons were inspected (not counting other models/earlier v1-v3 research), and experiments were chosen after viewing development evidence. A single apparent 95th-percentile exceedance under such selection is weak, and cannot be 'fixed' merely with a routine multiple-test correction on this exposed sample.

Counterexample to overgeneralization: BTC recovery-failure with `carry_receive`, first 60% sample, assumed 15-minute embargo: candidate -0.9807%, same-count placebo median -0.6056%, and 92.2% of random subsets performed at least as well. This gate adds little positive timing evidence there.

## Verifiable artifacts

Separate isolated Windows worktree `C:/Users/eahra/rakazo-alpha-pit-v4-20261029`. No other working checkout touched. Source scripts:

- `scripts/trading/algorithm_funding_v4.py` (SHA-256 `60da1767b5646698f5c0cf85bfb7c6860babc53cb85d75d7612dcce360bd7322`)
- `scripts/trading/algorithm_funding_null_v4.py` (SHA-256 `1d5f002e59bc047a2494d1b05de6c22da3636770ff900c58030a03d8c648052e`)
- `scripts/trading/test_algorithm_funding_v4.py` and `scripts/trading/test_algorithm_funding_null_v4.py`.

The complete `python -m unittest discover -s scripts/trading -p 'test_*.py'` run: **116/116 passed**. Dedicated tests cover embargo and as-of decisions, no synthetic missing rate, archive/receipt tampering, rejection/entry timing, holdout isolation, exact PnL and deterministic same-count controls. This is test success, **not scientific verification**.

Reports are local to the user's Windows research store, not GitHub, and not inside live PAPER:

1. `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/algorithm-funding-v4-development-20261029.json`, SHA-256 `2cdb19da903d061a1e1f4d1fb31f467c4e0f40d6a27d017936f7aa9e20a69ba7`.
2. `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/algorithm-funding-v4-matched-null-20261029.json`, SHA-256 `df4ae404bc28e71c9a3e6929fe651ab6dcfccb7d450c91c6162aa4106f475fe5`.

Both data inputs were backed by preserved monthly official archive ZIP receipts. Intermediary funding file SHA-256: BTC `e9fb0b35ccf10069306572e910ff7aa5c496b2644257c556b36692b729c59b4b`; ETH `d81901d0e7ab65174928653a2ccf05bb17c7270bfd89abf7c29a6bb2cc9f1970`.

Example execution (write to NEW paths only):

```sh
python -m unittest discover -s scripts/trading -p 'test_*.py'
python scripts/trading/algorithm_funding_v4.py --csv /data/BTC-USDT-SWAP.csv /data/ETH-USDT-SWAP.csv --funding /data/BTC-USDT-SWAP.funding.json /data/ETH-USDT-SWAP.funding.json --out /data/new-development.json
python scripts/trading/algorithm_funding_null_v4.py --csv /data/BTC-USDT-SWAP.csv /data/ETH-USDT-SWAP.csv --funding /data/BTC-USDT-SWAP.funding.json /data/ETH-USDT-SWAP.funding.json --out /data/new-matched-null.json
```

## Explicit next experimental gates

1. **Timestamp evidence:** collect independently verifiable point-in-time `published_at` and `received_at` metadata for every external feature (funding, historical orderbook/OI, news). Settlement timestamp alone is not enough. Records unavailable at decision time must be rejected; never backdate revised articles or OI.
2. **Broader historical market coverage:** secure verified data on the selected universe, target >=50 markets when actually available. Freeze selection/survivorship and exclusions before any scoring. Do not equate exchange's current liquid list to historical point-in-time liquidity.
3. **Realistic futures ledger:** obtain settlement completeness; apply observed funding only while positions are open, mark/index, contract sizing, execution costs, and separate margin/liquidation stress. No guarantees for stopping, DCA or leverage.
4. **Statistical protocol:** freeze entire feature set/grammar and new hypotheses *before* future time windows; use new forward observations (not previously exposed development periods), dependence-aware uncertainty, and multiplicity accounting. Report null, negative, and untradeable cases without suppressing them.
5. **No automatic trading:** no PAPER account, no active Trader changes, no orders, no schedule, no merge to main, no paid datasets authorized.

**Research decision: continue data-provenance work; abstain from trading.**
