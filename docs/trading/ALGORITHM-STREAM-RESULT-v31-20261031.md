# Algorithm Discovery v31: negative tape-memory development result

Status: FOUR NEW MEMORY CANDIDATES REJECTED BY THE FIXED DEVELOPMENT SCREEN. No independently validated effective algorithm.

The evaluator and ten typed AST proposals were committed before this run in 0a418996. Data are the already-examined v30 NEAR/SOL September 10/17 archives. This is development, not a fresh holdout. The unchanged eleven-program budget includes four candidates, four no-memory ablations, two simple baselines and the original v29 trigger rescored under the common new diagnostic.

| Program | Alarms | Favorable / adverse / censored | Early episodes detected / 6 | Mean delayed-close diagnostic after 20bp, bp |
|---|---:|---|---:|---:|
| absorption-exhaustion-memory | 87 | 0 / 1 / 86 | 0 | -12.80 |
| absorption-exhaustion-no-memory | 77 | 1 / 0 / 76 | 0 | -23.29 |
| absorption-release-memory | 30 | 0 / 0 / 30 | 0 | -24.49 |
| absorption-release-no-memory | 0 | 0 / 0 / 0 | 0 | NO ALARMS |
| execution-sequence-memory | 69 | 0 / 0 / 69 | 0 | -30.99 |
| execution-sequence-no-memory | 46 | 0 / 0 / 46 | 0 | -28.73 |
| impact-surprise-memory | 76 | 1 / 0 / 75 | 1 | -16.21 |
| impact-surprise-no-memory | 71 | 0 / 0 / 71 | 1 | -6.72 |
| original-v29-trigger | 37 | 0 / 0 / 37 | 0 | -13.62 |
| price-response-baseline | 96 | 0 / 0 / 96 | 2 | -21.98 |
| signed-flow-baseline | 97 | 2 / 0 / 95 | 0 | -14.53 |

All 1,868 decision minutes across four panels were evaluated. The fixed greedy normalized-price-path definition identified only six nonoverlapping episodes; this small label count is itself an important limitation. The label procedure is independent of the candidate and includes missed episodes. Two early episodes were detected by the simple price-response comparator, one by impact-surprise memory and one by its no-memory ablation; the other candidates detected zero.

Memory did not produce a robust cost-adjusted diagnostic. No candidate had positive mean after the 20bp scenario in every panel. A zero-alarm ablation is not evidence of memory superiority. One ablation has a positive pooled diagnostic at 10bp but fails across panels; do not select a cheaper fee assumption after inspection to declare success.

Every entry uses a full one-minute delay. Exit uses first normalized boundary-crossing completed close or the fixed 15-minute horizon. No overlapping hypothetical exposure. These are price-path diagnostics with fee deductions, NOT executable quotes or real PnL. Intraminute crossings, spread, slippage, order size, receipt latency and actual account fees are unverified. Quote replenishment and news prediction were not measured. News coverage is UNKNOWN.

Validation: 22 deterministic offline tests passed, comprising nine new causal/outcome tests and thirteen existing v29/v30 tests. Prefix invariance, past-only normalization, delayed entry, adverse-first ordering, missing horizons, nonoverlap and missed-event labeling were checked. No source archives, accounts, PAPER, live trading, schedules or reserved holdouts were changed.

Immutable private result SHA-256: `9f8bb798383a250d0c68c9b7045f0d989dd13f056839d214588ebb274c24162a`. Raw sources and per-alarm records remain outside this public repository.

Next experiment: measure restoration of displayed liquidity from actual original L2 updates rather than infer it from price/flow alone. Treat any resulting candidate as development until a separately frozen independent test.
