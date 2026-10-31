# Algorithm Discovery v36 — fixed-band accounting failed development

The fixed `interval-accounting` candidate produced **67 alarms**, a pooled quoted mean of **−14.45 bp** after spread and the fixed hypothetical fee, and failed every panel of the prespecified screen. Three panel means were negative. The positive NEAR October 8 mean was beaten by simpler controls. None of the eight fixed programs passed the four-panel positive-mean screen. **No effective algorithm is established.**

## Frozen construction and provenance

The [complete protocol](ALGORITHM-BAND-PLAN-v36-20261031.md), [eight typed ASTs](ALGORITHM-BAND-PROPOSALS-v36.json), reviewed primitives and tests were committed and pushed at `867a8e397581e7d25eb1b42686d2e36d187b102c` before band extraction. All four October 1/8 NEAR/SOL source panels were already opened in v34/v35. This is **DEVELOPMENT**, not another independent test of them. The prior [v35 failure](ALGORITHM-PATH-RESULT-v35-20261031.md) remains unchanged.

The candidate compares displayed quantities at both endpoints of one minute inside the same absolute price band, anchored to the previous midpoint with half-width equal to twenty basis points plus the prior observed spread. Exact original execution prices and contract quantities are retained. Conditional passive-change proxies use `[Delta Q, Delta Q + total side executions]` to allow an unknown fraction of executions to consume displayed liquidity. A long requires a negative ask upper endpoint, positive bid lower endpoint and supporting buy flow, weighted by the completed-flow/cost-corridor capacity ratio; shorts are symmetric.

These are conditional accounting intervals, not statistical confidence intervals or a reconstruction of true cancellations, makers or hidden orders. Missing feed events or incompatible clocks can invalidate the accounting assumption. Static depth, all-executions-visible, depth-delta, OFI, flow and return controls remain explicit.

All **9,746,740** inspected original L2 rows, every inherited restoration bucket and all **2,476** historical quote observations reconciled exactly with prior extraction. Original archive/spool/trade and feature SHA chains were checked. There were no new downloads, source substitutions, retries or parameter changes. The complete finite five-stage pipeline finished without errors. All **63 deterministic offline tests** passed before the frozen run.

## Coverage and abstentions

All new programs share the same source/geometry mask. Out of 1,868 prespecified moments, **1,494** had available band features. The earlier 1,744 eligible moments lost a further 234 already-crossed bands and 16 stale-trade spans. Those exclusions are not silently removed from the study denominator.

| Panel | Available / 467 | Prior reset/quote exclusion | Price band already crossed | Past trade freshness unavailable |
| --- | ---: | ---: | ---: | ---: |
| NEAR 10-01 | 341 | 31 | 87 | 8 |
| SOL 10-01 | 423 | 31 | 11 | 2 |
| NEAR 10-08 | 305 | 31 | 128 | 3 |
| SOL 10-08 | 425 | 31 | 8 | 3 |

There were no depth-truncation exclusions in these four panels. A crossed band is a deliberate past-price eligibility condition, not evidence that nothing happened. Its greater frequency on NEAR restricts exposure to some larger already-started moves. The original nine retrospective price-path episodes remain in the missed-move denominator.

## Every fixed result

Each panel cell is **alarm count / mean quoted bp after observed spread and hypothetical twenty-basis-point round-trip fee**. Entry, fifteen-minute maximum holding period, volatility-scaled first boundary and sixteen-minute cooldown are unchanged. Pooled means weight alarms, not independent day blocks; they are not account returns or a paired causal effect.

| Program | NEAR Oct 1 | SOL Oct 1 | NEAR Oct 8 | SOL Oct 8 | Pooled mean bp |
| --- | ---: | ---: | ---: | ---: | ---: |
| interval-accounting | 16 / -33.23 | 21 / -21.20 | 13 / 24.55 | 17 / -18.25 | -14.45 |
| all-visible-point | 17 / -23.24 | 20 / -17.85 | 13 / 2.27 | 17 / -18.25 | -15.41 |
| depth-delta-only | 19 / -28.96 | 21 / -22.88 | 12 / 41.41 | 18 / -17.69 | -12.18 |
| band-capacity-state | 17 / -8.57 | 20 / -18.02 | 16 / -2.72 | 17 / -21.06 | -12.97 |
| canonical-ofi | 12 / -20.15 | 15 / -15.37 | 12 / -23.46 | 17 / -17.61 | -18.81 |
| flow-baseline | 14 / -46.80 | 17 / -23.34 | 15 / 17.59 | 16 / -27.51 | -19.81 |
| depth-baseline | 15 / -11.82 | 14 / -11.01 | 16 / -21.48 | 15 / -19.09 | -16.02 |
| return-baseline | 10 / -24.52 | 17 / -21.75 | 12 / 25.37 | 13 / -6.18 | -7.52 |

There were 504 quoted scenarios across eight programs, with shared and correlated source events; they are not 504 independent trades. All quote paths were available, and every program had at least ten alarms per panel. The candidate was rejected for a nonpositive mean in three panels and for no incremental mean on NEAR October 8. This is an active negative result, not a zero-trigger or below-minimum-alarm explanation. The two-day sample still lacks power for general market conclusions.

