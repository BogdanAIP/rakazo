# Algorithm Discovery v32: original-book restoration development result

Status: NO CANDIDATE PASSED. Some fixed raw-score thresholds were nontriggering, so do not claim the corresponding market mechanisms were falsified.

The frozen evaluator and nine proposals were committed in fc163ba5 before extraction. The same previously examined v30 dates/instruments were used: development only, not independent validation. Original archive, spool and indexed snapshot hashes were verified. A total of 7931369 original L2 rows yielded 2,476 source-asof minute quotes; all passed the existing freshness checks. Of 1,868 expected scope decisions, 1,744 had usable restoration paths. The other 124 were excluded by the frozen snapshot-reset/missing-derivative rule, identically for every model.

| Program | Alarms | Early episodes / 6 | Mean quoted scenario after 20bp fees, bp | All-panel screen |
|---|---:|---:|---:|---|
| depth-baseline | 93 | 2 | -20.00 | FAIL |
| flow-baseline | 97 | 0 | -16.74 | FAIL |
| fragile-flow-memory | 23 | 0 | -9.18 | FAIL |
| fragile-flow-no-memory | 0 | 0 | NO ALARMS | FAIL |
| price-response-baseline | 96 | 2 | -21.18 | FAIL |
| restoration-flow-memory | 3 | 0 | -9.46 | FAIL |
| restoration-flow-no-memory | 0 | 0 | NO ALARMS | FAIL |
| restoration-transition-memory | 0 | 0 | NO ALARMS | FAIL |
| restoration-transition-no-memory | 0 | 0 | NO ALARMS | FAIL |

All selected alarms had complete original bid/ask paths. Entry crosses the quoted side after a full one-minute delay; exit crosses the opposite side. Observed spread is included and the 20bp round-trip scenario is additional. These are historical top-of-book scenarios, NOT certified fills or realized PnL: order size, further slippage, funding, actual fees and network receipt times remain unknown.

The active fragile-flow memory produced 23 alarms and a negative pooled quoted diagnostic, with negative results in three of four panels. Its one favorable panel is not a validated edge. Four of the nine programs generated no alarms; one candidate generated just three alarms, all in one panel. This exposes a numerical-scale/admission limitation and insufficient trigger coverage, not a proof that all forms of restoration information are useless. The raw absolute cutoff was inappropriate for several bounded score scales. Preserve this failure rather than quietly changing thresholds in the same experiment.

No new candidate detected any of the six predefined early episodes; the depth and price-response baselines each detected two. The episode definition and very small count limit power.

Validation: 28 offline tests passed. A synthetic indexed-replay integration test confirms that an update timestamped exactly at the decision is excluded from its prior quote. Sequence IDs were absent in the originals, so full continuity and live availability cannot be certified. News coverage remains UNKNOWN; no news prediction test was conducted.

Private immutable result SHA-256: `c885f95347c249a010cf8d33427c067379d59a40c8f3518f7b490ab32e1197e7`. Raw event archives and extracted paths remain outside the public repository.

Next recorded development experiment: v33 replaces raw-scale admission with a fixed past-only empirical-rank policy for all nine unchanged scores, candidates and baselines. This is a calibration redesign, not a successful independent test. Reserved holdouts, accounts, Trader and PAPER remain untouched.

Related prior work: [queue-reactive model](https://arxiv.org/abs/1312.0563), [order-book resiliency](https://doi.org/10.1016/j.finmar.2006.09.001). No scientific novelty is established.
