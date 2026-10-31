# Algorithm Discovery v37: causal maturity and cohort audit

Status: **DEVELOPMENT engineering experiment; no trading-efficacy test or independent validation**. This protocol is to be committed with the complete implementation before the first v37 run. Parent: v36 result commit `02e2685dd07fd44a067a2bb5f834db32e3bfe60d`; read [its failure report](ALGORITHM-BAND-RESULT-v36-20261031.md) and [the v37 proposal](ALGORITHM-NEXT-v37.md). v36's 67 interval-accounting alarms averaged -14.4473 bp in a conditional historical quoted scenario. Re-ranking or retuning those scores is not the proposed mechanism.

## Mechanism and fixed program budget

Six definitions are data in [the typed proposal file](ALGORITHM-MEMORY-PROPOSALS-v37.json). A reviewed Python primitive interprets bounded existing AST arithmetic; proposal text is never executed. Three programs use delayed economic memory; two retain v36's past-only rank admission and one abstains.

| ID | Mechanism | Control/policy |
|---|---|---|
| liquidity-payoff-memory | Direction of the frozen v36 interval-accounting AST; state is direction and directional band execution capacity at least 1/2 | Absolute quoted net stability and paired increment over the raw price-response direction |
| no-incremental-memory | Same score, state and delayed memory | Ablation requiring only absolute stability |
| price-payoff-memory | Price-response direction; state is direction and past volatility capacity at least 1/2 | Same memory; paired increment over raw flow direction |
| rank-liquidity | Frozen interval-accounting AST | Prior 120-sample, minimum-60, 90th-percentile rank rule |
| rank-flow | Raw flow direction/magnitude | Same frozen rank rule |
| cash | Constant zero | Always abstain |

There are exactly six fixed definitions and zero fitted parameter variants. State capacity is `B/(Q_ask_new+B)` for buys and `S/(Q_bid_new+S)` for sells. The price-only state uses `sqrt(15)*past_sigma / (sqrt(15)*past_sigma+20+current_quoted_spread_bp)`. The half boundary compares equal numerator/remaining capacity; it is a declared representation choice, not optimized evidence of efficacy. A successful learner would still need ablation against alternative representations and temporal independent tests.

Memory anchors are the first scoped minute and every sixteenth minute from it; only causally available feature rows with a nonzero proposal are scheduled. The anchor rule, not an outcome-dependent choice, governs label collection. At T the queue stores only T, state, proposed direction and control direction. The existing quoted evaluator enters at T+1, exits no later than T+16, and subtracts a hypothetical 20 bp round-trip fee. No resolver call is allowed before **T+17 minutes**, including early barrier crossings. Incomplete paths are missing labels, never zeros. No quote or label is scheduled as executable model text.

At any decision, first average resolved labels within each UTC anchor day and exact state. Only days strictly earlier than the current UTC day count. A state needs **at least 20 distinct prior day blocks**. Its empirical stability statistic is the mean after removing the two most favorable day means. For the candidate, both that absolute statistic and its paired increment statistic must exceed zero. Otherwise the action is ABSTAIN. States cannot borrow other directions, cells or future observations. Current-day evidence remains excluded even if matured.

This deletion statistic is a deterministic sensitivity check, **not a confidence interval, lower confidence bound, dependence correction or guarantee**. Twenty days is a minimum design floor, not adequate power by assumption. The paired control inside candidate memory is a raw price rule; the separate price-memory program is a comparator, and the candidate does not enforce an in-sample guarantee over that learner. The earlier proposal's fully calibrated uncertainty-dependent admission is not yet implemented. It must be frozen before any economic-validation claim or new cohort evaluation.

