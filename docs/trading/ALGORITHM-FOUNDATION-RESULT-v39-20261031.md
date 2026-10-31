# Algorithm Discovery v39: July 2 batch and chronological replay

**No independently effective algorithm is confirmed.** The next chronological original-source batch completed without changing the six rules or pipeline. Two of twenty foundation days are now available. The memory policies still lack the required earlier-day support. Both active rank controls were negative on July 2 and remain negative across both dates.

Read the unchanged [frozen v38 protocol](ALGORITHM-FOUNDATION-PLAN-v38-20261031.md), [source cohort](ALGORITHM-FOUNDATION-COHORT-v38.json), [v38 result](ALGORITHM-FOUNDATION-RESULT-v38-20261031.md), [new aggregate evidence](ALGORITHM-FOUNDATION-EVIDENCE-v39.json), [July 2 news register](ALGORITHM-NEWS-CONTEXT-v39-20261031.md) and [continuation](ALGORITHM-NEXT-v40.md). All results remain **DEVELOPMENT**; neither old price data nor these new microstructure files earn independent-data status.

## Frozen method, original inputs and completed work

Run head: **`85c78b614064fa73b2a4d96f9fb8c7e0c4197f6f`**, published before July 2 payload access. The complete pipeline and source/proposal files are identical to the original freeze at `1d4eb395dc7c3f9971d2ecaf5e3644e18c0bf162`. Parent changes were reports only. Six typed definitions retain proposal SHA `19237a0f9f465b71d3963e42c5558d198c2602f8b54656ae7d41b8ec6361b892`; no parameter, fee, state or threshold variant was fitted. v39 is a data/evidence batch, not a new rule family.

Eight additional anonymous official OKX originals were downloaded and verified, totaling **212,661,143 bytes**: NEAR/SOL trades and L2 plus NEAR/SOL/BTC/ETH minute candles. New replayed L2 messages: **978,991 NEAR + 2,147,286 SOL = 3,126,277**. Across July 1-2 there are **16 original archives, 6,588,279 replayed messages** and 428,145,538 compressed source bytes.

The batch completed normally in about seven minutes within the unchanged 3,600-second outer timeout. All acquisition, unpack, extraction, evaluation and new-spool retirement checkpoints are COMPLETE. The previously validated 92-test dependency suite applies to unchanged code; it was not rerun or falsely counted as new testing. Two new real-data replay-integrity checks are reported separately below.

First cumulative result SHA: **`283a65bfbcdb755cfcb32e613ad77471e862ac9e0fb8db103dc51eb57ea25529`**. New acquisition SHA: `64c2ecdef0959c6fd854dbe769424ed4038b57ef12ef2231af089ed5aeace8cc`. Source-admission SHA: `734db6cb8939f6d72e62a13dde13dab9faf031f3e33cdfac9a674937725d03b8`. Source/feature/index/spool hashes, every program aggregate and first-run checkpoints remain preserved. No first output was overwritten.

## Coverage and all six programs

| July 2 decision minutes | NEAR | SOL | Total |
|---|---:|---:|---:|
| Registered | 467 | 467 | 934 |
| Available | 211 | 419 | 630 |
| Past trade-span/freshness unavailable | 183 | 4 | 187 |
| Price band already crossed | 42 | 13 | 55 |
| Reset/quote exclusion | 31 | 31 | 62 |

Across both days, **1,211/1,868** decision minutes are available. The same rules, including the five-second past-print requirement and common liquidity mask, apply on both dates; no filter was loosened to improve coverage. Price-path episode labels are fixed before liquidity exclusions, so missed movements in excluded periods are not silently erased. Source sequence identifiers and historical network receipt clocks remain uncertified.

| Program | July 2 alarms | July 2 mean quote proxy after hypothetical 20 bp fee | July 1-2 alarms | July 1-2 mean quote proxy |
|---|---:|---:|---:|---:|
| Liquidity payoff memory | 0 | Not estimated | 0 | Not estimated |
| No-incremental memory | 0 | Not estimated | 0 | Not estimated |
| Price payoff memory | 0 | Not estimated | 0 | Not estimated |
| Rank liquidity | 27 | **-13.4786 bp** | 53 | **-21.5437 bp** |
| Rank flow | 29 | **-22.1968 bp** | 57 | **-20.9388 bp** |
| Cash | 0 | No exposure | 0 | No exposure |

All four new retrospective episodes were missed, two per instrument. Across both days every program has **0/7 early detections**, and warning time is undefined. The rank programs' 53/57 cumulative alarms are unmatched to the early-warning definition; unmatched is not identical to economically losing. The controls overlap and share market days, so 110 alarms are not 110 independent trials. No quote path was missing on those alarms.

| July 2 control | Alarms | Mean quote proxy, bp | Additive quote-proxy drawdown, bp |
|---|---:|---:|---:|
| NEAR rank liquidity | 12 | -17.9294 | 306.5562 |
| SOL rank liquidity | 15 | -9.9180 | 160.4158 |
| NEAR rank flow | 12 | -24.4088 | 431.9238 |
| SOL rank flow | 17 | -20.6353 | 387.8586 |

