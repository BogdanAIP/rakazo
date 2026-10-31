# Algorithm Discovery v35 — event order development protocol

## Why this experiment

The v33 NEAR lead failed the complete frozen v34 test on both October dates. Neither its gross quoted result nor an optimistic zero-delay terminal diagnostic supports continuation of that rule. Its minute restoration share measured size changes at the previously best price, while price-level replacement and event order can convey different information. This is a new representation question, not an established reason for the failure.

The canonical best-quote order-flow imbalance (OFI) is a known method, attributed to [Cont, Kukanov and Stoikov, The Price Impact of Order Book Events](https://arxiv.org/abs/1011.6402). It combines queue-size changes and best-price changes. Their contemporaneous price-impact evidence does not demonstrate future crypto trading profitability. We use the canonical feature as a comparator and do not claim OFI or a unique AST is a new scientific invention.

A bounded prior-art audit of earlier operator/event proposals, v7, v23, v31 and v32 found related memory, price-response and pressure mechanisms. This experiment specifically tests an ordered path of unchanged-price queue contributions against price changes, rather than relabeling the v23 difference in displayed imbalance. This internal audit is not an exhaustive scientific novelty search.

## Source and feature definition

Only the already opened v34 October 1/8 NEAR/SOL cohort is permitted. All four panels are development data. No new market source is downloaded. September 5 and the November 1–12 studies stay reserved. Input identity is pinned to the immutable v34 result and its source/cache hashes.

For each net best-quote transition let old/new bid prices and quantities be b0/qb0 and b1/qb1; similarly a0/qa0 and a1/qa1. The reviewed primitive computes:

`e_bid = 1[b1 >= b0] qb1 - 1[b1 <= b0] qb0`

`e_ask = -1[a1 <= a0] qa1 + 1[a1 >= a0] qa0`.

Contributions are split by whether each side's best price stayed unchanged (static queue) or changed (transport). Each aggregate imbalance is divided by the sum of absolute side contributions, giving a bounded signed feature with zero for an inactive denominator. Canonical OFI here means this timestamp-coalesced implementation, not a claim to recover individual original orders.

Within a minute, X accumulates net static queue contributions, Y accumulates midpoint log changes in basis points, and `A += X_previous * dY - Y_previous * dX`. Normalize A by `(sum abs(dX)) * (sum abs(dY))`, zero when either factor is zero. Positive area describes queue pressure leading a price response of the same sign; negative area describes the opposite ordering. Area itself is direction-even, so the candidate multiplies its positive part by signed aggregate OFI. This deliberately separates path order from the trade direction.

All packets sharing the same exchange timestamp are coalesced into one net quote transition before feature accumulation. Unobserved order within a packet or among equal-timestamp packets is not invented. Each minute resets the path integrals. Snapshot minutes abstain under the prior derivative rule. Historical observations remain subject to unknown sequence continuity and trader receipt latency.

## Fixed search and controls

The [nine JSON AST scores](ALGORITHM-PATH-PROPOSALS-v35.json) contain one candidate, two order ablations and six simple baselines:

| Rule | Score / purpose |
| --- | --- |
| queue-leads-price | OFI times positive normalized area; candidate |
| queue-follows-price | OFI times positive negative-area; reverse-order ablation |
| order-blind-area | OFI times absolute area; discard the order sign |
| canonical-ofi | normalized total best-quote OFI |
| static-queue | unchanged-price queue contributions only |
| price-transport | best-price replacement contributions only |
| flow-baseline | actual executed taker-flow imbalance |
| depth-baseline | current top-five displayed imbalance |
| return-baseline | previous completed minute return normalized with earlier volatility |

All scores retain the unchanged past-only v33 rank admission, one-minute entry delay, first-boundary fifteen-minute quoted outcome, fixed twenty-basis-point hypothetical round-trip fee, sixteen-minute cooldown and the same four decision panels. No horizon, rank, fee, sign or threshold sweep. Raw AST thresholds are schema fields; rank admission does not use them.

The candidate development screen requires at least four alarms, complete quote paths and a positive mean after quoted spread and fee on every panel. On each panel it must also exceed the means of the reverse-order, order-blind, canonical-OFI, flow, depth and return controls, each with at least four complete alarms. Static/transport controls are reported too. This compares timing-selection rules, not a paired causal effect at identical alarm times. A positive screen would justify another untouched test, never an efficacy or novelty claim. All nine outputs, abstentions and failed screens are retained. Underpowered comparisons are distinct from scientific falsification.

## Integrity and finite execution

The existing replay and evaluation have optional reviewed instrumentation hooks; their original default behavior remains unchanged. Re-extraction must reproduce every old minute quote, restoration bucket and raw-row count before any new result is evaluated. New path caches and first results are exclusive-create files outside GitHub. The complete code, definitions and offline tests are committed before path re-extraction, although the source outcomes are already known.

Run four finite extraction subprocesses (up to 300 seconds each) and one finite evaluation (up to 180 seconds). Bound total wrapper lifetime to 1,500 seconds. Check the frozen git head and clean tree before starting, and preserve errors rather than silently editing and rerunning. No services, continuous market monitoring, live/PAPER orders, Trader configuration, account access, paid APIs or merges.

The v34 selective news register applies unchanged; each alarm's actual news coverage is unknown. No posthoc news exclusions are allowed. Larger independent multi-market evidence, calibrated receipt clocks and executable cost/size tests are still required before an algorithm can be called effective.
