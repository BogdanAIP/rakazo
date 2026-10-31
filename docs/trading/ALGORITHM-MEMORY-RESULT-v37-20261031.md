# Algorithm Discovery v37: causal memory verified, efficacy untested

**No independently effective algorithm has been found.** v37 implemented a delayed economic-memory operator and completed its frozen causal-readiness experiment. It did not perform a profitability test: the repeatedly opened two-date dataset is below the declared 20-prior-day requirement. A metadata audit also rejected the proposed August development cohort before any new price payload was downloaded.

Read the [frozen protocol](ALGORITHM-MEMORY-PLAN-v37-20261031.md), [six typed definitions](ALGORITHM-MEMORY-PROPOSALS-v37.json), [machine-readable engineering evidence](ALGORITHM-MEMORY-EVIDENCE-v37.json), [v36 negative result](ALGORITHM-BAND-RESULT-v36-20261031.md) and [next checkpoint](ALGORITHM-NEXT-v38.md). This result does not reverse any preceding negative experiment.

## Lineage, execution and scope

Parent result head: `02e2685dd07fd44a067a2bb5f834db32e3bfe60d`. Executable code and protocol were published at **`909fece17b9dd6f9172b41659ae1be90db408286` before the first v37 run**. The source worktree was clean and the run checked its exact head. There were six fixed programs, three memory policies, two rank controls and cash; zero fitted parameter variants or economic selection rounds. The first finite run completed normally in about 68 seconds within its 180-second bound, with empty error logs and no remaining owned worker.

The input remains NEAR/SOL on October 1 and 8: **1,494 available decision minutes out of 1,868** under v36's common mask. Each original source and restoration-cache hash was checked against the pinned v36 result. No replacement archive, reserved price payload, new independent holdout or forward observation was opened.

The reviewed mechanism changes the admission target from relative rank to matured, net quoted episode payoffs. At T, it queues only an anchor and directions. It can resolve the quote label at T+17 or later, and the current UTC day's labels cannot support that day's action. Exact state cells require at least twenty earlier UTC day blocks. The empirical statistic removes the two best day means; it is neither calibrated uncertainty nor a confidence bound. The candidate also requires a positive paired increment over the raw price-response direction. The separate price-memory learner remains a comparator; there is no guarantee of superiority over it.

## Actual readiness outcomes

| Instrument | Candidate / ablation actions | Price-memory actions | Matured labels: candidate / ablation / price | Maximum earlier day blocks per queried state | Rank liquidity / flow alarms |
|---|---:|---:|---:|---:|---:|
| NEAR | 0 / 0 | 0 | 10 / 10 / 36 | 1 | 29 / 29 |
| SOL | 0 / 0 | 0 | 32 / 32 / 51 | 1 | 38 / 33 |
| Total | 0 / 0 | 0 | 42 / 42 / 87 | 1 | 67 / 62 |

Cash also always abstained. Candidate and ablation have the same collected labels; they are not independent observations. No scheduled label was missing in this particular audit. This does not certify coverage outside these anchors.

Across all available minutes, the candidate had **657 nonzero proposals, all COLD_START**, and 837 zero proposals. Price memory had 1,400 cold-start proposals and 94 zero proposals. The floor was retained rather than reduced to produce trades. These zero-action results are expected engineering readiness outcomes, **not evidence that the mechanism is profitable, unprofitable or statistically safe**. The rank totals reproduce v36 exactly; their earlier negative economic results still stand.

## Future-quote stress and counterexample

At three fixed cutoffs in each panel, all later available bid/ask prices were multiplied by 1.1 in an in-memory copy. For the admissible operator, **12/12 full prefixes were identical**, including queue/history fingerprints, resolved and missing counts, and actions. Thus this was stronger than comparing mechanically zero actions.

An intentionally broken comparator read labels immediately at the anchor. It changed under future corruption in **7/12** comparisons, satisfying the frozen nonvacuity criterion of at least one detection. A concrete counterexample is NEAR October 1 at 04:00 UTC: premature reading changes the stored prefix although the observed prefix of prices has not changed. The reviewed operator remained invariant there. The broken comparator is excluded from the typed grammar and cannot become a strategy.

| Panel | 04:00 premature access detected | 08:00 | 14:30 | Reviewed prefix invariant |
|---|---|---|---|---|
| NEAR October 1 | Yes | Yes | No | 3/3 |
| NEAR October 8 | No | Yes | No | 3/3 |
| SOL October 1 | Yes | Yes | No | 3/3 |
| SOL October 8 | Yes | Yes | No | 3/3 |

