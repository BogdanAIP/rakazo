# Algorithm Discovery: continuation after v35

Status: **proposal, not a frozen executable experiment, discovery or validated algorithm**. Read [the complete v35 report](ALGORITHM-PATH-RESULT-v35-20261031.md), preserve its immutable outputs and discover current private source locations through R resources. Work continues on `research/algorithm-discovery-path-v35-2026-10-31` or a new isolated research branch.

## Evidence and research target

The NEAR restoration lead failed both new v34 dates. The v35 ordered-path candidate then lost after the fixed fee on all four panels and underperformed canonical OFI on every panel. All nine v35 rules produced signals with complete outcomes; none passed the broad screen.

The secondary all-minute diagnostic found substantial perfect-direction hindsight opportunity on NEAR, while SOL's terminal hindsight medians were negative on both dates. These future labels are never live features. They suggest that a directional rank alone does not establish an economic opportunity. A selective SOL strategy is not proved impossible, and NEAR is not proved predictably profitable.

Investigate **displayed liquidity accounting inside fixed absolute price bands**, including uncertainty about executions against hidden liquidity. This changes the mechanism from top-five rank changes, previous-best restoration shares and path-order gating. Queue conservation and order-flow models are established antecedents; inspect prior implementations and primary papers before claiming novelty.

## Candidate construction to implement and review

At the start of a completed minute, anchor an absolute band to the previous midpoint. A proposed half-width is the fixed twenty-basis-point cost reference, with observed spread accounted for explicitly before the executable protocol is frozen. Keep the same price boundaries at both endpoints. Measure displayed bid/ask quantities Q0/Q1 in that band and actual buy/sell contract quantities V executed at trade prices inside that same band. Do not move the band with the new midpoint or infer executions from candles.

An accounting proxy for net passive change is `Delta Q + V_visible`. If complete synchronized public execution quantity only upper-bounds visible executions, the conditional passive-change interval is `[Delta Q, Delta Q + V_total]` on each side. This is conditional on compatible complete feeds and attribution; unknown historical sequence continuity and receipt timing prevent certifying an exact real-market identity. Public prints do not identify cancellations, makers or hidden orders.

A proposed long-side condition requires the ask-side upper bound below zero and bid-side lower bound above zero, with supporting buy flow; use the symmetric condition for shorts. Compare this conservative interval condition with a point estimate that assumes all executions were displayed. Also represent quantity needed to traverse a cost-sized corridor relative to strictly past flow, so directional pressure is distinguished from capacity for a material move. Do not extrapolate one minute of flow into a guaranteed future depletion time.

## Required implementation and controls

1. Reuse the existing replay and sample full-depth geometry only at scheduled quote times. Avoid sorting hundreds of levels on every update. Extend original-trade parsing to retain original price, quantity and SHA lineage. Preserve previous defaults and observations.
2. Require both sides to cover the anchored band, compatible contract units, the required trade interval and no snapshot reset. Record band crossing, insufficient depth and unavailable evidence as explicit abstentions. Never replace unavailable depth with zero or assert unproved source completeness.
3. Bound the search to one interval candidate, an all-executions-visible ablation, a depth-delta-only ablation, a static-capacity control and the canonical OFI/flow/depth comparators. Use reviewed typed AST primitives. Keep a price-response control so the rule cannot merely rename a completed move. Freeze exact formulas, candidate count, normalization, costs and evaluation before running.
4. Test moving-quote/fixed-band identity, visible/hidden execution extrema, contract units, missing coverage, same-timestamp boundaries, future-mutation invariance and parity of inherited observations. Review the staged public diff for privacy.
5. First run on opened development data. Retain all failures and do not tune v34/v35 fees, dates or signs to obtain a positive story. If rare triggers are underpowered, expand a mechanically selected development cohort instead of forcing trades in quiet periods or counting abstention as profit.

The earlier two-date all-panel screens are rejection gates for their fixed frequent-signal rules. A future rare-opportunity strategy needs a separately specified longer evaluation with calendar-time abstention, independent day blocks, exposure, loss tails and drawdowns. Set that protocol before outcomes. An inactive panel is not a passed profitability test.

## Continuation constraints

Preserve original compressed archives and budget disk explicitly; reproducible spools may later be retired only with verified originals and a recorded cleanup decision. No new acquisition is needed for the initial geometry-development test. Audit prior usage before expanding the source cohort.

Before any new independent test, freeze the **complete executable pipeline**, cohort, provenance gate and controls before accessing its new data. September 5 and November 1–12 remain reserved. The existing broader-market policy applies to transferability claims; two instruments do not establish them. A positive historical pilot still requires independent forward observations and credible availability/cost/size evidence.

Use finite checkpointed research jobs, check active R resources to avoid duplicates, preserve every first output and publish aggregate reports/code. Keep the existing research automation enabled; create no duplicate. No live/PAPER orders, Trader/risk/account changes, paid sources, local services, uncontrolled monitoring, main merges or deployments. Raw records and machine paths stay outside public GitHub.
