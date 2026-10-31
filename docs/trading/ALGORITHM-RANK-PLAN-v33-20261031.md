# Algorithm Discovery v33: scale-free causal admission redesign

v32 did not pass its screen. One active memory candidate was negative after
quoted spread and the fixed fee scenario. Other candidates/ablations had zero
or very few alarms, exposing a numerical-scale limitation of the raw thresholds;
zero alarms do not falsify an entire market mechanism.

This DEVELOPMENT experiment changes admission representation rather than search
for a profitable threshold. Keep all nine v32 AST scores, sources, outcomes,
episode labels and costs unchanged. For every program, admit a nonzero current
score only when its absolute value is in the top 10% of its own strictly prior
120 available minute scores, after at least 60 previous scores. Use an empirical
midrank with ties; exclude current value from calibration. Reset memory across
source gaps but preserve the finite prior calibration history. Do not sweep the
rank, history or outcome horizon. The old raw-score thresholds are not applied.

Check original extracted cache SHA against the immutable v32 result before
reuse. Source gap abstention, quote freshness and snapshot rules stay fixed.
This is a new logged experiment after observing v32, not an independent retest
or a modification of its preserved first output. Evaluate all nine programs,
including paired no-memory ablations and three baselines under the same policy.

The >=4 alarms per panel, complete quoted paths and positive mean 20bp quoted
scenario in every panel remain the preliminary screen. Passing would only make
a candidate eligible for an independently predeclared test and later forward
verification; do not claim efficacy, causality or scientific novelty.

Known related concepts: [queue-reactive models](https://arxiv.org/abs/1312.0563)
and [order-book resiliency](https://doi.org/10.1016/j.finmar.2006.09.001).
An implementation in a bounded AST catalog is not scientific novelty.