The five undetected broken-control cases limit the sensitivity claim. Twelve perturbations are not a formal proof of causality, arbitrary future-feature invariance, receipt-time validity or robustness to every bug. Feature rows and source availability were held fixed in this experiment; the perturbation specifically targets delayed quote-label access.

## Protected-tail conflict: August cohort rejected

Five existing original price-data manifests were inspected as metadata only. Their declared 60/20/20 chronology implies a conservative final-20% protection boundary. BTC/ETH/XRP's known boundary is September 12 at 06:15 UTC. SOL/DOGE's shorter, 62-day manifest ends in August, placing its boundary at **August 19 at 06:15 UTC**. The machine-readable evidence retains all manifest and CSV SHA identities.

For the proposed NEAR/SOL foundation with BTC/ETH controls, the August 19 UTC+8 archive spans August 18 at 16:00 through August 19 at 16:00 UTC; August 20 spans the next day. Both intersect the SOL protected tail. **Reject the proposed August 1-20 cohort as a whole.** No prices from it were fetched, no tail was reopened, and no days were silently dropped to get a favorable sample. This is a conservative metadata conflict, not evidence that an old single-use claim actually occurred or that those tail outcomes were previously read.

July 1-20 has no known overlap with these five boundaries and explicit reservations. It is **a proposal only**: old claim-registry locations and their completeness remain unresolved, so this is not full source clearance or independent-cohort certification. Filename searches within the known research archive and older discovery worktree did not locate the missing claim registry; absence in those locations does not establish absence elsewhere. Public code accepts an explicitly supplied registry path rather than defining a universal registry location. Existing R resources did not resolve that path.

The full raw-file UTC bounds matter: the archive labeled September 6 can include September 5 UTC, and November 13 can include November 12 UTC. The new audit tests these adjacent-day cases. September 5 and November 1-12 remain closed.

## Verification, reproducibility and limits

The final relevant seven modules passed **81 deterministic offline tests in separate processes**: v31 9, v32 6, v33 3, v34 6, v35 11, v36 22, v37 24. Tests cover delayed resolver access, exact maturity, current-day exclusion, sparse-cell abstention, missing/nonfinite labels, clock regression, typed-grammar restrictions, scoped feature-catalog restoration and full UTC archive overlap. A preliminary shared-process discovery run executed 377 tests with one feature-catalog contamination failure in an older module. The broader per-module diagnostic did not retain a complete verdict within the tool response bound; no pass is claimed for it. Final isolated dependency checks are the reported evidence. This is an engineering-test issue, not an economic trial or threshold adjustment.

First v37 result SHA-256: **`425c35b51f0ee45e811322af1fb3c230e836757337fd1fecbba1ab78032302fd`**. Proposal SHA-256: `19237a0f9f465b71d3963e42c5558d198c2602f8b54656ae7d41b8ec6361b892`. Pinned prior v36 result: `e51d7d6e25c33c5d2a784f8d063e3756cbac93fe80d2712fab3f5d1014f56d5c`. Private receipts preserve the first output, logs and run/test checkpoints. Public evidence includes exact aggregate states and the original source/cache hashes; no raw records or machine paths are published.

For reproduction, check out the frozen head, restore the privately indexed verified original v34 source and v36 feature/result roots, then run `scripts/trading/algorithm_memory_audit_v37.py` with `--prior-root`, `--source-root`, `--proposals docs/trading/ALGORITHM-MEMORY-PROPOSALS-v37.json`, `--manifest-root`, a fresh `--out`, and `--expected-head 909fece17b9dd6f9172b41659ae1be90db408286`. The private roots are indexed by the R checkpoint. Use isolated unittest invocations for the listed modules. No network call is needed for this replay.

Delayed-feedback online learning is established in [Joulani, György and Szepesvári, ICML 2013](https://proceedings.mlr.press/v28/joulani13.html). No mathematical novelty or trading edge is claimed here. The empirical deletion statistic still lacks dependence-aware uncertainty calibration, multiple-state selection accounting and a frozen economic evaluation pipeline. These must be resolved before interpreting future positive development scores.

Realistic execution remains uncertified: historical quote crossing with a hypothetical 20 bp fee does not establish actual applicable fees, receipt latency, tradable size, slippage, funding or executable expectation. No new false-alarm/missed-move, warning-time, uncertainty or drawdown claim follows from cold-start abstention. Historical news first-availability coverage, OI, liquidations and funding remain UNKNOWN where provenance is missing. No found story does not mean no news.

Two instruments cannot establish transferability; at least 50 point-in-time verified markets, time separation, survivorship controls, a new independent test and subsequent independent forward observation without orders remain necessary. No orders, Trader/PAPER sessions, risk/account/provider changes, services, new automations, main changes, merges or deployments occurred. The control lease is released after checkpoint publication.