On NEAR October 8, the candidate's +24.55 bp was below depth-delta-only at +41.41 bp and return-only at +25.37 bp. Promoting that isolated day would repeat the posthoc selection problem that the fresh v34 pilot exposed. Pooled gross candidate mean before the fixed fee was +5.55 bp, but gross means remained negative on NEAR October 1 and SOL October 1. A fee reduction is not a supported cross-panel rescue.

The 67 candidate scenarios contained **21 positive and 46 negative** net quoted outcomes. All 67 were `CENSORED` under the much wider volatility-scaled first-boundary definition and exited at the fifteen-minute terminal observation. **Censored does not mean flat, safe or profitable.** Candidate early warnings matched two of nine separate retrospective close-path episodes; seven were missed, and 65 alarms matched no early episode under that definition. This diagnostic is distinct from profitable execution.

The prior unrestricted v35 pooled controls were OFI −10.90 bp, flow −20.72 bp, depth −19.23 bp and return −26.25 bp. Their v36 common-mask counterparts are in the table. Different coverage changes alarm admission and cooldown timing, so these comparisons do not identify a causal benefit from the mask or the new candidate.

## Conditional ambiguity and concrete counterexamples

A [separate post-run diagnostic](../../scripts/trading/algorithm_band_diagnostic_v36.py) rechecked the immutable primary result and every input cache. The following are source-feature counts before rank admission or cooldown, not financial success rates. A sign interval touching zero with nonzero width is counted as ambiguous.

| Panel | Either side sign ambiguous / covered | Raw interval nonzero | Raw point nonzero | Point nonzero, interval zero | Delta nonzero, interval zero |
| --- | ---: | ---: | ---: | ---: | ---: |
| NEAR 10-01 | 163 / 341 | 97 | 99 | 2 | 92 |
| SOL 10-01 | 47 / 423 | 215 | 221 | 6 | 18 |
| NEAR 10-08 | 155 / 305 | 84 | 84 | 0 | 97 |
| SOL 10-08 | 47 / 425 | 261 | 266 | 5 | 26 |

The interval condition had nonzero scores on 657 covered minutes versus 670 for the all-visible point estimate: only thirteen point-estimate opportunities lost their direction entirely. It excluded 233 of 890 depth-delta opportunities. On every observed minute with an active interval score, its direction agreed with both ablations and its magnitude did not exceed theirs, as required by the conditional bounds. Raw support nesting does not imply nesting of final alarms, because rank histories and cooldowns differ. The new uncertainty treatment changed timing/weighting but did not deliver consistent incremental returns in this sample.

Worst candidate quote scenarios per panel, selected **retrospectively for diagnosis**, are preserved below along with all original alarms. They are hypothetical historical quote outcomes, not actual fills or losses:

| Instrument | Signal UTC | Direction | Net quoted bp after 20 bp fee |
| --- | --- | --- | ---: |
| NEAR | 2026-10-01T07:06:00Z | Long | -145.07 |
| SOL | 2026-10-01T14:02:00Z | Short | -63.35 |
| NEAR | 2026-10-08T07:33:00Z | Long | -163.23 |
| SOL | 2026-10-08T04:25:00Z | Long | -82.63 |

The positive NEAR October 8 mean therefore coexisted with a −163.23 bp scenario. A mean alone does not establish controlled loss tails. Actual portfolio drawdown, funding, executable size and additional slippage are unavailable; two date blocks do not support a reliable cross-regime uncertainty estimate.

## News, antecedents and limits

Eight of the candidate's 67 alarms had a scheduled macro event in the preceding 120 minutes. This is a calendar join, not verified contemporaneous receipt or causation. The [selective original news register](ALGORITHM-NEWS-CONTEXT-v34-20261031.md) remains incomplete. Actual news, historical OI/liquidation/funding coverage and external initiators remain UNKNOWN; no news-based exclusion was fitted.

The protocol cites established queue and multi-level flow models. A further primary-source check located [Avellaneda, Reed and Stoikov's hidden-liquidity forecasting paper](https://pages.stern.nyu.edu/~jreed/papers/paper06.pdf), which explicitly models hidden liquidity in best-quote forecasting. Our interval construction is not a replication of that diffusion model, but neither conditional bounds nor liquidity forecasting constitute an established scientific invention here. No exhaustive novelty search or independent novelty claim is made.

Historical exchange clocks, five-second brackets and archive hashes do not certify trader receipt time or a gap-free sequence. Source freshness gates are historical data-quality conditions. Minute quotes omit intraminute paths. These limitations remain material even if a future development mean is positive.

## Reproducibility and next step

Primary JSON SHA-256: `e51d7d6e25c33c5d2a784f8d063e3756cbac93fe80d2712fab3f5d1014f56d5c`.

Post-run diagnostic JSON SHA-256: `535b98aad69cdceedba95dd21ba8ff35d3d567b55f6cb097a33c2fde6073bd8c`.

Raw sources, detailed records and finite-job logs are preserved privately. Code, definitions and aggregate evidence are public. The [v37 continuation proposal](ALGORITHM-NEXT-v37.md) moves from relative score ranking to a delayed-label economic-payoff memory and a larger predeclared development foundation. It is a new proposal, not implemented or independently validated. No fee/width retuning or promotion of the isolated positive day is authorized by this result.

The reserved September 5 and November 1–12 studies remain unopened. No live/PAPER orders, Trader or risk/account/provider settings, paid sources, main branch, merge or deployment were changed.
