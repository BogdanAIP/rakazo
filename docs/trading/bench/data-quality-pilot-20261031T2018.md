# Shared bench: 33-date original-source audit and first panel blockers

**Data acquisition completed; the panel did not build. No strategy efficacy was evaluated.** Under the [published finite plan](acquisition-plan-20261031T1941.json), 25 further October 2023 archive dates were acquired, bringing the sample to **33 dates / 66 original ZIPs / 132,450,355 compressed bytes**. New originals total **101,490,124 bytes**, within the 512 MiB batch cap and 900-second acquisition timeout. Free disk remained above 10 GiB (about 38.16 GiB afterwards).

Source dates are **2023-10-01 through 2023-11-02**, UTC+8 archive labels. Full raw UTC coverage is the half-open span **2023-09-30T16:00Z .. 2023-11-02T16:00Z**. All compressed files and individual SHA receipts remain outside Git; the public evidence contains aggregate audit output and a private-manifest digest, not original receipt records.

Code/source lineage: acquisition and bounds **`be86d2f3797a8abdb61d1720fd9e2ba3e2e4faaa`**; first strict pilot/audit **`f0f3bb5e2267f45c8b53852766e5c3707e8f6491`**; declared non-mutating diagnostic recovery **`6e0ab56f0bd1f51d46e70a6722ff22a04c412e63`**. Every first log/error and intermediate offline receipt is retained. Full [measured evidence](data-quality-pilot-20261031T2018.json) pins the run and log hashes. Private aggregate source-audit SHA: **`757bd449178138465ceb4602485b75a85f193a9dc876c9b1fe89a2be37d54b83`**.

## Actual source findings

| Observation | Result |
|---|---:|
| Historical USDT swap symbols observed | 142 |
| Original minute records | 6,527,997 |
| Unique instrument/minute keys | 6,526,501 |
| Extra records with identical field values | 1,496 |
| Non-identical duplicate variants | 0 |
| Invalid observed OHLCV records | 0 |
| Observed hourly groups | 108,783 |
| Incomplete hourly groups | 10 |
| Missing minute keys within those hours | 479 |
| Original funding events | 13,592 |
| Funding events off the exact hour | 13,417 |
| Fully observed 24-hour contract-days | 4,387 |

All 4,387 full-hour contract-days have three observed settlements. That supports a count-consistency check, not verified historical schedule completeness. Original off-hour funding offsets range from **1 to 39 seconds**; only 175 events land exactly on the hour. The diagnostic preserves original event times and performs no rounding. Eight-hour-plus gap counts in the JSON include seconds of timestamp jitter and must not be read as evidence of missing settlement cycles.

The 1,496 duplicate records have identical parsed field values; no replacement price was selected and the originals were not modified. Incomplete-minute causes remain UNKNOWN. Observed source breadth does not certify former-listing completeness, absence of whole missing hours or generalizable trading performance.

## First failures were preserved

The actual warmup-inclusive pilot build failed with **`Funding settlement is not hourly aligned: 1INCH-USDT-SWAP 1696089604000`**, an original timestamp at 2023-09-30T16:00:04Z. Its error/log SHA remains in the evidence. The first strict source audit then failed on **`Duplicate minute 1INCH-USDT-SWAP 1697108400000`**. No final hourly CSV was created.

Settlement billing time and a predictor's first information availability require separate treatment. An event recorded seconds after T must not silently become a feature available at the close at T through hour rounding; whether its rate was independently published earlier is UNKNOWN from these archives. A reviewed policy must handle both accounting and causal feature timing.

A separate, versioned diagnostic recovery inspected all 33 source dates without calling a price-selection/deduplication rule or changing funding timestamps. It completed within its independent 900-second limit. The metadata-only inspector distinguishes identical/non-identical duplicates and original settlement events; it does not make those inputs acceptable to the unchanged builder. The first failed attempts remain intact.

## Verification and next work

Claude's actual v40.3 fixed-unit correction is accepted for further data review. Replaying the previously published independent 48h fixture now gives **gross 0.75 and funding -0.01**, matching fixed quantities (v40.2 gave 0.50 and -0.0025). The separate cash fixture still omits one calendar step: `[0,1,3]` rather than `[0,1,2,3]`. The [older v40.2 review](gpt-review-20261031T1941.md) and failed numerical case are retained as history; they are not asserted to describe v40.3's corrected quantity calculation.

The branch already records an independent complete v40.3 suite of 36 tests. This stage additionally ran **12/12 focused current-engine/builder tests** (4.287 s) and **5/5 source-quality tests** (0.070 s, ResourceWarning treated as error). The earlier 29/34/38-test receipts identify their own snapshots; these counts are not merged into a fictitious current full-suite result.

**Claude review requested:** specify funding-event clock semantics and hourly entry/exit boundary treatment from provenance, review deterministic canonicalization of exact duplicate records with a fail-closed conflicting-variant policy, and address the distinct cash-calendar and predeclared **31 + audited prior trials** gate. The simulator's hourly close remains a settlement-mark proxy, with no certified margin/liquidation or short-borrow model. No silent funding snap, zero-fill, fee change or source repair was applied.

**GPT continuation:** inspect source duplicates/clock provenance and the ten incomplete hours, implement only reviewed data rules with offline regressions, then rerun a newly identified pilot while preserving these first attempts. Source acquisition may continue in separately bounded early-history batches after checking live ownership and checkpoints. The complete three-year point-in-time panel, audited prior-trial count, independent method approval and freeze still do not exist. All original **8 + 12 + 11** hypotheses remain unchanged; real evaluations, real holdout access and efficacy claims remain **zero**. September 5 and November 1-12, 2026 and all known protected intervals remain closed; the July foundation track stays paused. No orders, Trader/PAPER, main, deployments, provider changes or new automation were used.
