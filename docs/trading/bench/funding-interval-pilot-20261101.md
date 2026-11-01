# Interval-consistent funding pilot (data quality DEVELOPMENT)

Implemented Claude's review at `91575f542d29ea80c65c37c5be3f9c017b19a187`; source commit `ea4fa812c67e4db4666e830e3cc428b71dbc8602`. Reproducible aggregate evidence is in [funding-interval-pilot-20261101.json](funding-interval-pilot-20261101.json). Raw sources, CSVs and individual receipts remain outside Git; prior pilots are preserved.

A billing day is a UTC calendar day of **bar opens**, so a nominal 00:00 settlement is charged in the preceding day's 23:00 bar. For interval I in {1,2,4,8} hours, observed billing hours must equal {I-1, 2I-1, ..., 23}. Both immediate adjacent calendar days must independently show that same complete pattern. Missing, irregular, partial, boundary and interval-change days fail closed. We do not bridge absent days or recursively propagate rejections. Actual observed rates are retained even on an unknown day; only blank no-settlement cells require inferred coverage.

**22/22 focused offline tests passed (1.628 s)**, including 11 new coverage tests: 3/3 at 8 h, 2/3 rejected, 6/6 at 4 h, changes, listing/source boundaries, missing calendar days, 1/2 h patterns, wrong phase, symbol isolation, zero rates, and midnight billing. Existing clock/duplicate and builder tests still pass.

A new finite build and independent panel audit both completed within the 900-second cap. Same 33 source dates, 142 symbols, 105,455 rows, 768 hourly decision bars and 3,504 eligible rows; eligibility mismatches remain zero. The new rule accepts 4,110 complete billing contract-days at 8 h, and leaves 561 observed contract-days unknown (278 incomplete/irregular patterns, 283 differing/missing adjacent patterns). **5,959 former blank cells become NA**: 5.6508% of all panel rows. Of 3,504 eligible rows, 1,554 now have unknown funding. These are row counts, not simulated position-bars or an efficacy verdict.

The old/new comparison checks every row: all nonfunding fields identical, all observed funding rates identical, only blank-to-NA changes. This pilot therefore exposes uncertainty previously hidden as zero without changing prices, volume, eligibility or source records.

This is retrospective archive-integrity inference, **not certified historical schedule or feature availability**. Later neighbouring days participate in missingness classification; they must not be represented as information already available to a trader. Systematic omitted events can imitate a slower interval. A period-specific schedule/availability policy and independent review are still required before freeze. No current schedule is backfilled into history.

Full three-year point-in-time coverage, former-listing completeness and the actual v0-v39 prior-trial audit remain outstanding. All 31 hypotheses and existing ledgers/configs are unchanged; strategy evaluations are zero. No freeze, holdout, trading, PAPER, July foundation restart or efficacy claim.