Delayed feedback is established research: Joulani, György and Szepesvári, [Online Learning under Delayed Feedback, ICML 2013](https://proceedings.mlr.press/v28/joulani13.html), study online learners receiving outcomes after delays. v37 borrows this known causal requirement. No scientific novelty is claimed for the operator or its statistical sensitivity rule.

## First finite experiment: opened quotes, no efficacy conclusion

The only market inputs are the four repeatedly opened NEAR/SOL cases on October 1 and 8. Pin v36 first result SHA-256 `e51d7d6e25c33c5d2a784f8d063e3756cbac93fe80d2712fab3f5d1014f56d5c`, every original source hash and feature-cache hash stored there. Reuse v36's common availability mask: 1,494 of 1,868 decision minutes. No new archive payload may be acquired by this run.

1. Run all six definitions chronologically, preserving missing-label and cold-start reasons. Two observed dates cannot supply twenty previous day blocks: zero memory actions is the expected readiness result and is **not an economic rejection or validation**. Report maximum available day blocks per state and resolved/missing label counts.
2. At fixed 04:00, 08:00 and 14:30 UTC cutoffs in each of the four cases, multiply all later available bid/ask prices by 1.1 in a private in-memory copy. Compare the entire causal prefix, including internal history/queue fingerprints, resolved/missing counts and actions. All **12** comparisons must be identical. Comparing only zero actions would be vacuous.
3. Run a deliberately premature outcome-reader solely as an audit negative control. At least one of the same 12 corruptions must change its internal state; otherwise declare the stress inconclusive. This broken mode is not part of the typed operator grammar and is never eligible as a strategy.
4. Verify rank controls reproduce v36's common-mask totals: 67 interval alarms and 62 flow alarms. Preserve all result bytes and first failures; never overwrite a first run to hide a failed audit.

This is a finite engineering experiment, not a new PnL backtest. The sole historical quote-label proxy remains uncertified for receipt latency, actual fills/size, funding, extra slippage and applicable account fees. False alarms, missed independent moves, warning time, net expectation, drawdown and dependent-event uncertainty have not been economically re-evaluated for the memory strategy. Neither zero actions nor passing prefix tests supplies evidence for them. The frozen external wrapper has a 180-second timeout, retains logs/checkpoints and exits; it creates no service or continuing monitor.

## Metadata-only source-cohort protection

Before new source acquisition, audit the five existing original price-data manifests by byte hash and timestamp metadata. Do not read their price CSVs. Existing lab code declares chronological 60/20/20 splits, so conservatively protect each manifest's final 20%, computed from its first bar, count and interval. This metadata boundary is not proof that a single-use claim was made or its outcomes were accessed.

Audit the proposed August 1-20 UTC+8 archive-day labels against that tail and the explicit September 5 and November 1-12 UTC reservations. Check the full half-open UTC interval of each raw archive, including adjacent-day overlap. Preliminary metadata shows the SOL tail starts **August 19 at 06:15 UTC**; August 19 and 20 archive files intersect it. Reject the proposed August cohort rather than reading it or silently dropping days below the 20-day floor. Preserve exact computed conflicts and manifest SHA values in the run output.

Evaluate July 1-20 as a **metadata-only alternative proposal**, not approved acquisition and not independent data. A no-known-overlap result from five manifests is not complete clearance: the locations and completeness of older single-use claim registries remain unresolved. Keep `independent_cohort_certified=false`, `claim_registry_locations_fully_resolved=false`. Further registry/provenance work and a complete frozen executable acquisition/learning/evaluation pipeline are required before fetching replacement payloads. The audit must fail closed if manifest range/count metadata is inconsistent.

## Evidence and continuation boundaries

Preserve source SHA, typed formulas, six-program budget, lineage, first audit result, all counterexamples and unresolved limitations. Store raw data and receipts privately; publish code, protocol, aggregate engineering outcomes and the next checkpoint only. No new independent holdout is opened or claimed by v37. Repeated October cases remain DEVELOPMENT.

For a future economic experiment, predeclare event-dependence handling, all comparisons/ablation and multiple-attempt accounting, selection rules, false/missed-event definitions, warning time, day-block uncertainty, loss tails and drawdown. Freeze cost/latency/funding provenance rules; unknown inputs stay UNKNOWN. Original news needs known first-availability time before use as a feature. Existing selective news/calendar context is not a complete historical news feed, and a missing found story does not establish no news.

No general transferability follows from two assets. Broad claims still require at least 50 verified markets with point-in-time membership and survivorship controls, temporal separation, a new audited one-use independent test and independent forward observation without orders. No Trader/PAPER sessions, orders, risk/account/key/provider changes, paid data, other-project changes, new automations, services, main modifications, PR merges or deployments. Check live resources/ownership, avoid duplicate finite jobs and release the control lease when finished.
