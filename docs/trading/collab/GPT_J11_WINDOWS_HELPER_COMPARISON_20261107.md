# J11 actual Windows/Linux helper comparison — 2026-11-07 01:38 Moscow

**MATCH_HELPERS_ONLY, exit0 on the observed Windows run and exit0 on the separate CLI comparison.** This closes the missing actual second-host measurement for this fixed helper corpus, not the full-search integration/comparator requirement. `allows_round_execution=false`.

## Observed execution

Fresh branch HEAD `7703851d3cb8f98934750922ff06c1922abe7689`, STATE and latest Log read first; no newer Claude handoff. On the free authorized Windows desktop, verified no Python worker/old supervisor PID before the small synthetic job. Downloaded only three already-public files from that exact SHA into a new, separate synthetic directory: the helper, probe and existing Linux reference. Independently hashed both Python files and asserted their expected SHA before import. No private market file was read by this probe.

Ran `make_report()`, validated its complete schema/vectors/digests, wrote a new exclusive Windows JSON and compared it to the pre-existing Linux reference. Recorded actual Python exit0. Then separately ran the probe's normal `--compare WINDOWS_REPORT LINUX_REFERENCE` CLI: exit0, `MATCH_HELPERS_ONLY`, `differing_fields=[]`, `distinct_runtime_metadata=true`. A final process query found no Python worker. Closed only the inspection shell and successfully released the lease.

| Item | Observed value |
| --- | --- |
| Windows runtime | CPython3.13.7 / Windows; platform.libc_ver returns two empty strings |
| Existing Linux reference runtime | CPython3.12.14 / Linux / glibc2.39 |
| Helper SHA256 | `bc936abb480e5e4e1a010c1d2886b3ec86ffd836cae3399e25844822e562289a` |
| Probe SHA256 | `0f722987dbe50433b9c7a823e671a8f77497c3aba3faeb801e86e42ca5f2d613` |
| Fixed corpus SHA256 | `77b2e40cad52aa745ff2788dcdc82290ccbb65ea47846f9cbc9899c0db59ab4d` |
| Equal output-object SHA256 | `c64fc3c6585075c33b0b35b35e4d60473fb96a4d78bcabe71c9516951095deda` |
| Windows raw report SHA256 | `5458d371a61149de6e08c8aac6095ce408889b32e0e333ec4f6562efb72506d4` |
| Private comparison JSON SHA256 | `a0685702a3e64a0ad95b9f48e1c1213a681da4fd5bb8a8e0d160f5d9da09d978` |
| Downloaded Linux reference raw SHA256 | `4e23967a34177bbef635d8f8b9248dc6a57894d3fece4a457a8cf32f7c631eb8` |

The probe compares the full output objects, not just their hashes:70 finite canonical binary64 values across log/tanh/signed-log, score/fitness quantization, mean/correlation/pooled fitness, plus the complete7-genome selection permutation. Source and corpus digests also match. No tolerance or tuning.

Public Windows reference: `j11-synthetic-windows-reference-20261107.json`, commit `f8fc60f1a37525e76c8e7776231b5c9f7c9617d5`. For transport, rebuilt its content from the comparator-confirmed identical Linux output object/source/corpus fields and the observed Windows runtime metadata, serialized with the original sorted-key/indent2/Windows-CRLF convention. Its independently computed raw digest exactly matches the original Windows file digest above. Thus the public reference preserves the observed report bytes rather than claiming a second Windows run. The files contain synthetic values and generic runtime metadata only.

The existing helper/comparator tests were also rerun locally against these pinned source files:25/25 PASS, exit0, CPython3.12.14/Linux,1.333s. This is not a Windows unit-suite claim.

## What remains unproven / Claude review

This fixed corpus does not prove universal correct rounding, arbitrary `math.fsum` portability or host-independent real GA trajectories. It does not integrate J11 into future search code. The previous static-review limitations remain valid. The comparator's own statement about runtime authenticity is also retained: report metadata alone is not attestation; this pass additionally observed actual execution through the authorized Windows desktop.

**Claude:** independently review the Windows reference, exact source/output/receipt digests and prior completeness/static-review findings. Before r3/r4 lock, review the actual new code's complete arithmetic sites and compare integrated scores, ranking/ties, cache/selection, RNG consumption, every generation and final fitness across the intended pinned runtimes. No algorithm change or real r3/r4 evaluation is authorized by this helper match. J9-C1's r2 Windows-only decision and its failed Linux null8 comparator remain unchanged.

## r2 checkpoint remains blocked

At01:36 Moscow, the existing resume5 status again read STOPPED_ERROR/current_stage null-18; exact old supervisor/child and Python-process queries returned none. This is consistent with the previously audited completed19 controls and retained summary assertion, not a reason to rerun anything. J8 output and verification ledger were absent. Host available RAM2,090,205,184 bytes is below2GiB; disk23,911,587,840 bytes. **No J8 evaluation was attempted this pass.** Do not lower the resource floor or interfere with user applications. J3 numeric PASS stands; actual J8/period counts and Claude independent review still block validation. No GA, null seed, cloud, validation/holdout, ledger/config rewrite, PAPER/Trader/Docker/orders or spending.
