# Two-tail-day funding pilot (DEVELOPMENT data quality)

Accepted Claude's fix `2f78cb140b5cd4322debb03254b27d247776aae6`: two later UTC+8 source days are needed to certify the final billing day's adjacent pattern. The [prior pilot](funding-interval-pilot-20261101.json) remains preserved. A [published finite plan](funding-tail-batch-plan-20261101.json) preceded acquisition of November 3, **2023**, original candle/funding ZIPs: 4,626,354 new bytes; 32 MiB cap, 10 GiB disk floor, 300-second sync limit. Total 34 source dates / 68 ZIPs / 137,076,709 bytes, with private original receipts and manifest SHA in the [new measured audit](funding-two-tail-pilot-20261101.json).

Sync, separate pilot build and independent panel audit all completed, exit zero, within the combined 1,200-second cap. **25/25 focused offline tests PASS (2.064 s)**, including Claude's added boundary regression and two monthly missingness fixtures. Unchanged bench tests were not rerun. Missingness audit code: `be8f79db8b248f46bd51586255dd9694db513121`.

The panel still has **105,455 rows / 768 hours / 142 symbols / 3,504 eligible rows**, zero eligibility mismatches. Unknown funding fell from **5,959 to 2,998** rows; among eligible rows it fell from **1,554 to zero**. These are row counts and do not establish strategy position-bar coverage or returns.

| UTC month present in panel | All rows | All unknown | Eligible rows | Eligible unknown |
|---|---:|---:|---:|---:|
| 2023-10 | 102047 | 2977 | 1728 | 0 |
| 2023-11 (November 1 only) | 3408 | 21 | 1776 | 0 |

October unknown reasons: 2,935 rows have missing/irregular adjacent patterns, 42 have a missing/irregular own pattern. November: 21 missing/irregular adjacent-pattern rows. There are no eligible unknowns in either month, hence all eligible-unknown reason counts are zero. This one-month pilot cannot establish the frequency of historical interval changes over three years.

Across **all source archives**, the builder counts 11 incomplete hours / 534 missing minutes (previously 10 / 479). The added tail source contributes another 55-minute incomplete hour outside the panel window; its cause remains UNKNOWN and needs the same boundary audit. Do not describe source-wide counts as panel-only gaps.

Coverage remains retrospective inference, not certified historical funding availability. Full point-in-time panel, survivorship/listing completeness, historical interval provenance and actual v0-v39 trial accounting remain outstanding. All 31 rules, old ledgers/configs and protected dates unchanged. No real strategy evaluations, freeze, holdout, efficacy claim, orders, PAPER or July foundation restart.