These are conditional historical bid/ask scenarios with a hypothetical fee. Additive fixed-notional drawdowns are not actual account-equity drawdowns. Minute-close barrier labels, quoted scenarios and missing-path states remain distinct; a censored barrier outcome is not automatically safe or profitable. Actual applicable fees, latency, size/slippage and funding remain UNKNOWN where provenance is absent. No executable expectation is established.

## Memory and prefix integrity

At July 2 decisions, queried states have at most **one earlier UTC day**, below the fixed twenty-day floor. All three policies correctly remain COLD_START. By the end of July 2, cumulative matured labels are **35 candidate, 35 ablation and 65 price-memory**; candidate/ablation labels are shared rather than independent samples. No scheduled label was missing. The uncertainty routine remains `UNPOWERED_FEWER_THAN_20_DAYS`.

As an engineering integrity check, compare each full July 1 case in the new two-day evaluation with the immutable first v38 evaluation. **Both complete case objects and their canonical SHA values are identical**: NEAR `94546c76a5740ece23d6cee0c130e31641f22e3997a630faa7bafcbee1a959cd`, SOL `3cbd15b1e8441cc62362be39082ef544f97c5fe22ffc3a9f3db91e64c35df3da`. This comparison includes state fingerprints, resolved/missing counts, actions, labels and all metrics, not just zero memory actions. Adding the later source day did not alter the computed earlier prefix. The check's SHA is `3ef7fea803a2dee9d3f3d29ceaeac1ccb5e6a9b8f2609381247e9f69a0d0de33`.

That is evidence of this deterministic replay's integrity, not a general formal proof of causality or an economic validation. The prior first-result file remains unchanged at SHA `5e4801ca5deba8e63c9b7f15c56fd30f3604e2339c8a9e9d07b8ddab2c064c7a`. Retired July 1 spools were not reconstructed or required by the learning replay.

## Counterexample, market background and news

The largest July 2 quoted loss was a **NEAR short at 06:09 UTC**, present in both rank controls, at **-166.8301 bp** after the hypothetical fee. Preserve it rather than treating the common signal as two independent failures. A separate explicitly POSTHOC context pass used the unchanged v30 helper on **all 56 new rank alarms**, with original candle hashes pinned. Its output SHA is `371880f223472e5d90592d3d1619a0bb74e8ff6af5d8a0407bdf69f69c716fbc`.

In that helper's fifteen-minute T-origin minute-close context, NEAR rose **158.5624 bp**, the equal-weight BTC/ETH reference rose **17.3044 bp**, and NEAR's excess was **141.2580 bp**. This counterexample has a much larger asset-specific component than July 1's adverse SOL short. These context returns have different clocks from delayed quoted entry and are not substituted for the quote result or interpreted as tradable hedged PnL.

Across all new alarms, mean signed fifteen-minute excess over the same benchmark was NEAR rank liquidity **-17.8147 bp**, SOL rank liquidity **+0.7404 bp**, NEAR rank flow **-11.6498 bp**, SOL rank flow **-2.6973 bp**. The small positive fragment supplies no independent or fee-clearing edge and does not rescue the negative controls.

The official BLS July 2 archive declares an **08:30 ET / 12:30 UTC** release clock. The worst NEAR signal occurred earlier at 06:09; no news origin is assigned to it. The original July 2 vintage is kept distinct from later revisions. Census schedules a manufacturing release at **14:00 UTC**, but actual first receipt is UNKNOWN. DOL and Solana dated reports have no verified intraday availability in this audit. The [news register](ALGORITHM-NEWS-CONTEXT-v39-20261031.md) distinguishes official embargo, schedule-only, dated and UNKNOWN evidence. No consensus surprise, absent-news claim or causal attribution is fabricated; no annotation became a feature.

## Source protection, storage and continuation

The unchanged source guard audited **36 registered research worktrees plus the research archive**, pinned the five existing protected manifests and verified full UTC+8 file spans and relevant known training-region containment. Admission remains project-scoped DEVELOPMENT; global registry completeness, an unseen outside claim or absent NEAR dataset are not certified. No independent holdout was opened or claimed. The rejected August dates, September 5, November 1-12 and all known protected tails remain closed.

After successful evaluation, only the two new verified derived spools totaling **1,309,553,505 bytes** were retired under the frozen policy, with exclusive decisions and original/cache/index/result SHA checks. All compressed originals, receipts, indexes, caches and first outputs remain. No older or unrelated data was removed. About 39.43 GiB remained free.

Next is the already registered **July 3** batch, with the same code, six definitions, twenty-day floor and source safeguards. Read [v40 continuation](ALGORITHM-NEXT-v40.md) and live R resources before acting. Two training days do not justify changing a failed control until it looks positive, selecting a favorable subperiod or declaring the memory mechanism economically rejected. A development survivor still requires a newly frozen audited independent test, realistic execution provenance and independent forward observation without orders. Broad claims require at least fifty point-in-time verified markets with temporal separation and survivorship safeguards.

No orders, Trader/PAPER sessions, risk/accounts/keys/provider changes, paid data, new services/automations, other-project changes, main modifications, PR merges or deployments occurred. Owned finite jobs ended and control is released after publication. The continuing research goal remains unmet.
