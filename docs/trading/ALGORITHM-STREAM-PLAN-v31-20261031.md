# Algorithm Discovery v31: development-only tape-memory falsification

This is a new development experiment after the negative v30 result. All September
10/17 NEAR/SOL data have already been examined. No independent-validation or
profitable-algorithm claim is possible from this cohort. Reserved September 5 and
the November protocol are excluded. No accounts, orders, paid feeds or recurrence.

## Fixed search budget before evaluation

Four structural hypotheses, each paired with a memory-free ablation: absorption
release, absorption exhaustion, impact-surprise memory, and within-minute signed
execution sequence. Two simple baselines (signed flow and price response) plus
the original v29 tape trigger: eleven programs total, no parameter sweep.
Each proposed formula is bounded typed AST JSON, never executable model code.
Formula and evaluator changes after outcomes require another recorded experiment.

Read only preserved v30 source receipts and original SHA-verified taker prints and
confirmed minute prices. Aggregate actual executions strictly before each minute
decision, preserving signed volume in its first and last 20 seconds. Estimate
volume normalization on the previous 20 minutes and return RMS/impact regression
on the previous 60 minutes, excluding the current minute from those estimates.
These are tape features, not measured quote replenishment or maker identities.

## Fixed evaluation

Same 1,868 scope decisions as v30. Entry reference is the next minute CLOSE
(one-minute delay); examine the next 15 completed closes. Competing symmetric
barriers are max(20bp, 3*sqrt(15)*prior60minute_RMS_return_bp), frozen at decision.
Exit reference is first barrier-crossing close or horizon close. Deduct 10bp and
20bp round-trip fee scenarios. These values are delayed close-based diagnostics,
not quoted fills or realizable PnL; spread, slippage and receipt latency remain
unverified. No promotion based on these proxy returns.

After any selected alarm block further alarms for 16 minutes so hypothetical
exposure intervals cannot overlap. The original-v29 comparator is rescored with
this common horizon/cooldown; its original v29/v30 results remain unchanged.

Construct detector-independent retrospective episode labels by scanning every
scope decision in time order for a crossing of either normalized barrier over
the same delayed 15-minute horizon. Keep the first eligible anchor and suppress
new anchors for 16 minutes. This is one fixed operational definition of an
episode, not a census of every possible market movement. An early detection
requires an alarm in the correct direction at/before its anchor, at most five
minutes earlier. Report detected/missed episodes, unmatched early alarms,+warning time, adverse and censored outcomes. No outcome labels enter features.

A candidate can survive the development SCREEN only if it has at least four
alarms in every instrument/day and positive mean 20bp diagnostic in every case.
It must additionally beat its paired no-memory ablation and simple baselines
before any NEW prospective validation is contemplated. No multiplicity-corrected
statistical confirmation is claimed from this deliberately small search.

## Limits and next decision

Only two shared dates and two instruments: four panels are not four independent
market regimes. News coverage remains UNKNOWN and news predictive value is not
tested. Historical quote replenishment is not measured by this tape experiment.
The eventual broad standard remains 50+ provenance-verified markets and an
independent forward evaluation with actual quotes, costs and event availability.

If all candidates fail, preserve the negative results and revise the mechanism
rather than relabeling these observed outcomes as a new independent test.
