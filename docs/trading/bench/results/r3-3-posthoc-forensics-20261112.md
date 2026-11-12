# r3-3 — post-hoc failure-mode analysis (12 November 2026)

**Scope:** read-only *diagnostic* investigation of the **same previously consumed OKX validation period**, 2025-03-01 to 2026-01-31. This does **not** create a new validation trial, adjust the frozen rule, or qualify the algorithm for holdout or trading. The prior official verdict remains **INCONCLUSIVE_UNPOWERED**. No PAPER/Trader activity, accounts, orders, holdout reads or paid compute.

## Frozen identity and reproduction

- Candidate: `search-r3-3`, from `docs/trading/bench/hypotheses/search-r3.json`, SHA-256 `a8586399d5bb6b5211c69f2dd9ed66c771415482d07373349368b7cb3c1a3e00`.
- Formula: 60-day cross-sectional illiquidity (trailing mean absolute return divided by mean volume) **plus** 20-day residual momentum against a 120-day market beta; daily top/bottom 20% long/short, equal weights, beta normalization, 1-day holding.
- Frozen daily panel SHA `7aef07bd222a429d7b39d56cd0273ed0a9c34001c4cc6e1bd5b62e1874df0cce`, config SHA `de588938f5006ce426d5b927a6fec1189d854c410ca757ba242146b677e59e9e`, source SHA `80fe24eacc8c2972e6e0cc870c9c3ef92566f51da90c96d87c7151c3a23d1e6e`.
- Immutable original four-candidate validation report SHA `680e5da73413263d0b161b43a405ddc92de592f8a950379566548cdf53fe1855`. Diagnostic re-simulated only the original `r3-3` rule using `load_panel(..., end_ts=holdout_start_ts)`; holdout bars were never loaded into the simulation.
- Reproduction: **PASS**. All original aggregate gross PnL, funding, turnover, IC and IC t-stat reproduced, as did all four frozen fee-sensitivity annual Sharpe values (0/5/10/15 bp/side). Did not append to the trial ledger.

## Subperiod instability — main finding

All returns below are **simple sums of modelled daily P&L normalized to the book**, *not compound investment returns*, not realized trades, and not forward predictions.

| Region | Days | Price P&L | Funding | Costs (10 bp/side) | Missing-exit penalty | Net |
|---|---:|---:|---:|---:|---:|---:|
| April 2025 | 30 | +2,192.36 bp | −47.11 bp | −85.41 bp | 0.00 bp | **+2,059.83 bp** |
| All other months | 306 | +549.80 bp | +514.85 bp | −924.69 bp | −36.31 bp | **+103.65 bp** |
| Total | 336 | +2,742.15 bp | +467.74 bp | −1,010.10 bp | −36.31 bp | **+2,163.48 bp** |

**April alone explains 95.21% of the total modeled net P&L.** Removing April *post hoc* leaves a HAC annualized Sharpe of **0.067690** (vs original **1.142697**) and a mean net return of **0.338712 bp/day**, across 306 periods. This leave-one-month-out statistic is a *failure-mode diagnostic*, not another admissible test result or grounds for adjusting the fixed search rule.

Outside April, removing funding mechanically would change the simple sum from **+103.65 bp to −411.20 bp**. Across all 336 days, the same mechanical no-funding re-expression yields a HAC annualized Sharpe of **0.899723**, vs original 1.142697. These are decomposition calculations on the already disclosed period, not counterfactual fills or new trading variants.

The five largest positive days collectively contribute **+1,509.36 bp** vs the entire-period net **+2,163.48 bp**; the five worst contribute **−1,913.87 bp**. Only **171 of 336 days** have positive modelled net P&L. April supplies the main episodic price edge; funding helps offset fees and losses through the rest.

Monthly net modelled sums (bp), from the exact replay: Mar-2025 −375.61; Apr +2,059.83; May −127.37; Jun −260.20; Jul +548.18; Aug +439.27; Sep −110.74; Oct +575.79; Nov +144.07; Dec −354.63; Jan-2026 −375.11. Five positive months out of eleven; the last two are both negative.

## Predictive validity and exposure

- Original **Spearman IC = −0.051737**, HAC **t = −5.459**; *all four original fold IC values are negative*. A positive long/short book return can coexist with negative mean rank IC due to tails, funding and selection of extreme ranked quintiles. No evidence yet isolates which mechanism explains April. Do not flip the signal or tune a threshold in response to validation outcomes.
- Original DSR **0.319646** (gate requires 0.95), only **2/4 folds positive** (requires 3/4), the 95% bootstrap mean interval `[-5.543, +18.309]` bp/day crosses zero. Result remains **INCONCLUSIVE_UNPOWERED**, not PASS.
- Original annual Sharpe by transaction cost per side: 0 bp **1.683467**; 5 bp **1.412529**; 10 bp **1.142697**; 15 bp **0.873999**. Average turnover `0.300624` gross notional/day; 10 bp/side contributes about `3.0062` bp/day to drag. A rule prioritizing less-liquid contracts needs a more realistic slippage/market-impact review before any operational use; these four levels are just the frozen engine's fee assumptions.
- Exposure diagnostic re-simulated the unmodified rule with its original target weights: mean **model-implied beta ≈ 0** (mean absolute residual around `6.3e-17`); mean **net dollar exposure −12.90%** (April −14.31%). These are not the same type of neutrality. Correlation of daily model P&L with the same-day market mean return is **−0.0322**, so a simple directional market rebound does not establish the April mechanism. Neither market impact nor live execution was measured.
- Original 1-day portfolio had ~103 eligible coins per day, 4 missed entries and 4 missing exits; funding unknown share `0.840956%`. The illiquidity exposure and imperfect funding coverage are reasons for caution, not verified explanations of return.

## Interpretation and proposed next research gate

**Scientific status: weak and highly episodic**, not a validated executable alpha. The search-side J3/J8/J14 PASS/NEW receipts are genuine but do not overcome the independent validation verdict. **Do not open the protected 2026-02 through 2026-10 holdout**, do not promote to PAPER/real trading, do not recalibrate 20/60/120 lookback windows, weights or fees on this validation period, and do not rerun the official validation as a new trial.

Next defensible work: (1) independent non-author review of this decomposition and the existing receipts by Claude; (2) audit the implementation of rank IC versus extreme-quantile long/short P&L, the point-in-time liquidity eligibility and execution/cost realism using **search-side data or synthetic tests**, without rule changes justified by validation outcomes; (3) preregister an entirely **unseen time-and-exchange dataset** and its decision gate before checking any new model results, subject to the project's JOINT protocol. Binance 2021–2023 was **already used in pooled r3 search** and is not a fresh validation source. No data source, gate, holdout eligibility or spending may be changed unilaterally.

## Local private audit receipts

- Immutable private aggregate post-hoc diagnostic `r3-3-posthoc-20261112/posthoc.json`: SHA-256 `4e15e384c76268429451358e21b777bcc8b47f4dbec08e65cb2526b42a27f171`; runner SHA `13eda58e163c1af2a211d2a49933d153bc89e49267d7278556aec2de29f24009`.
- Exposure diagnostic `r3-3-exposure-20261112/exposure.json`: SHA `a56534629aff88540c2581c0a4b5500c34707fd8a645b9d068a572c7f938db84`; runner SHA `ea2fc4161a462a6e122bfec0cf80303030c4d6df90577e6960c587c9a5511be8`.
- The supplemental price/funding/fee region split above was recomputed read-only using the same pinned engine and validation panel; no private market panels, strategy ledgers or individual position logs are committed to the public research repo.
