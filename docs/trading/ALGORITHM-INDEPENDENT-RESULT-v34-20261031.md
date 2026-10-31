# Algorithm Discovery v34 — independent historical pilot failed

The NEAR-only lead selected after v33 outcomes did **not** survive either new date. No effective algorithm is established. The precise `restoration-flow-no-memory` rule is retired under this protocol; these dates are now development data and cannot be reused as an independent test of a revised rule.

## Frozen test and data

The entire acquisition, replay, feature, admission and evaluation pipeline was committed and pushed at `dd88c1a37928100b3970204405e237a5fef95c2a` before accessing the new source cohort. The [preregistration](ALGORITHM-INDEPENDENT-PREREG-v34-20261031.md) and [three frozen AST definitions](ALGORITHM-INDEPENDENT-PROPOSALS-v34.json) specify the candidate and two comparators. NEAR was the primary instrument; SOL was a reported comparison and could not replace a failed NEAR endpoint.

A bounded metadata/filename and prior registry audit found no matching exact-date source records in the research archive before acquisition. A supplemental repository document scan found the dates only in the new protocol. This is an operational provenance check, not proof that nobody had ever seen these historical markets. Prior selection of the candidate among nine scores and the larger research history remain relevant.

Sixteen original OKX archives were acquired for October 1 and October 8, 2026: four executed-trade archives, four L2 archives and eight minute-candle archives, including BTC/ETH controls. Source bytes, original archive SHA-256, extraction receipts, spool hashes and feature hashes are retained privately. The fixed replay inspected 9,746,740 L2 rows. All 2,476 required minute quote observations were available under the frozen historical freshness rules. There were 1,744 usable decision points out of 1,868; 124 abstentions followed the unchanged snapshot/reset feature rule.

| Panel | Original L2 rows inspected | Usable decisions | Candidate alarms |
| --- | ---: | ---: | ---: |
| NEAR, October 1 | 2,102,664 | 436 / 467 | 19 |
| SOL, October 1 | 2,500,295 | 436 / 467 | 18 |
| NEAR, October 8 | 2,588,081 | 436 / 467 | 19 |
| SOL, October 8 | 2,555,700 | 436 / 467 | 16 |

These are two dates and two correlated instruments, not a broad market sample. The reserved September 5 and November 1–12 studies were not accessed.

## Primary result

The candidate uses the difference in bid/ask displayed-restoration shares when its sign agrees with executed taker flow. Admission remains the v33 past-only rank rule: 120 previous available scores, at least 60, absolute midrank at least 0.90, current score excluded, no zero-score signal. Reset intervals abstain.

Evaluation uses one-minute delayed entry, an opposite-side quoted exit, a maximum fifteen-minute holding period, the frozen volatility-scaled first-boundary rule, sixteen-minute signal cooldown and a fixed hypothetical twenty-basis-point round-trip fee. Positive means favor the sign of the selected alarm. These are historical quote scenarios, not actual returns or fills.

| Panel | Candidate mean after spread and 20 bp fee | Flow comparator | Depth comparator | Primary NEAR pass |
| --- | ---: | ---: | ---: | --- |
| NEAR, October 1 | −32.40 bp | −53.87 bp | −5.69 bp | No |
| NEAR, October 8 | −22.04 bp | +19.85 bp | −37.63 bp | No |
| SOL, October 1 | −27.13 bp | −23.82 bp | −12.04 bp | Comparison only |
| SOL, October 8 | −19.15 bp | −27.22 bp | −17.82 bp | Comparison only |

The prespecified NEAR endpoint required at least four alarms, complete quote paths, a positive candidate mean and superiority over both comparators on **each** date. Both dates failed. Before the fixed fee, but after crossing the quoted spread, NEAR means were still negative: −12.40 bp and −2.04 bp. Reducing this fee assumption therefore does not produce a positive gross result for these two primary panels.

Across the four panels the candidate generated 72 alarms, with a pooled mean of −25.40 bp after the fixed fee. The flow and depth comparators also failed the four-panel screen. All three programs had zero missing quote paths. The candidate detected one of nine price-path episodes under the unchanged early-detection definition; this is a separate diagnostic, not a replacement financial endpoint.

## Secondary entry-delay diagnostic

After the frozen primary pipeline completed, a separate [diagnostic](../../scripts/trading/algorithm_latency_diagnostic_v34.py) compared optimistic instantaneous entry with one-minute delayed entry for **every originally selected alarm**. Both scenarios exited at the same terminal observation, T+16 minutes, and retained the same twenty-basis-point fee. This terminal comparison does not reproduce first-boundary exits and was not used to change the primary verdict.

| Candidate panel | Optimistic instantaneous entry | One-minute entry, same terminal | Entry-delay loss |
| --- | ---: | ---: | ---: |
| NEAR, October 1 | −30.96 bp | −32.40 bp | +1.44 bp |
| NEAR, October 8 | −20.33 bp | −22.04 bp | +1.72 bp |
| SOL, October 1 | −28.03 bp | −27.13 bp | −0.90 bp |
| SOL, October 8 | −12.35 bp | −18.39 bp | +6.04 bp |

All instantaneous-entry terminal means remained negative. The measured one-minute entry loss does not explain away these negative terminal means. An instantaneous fill is optimistic and has no network-arrival or executable-size certification. For censored primary scenarios with the common terminal exit, 201 values reconciled exactly within the diagnostic tolerance across all three programs; no quote was missing. Simple constant-price and long/short entry-price sanity checks also passed.

## News and interpretation limits

The [selective news register](ALGORITHM-NEWS-CONTEXT-v34-20261031.md) records original US unemployment-claims releases, scheduled macro events and dated NEAR/Solana publications, with exact-time uncertainty retained. Eight of the 72 candidate alarms had at least one scheduled event within the preceding 120 minutes. This is a schedule join, not confirmation of what a trader knew or evidence of causation. Complete news coverage remains `UNKNOWN` for every alarm. No news filter was fitted to rescue the candidate.

The original source lacks sequence identifiers in the examined updates, so reconstructed historical quotes do not certify a gap-free real-time feed. Historical exchange timestamps do not establish trader receipt time. Minute sampling can miss intraminute boundary crossings. Executable size, queueing, funding and additional slippage are not known. These omissions preclude claims of realized profitability; accounting for them is not expected to improve the quoted execution assumptions.

## Reproducibility and continuation

The frozen code passed 37 deterministic offline tests before source acquisition. The immutable primary JSON SHA-256 is `1fedb2058c5612c5bee5e82d60ce31f7d1eb61fdc899e5890f340bda5c697272`. The secondary diagnostic SHA-256 is `9f4408c2b81132075b05d3aa2ea4adff5388cd0d4bbe85458b4853e813d0ed68`. Raw sources, detailed alarm records and job receipts remain outside the public repository.

The next development step is to inspect price-level transitions directly and compare a proposed mechanism with canonical order-flow imbalance and simple direction/state controls. The current restoration shares ignore some changes in the identity of the best price, and minute aggregation may hide event ordering; these are representation questions, not demonstrated explanations of failure. Any new rule must first pass development with explicit null comparisons, then freeze its complete executable pipeline before a new untouched cohort. The current four panels cannot provide that independent validation. No live or PAPER orders, Trader settings, reserved holdouts, paid services, merge or deployment were changed.
