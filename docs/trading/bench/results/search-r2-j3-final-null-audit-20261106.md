# r2: final null-output audit and J3 numeric comparison — 2026-11-06

**19/19 controls PASS with exit 0; the J3 unfiltered numeric inequality passes. This is a search result, not demonstrated profitability, validation permission or a completed independent sign-off. J8 and Claude review remain mandatory.**

## Independent verification

On the authorized Windows host, after both existing worker PIDs disappeared, read the actual final result JSON and supervisor entry for each seed exactly once from the designated successful run: 0–6 original pooled run, 7–10 first continuation, 11 third continuation, 12–16 fourth continuation, 17–18 fifth continuation. No interrupted output was substituted and no seed was rerun.

For all19: exactly one result record with the expected null seed; seed41/population80/generations30; search_end_utc2025-03-01T00:00:00Z; finite best fitness; positive evaluated count; exact fitness/evaluated equality to its PASS/exit0 supervisor entry. Computed every final result SHA-256, all five status SHAs and the real-report SHA. Raw per-file receipts remain private. The independent private receipt digest is `b4f47eef6c0c651701b2d67fa9c26d387e5b58d4f12b9d05f7a317b75d7da79b`.

Recomputed all six input/code SHA-256 values against the precommitted expected pins read as AST literals from the existing supervisor: OKX search CSV/config, Binance search CSV/config, search module and bench module. All six matched; the supervisor itself was **not executed** during inspection. The real report has30 generations,535 evaluated genomes and the same search boundary. Its history maximum agrees exactly with its original PASS/exit0 status.

Four private exploration-ledger files were parsed as JSONL and SHA-snapshotted: original pooled17386 rows, third continuation1544, fourth6936, fifth2574. The first continuation shares an existing ledger; no standalone exploration file was found there. Snapshot receipt digest `190235f6c00be1541a0524b351838c9b08f160dc5076eeff4b5897857e26d901`. These counts include exploration/repeated panel records; they are **not** independent trades, new successful hypotheses or a complete deduplicated trial audit. Earlier interrupted ledgers remain preserved and excluded as completed null controls. No old ledger/config/result/status was rewritten.

## J3 table

Real unfiltered maximum: **0.8194797148106232**,535 genomes. Maximum null: **0.11606861509128619**,seed8. The real maximum strictly exceeds all19 unfiltered null maxima.

| Null seed | Unfiltered best fitness | Filtered top_fitness[0] | Evaluated genomes |
| --- | --- | --- | --- |
| 0 | -0.09474612992933024 | NA (empty list) | 618 |
| 1 | -0.31311427027945316 | NA (empty list) | 626 |
| 2 | -0.16553878005457812 | NA (empty list) | 694 |
| 3 | -0.13839452694855592 | NA (empty list) | 682 |
| 4 | -0.020030038825575303 | NA (empty list) | 775 |
| 5 | -0.1388218093558385 | NA (empty list) | 606 |
| 6 | -0.48123056983402146 | NA (empty list) | 611 |
| 7 | -0.371917369688485 | NA (empty list) | 687 |
| 8 | 0.11606861509128619 | NA (empty list) | 799 |
| 9 | -0.06717240216145037 | NA (empty list) | 764 |
| 10 | -0.20697320738266187 | NA (empty list) | 662 |
| 11 | -0.10575635107338811 | NA (empty list) | 772 |
| 12 | -0.13725047262216383 | NA (empty list) | 541 |
| 13 | -0.35784633651245346 | NA (empty list) | 731 |
| 14 | 0.10541616273939802 | 0.10541616273939802 | 728 |
| 15 | -0.2798819483252728 | NA (empty list) | 764 |
| 16 | -0.4953758470252102 | NA (empty list) | 704 |
| 17 | -0.31234910334868127 | NA (empty list) | 662 |
| 18 | -0.6127594354534216 | NA (empty list) | 625 |

Filtering is the original `diverse_top` filter, not the J8 novelty test. Empty lists are unavailable filtered values, not zero. J3 uses the unfiltered maxima as agreed. The real report does not store an exact filtered candidate fitness or per-panel period counts; those remain pending the predeclared deterministic candidate/reference replay. The earlier inferred candidate fitness (~0.4849103930) is not presented as a fresh exact observation.

Nineteen controls give at best1/20 nominal rank resolution for one round, not5% familywise assurance across all four search rounds or proof of economic edge.

## Supervisor terminal error retained

Resume5 finished `STOPPED_ERROR` at2026-11-06T19:58:53.132428+00:00 with `AssertionError()`, **after** null17 and18 had each recorded PASS/exit0. Null18 evaluated625 genomes, elapsed3312s, fitness-0.6127594354534216. Supervisor and child no longer appeared in the exact-PID process query.

Read-only source inspection explains the assertion: its final summary concatenates seeds0–6,7–10,11 and17–18, omitting12–16, and then asserts the list length is19. That list has14 entries. Thus the failed convenience summary is preserved as an actual error; it is not silently relabelled successful. The separate independent audit above explicitly includes12–16. No need to restart or repair any seed or mutate the stopped supervisor.

## Outstanding J8 / reviewer handoff

A single bounded search-only J8 replay attempt stopped at `PRE_START RAM` before loading panels, importing the evaluator or creating its independent output/ledger. Explicit subsequent file checks confirmed both absent. Host had briefly reported2333478912 available bytes before the attempt, but the actual pre-start measurement was below the unchanged2GiB guard. No threshold was lowered and no retry was launched.

**Next GPT:** when resources permit and no competing research process exists, independently replay only the existing carry reference and the single already selected candidate on the unchanged search exports. Record their own exact pooled fitness, per-panel period counts, matched-step correlations per panel and pooled, sample sizes and the candidate's funding-branch share. Use a new private verification ledger, never the frozen/common ledger. No GA, substitute candidates or new seed. If |rho|>=0.7, exclude the candidate as carry already tested; if none remain, no validation.

**Claude:** independently review this all19 table, source/receipt methodology and the summary-assertion diagnosis now; final r2 promotion review must additionally include the pending J8/period-count facts. The real unfiltered best is already known carry, not an independent new strategy. No validation/holdout, trading, PAPER, Trader, Docker, cloud run or spending occurred.
