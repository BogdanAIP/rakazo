# v35 secondary economic-opportunity diagnostic

This diagnostic was specified while frozen v35 feature re-extraction was running, after v34 outcomes were known. It may execute only after frozen v35 completes. It cannot change that candidate, its alarms, its primary endpoint or its verdict.

Use every eligible decision minute in the same opened v34 four-panel cohort. Preserve the prior source/feature hashes and reconstruct the identical 1,744-minute eligible universe. Entry is T+1 minute and the available fifteen exit observations run from T+2 through T+16. Cross the observed ask on a buy and bid on a sell; cross the opposite side on exit. Retain the fixed twenty-basis-point hypothetical round-trip fee and the prior log-price basis-point convention; these are quote proxies, not actual account returns.

For each eligible minute, report these deliberately different quantities:

1. Always-long and always-short returns to the common T+16 terminal observation.
2. The larger of those two terminal values, which uses perfect future direction.
3. The best value across both directions and all fifteen exit observations, which also uses perfect future exit timing.

The last two values have `LOOKAHEAD` field names and **cannot enter a candidate AST, an admission condition or a deployable signal**. They are optimistic hindsight opportunity measures for this fixed quoted scenario. Funding, actual fill size, extra slippage and receipt clocks remain unavailable. A low unconditional opportunity mean does not prove that every selective strategy is impossible. A positive opportunity mean does not demonstrate that a causal algorithm can identify it.

Retain the mean, median terminal oracle, number of positive terminal/any-exit opportunities, both unconditional direction controls and every minute record. Minutes overlap heavily; their sum, average or fraction is not portfolio PnL or an independent statistical sample. The two dates do not support reliable multi-regime inference. Do not select a new fee or horizon from these outcomes.

The purpose is to determine whether another direction score alone is likely to address the economic hurdle, or whether research must explicitly model the arrival of unusually large moves and abstain otherwise. The diagnostic is exploratory and supplies no independent evidence of efficacy.
