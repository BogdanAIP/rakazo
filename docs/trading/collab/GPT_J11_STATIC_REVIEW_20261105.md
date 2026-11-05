# GPT independent static review of J11 — 2026-11-05

Reviewed branch commit `9ddf1955cbeab3b916643b098b547b9f2c4be6f0`, module blob `14739b39d99ec76f475bbe6a6a12ce4ee304efe3`, tests blob `16f2ed1e7d16021bb18f244af3b64b4e7289f50e`.

**Disposition: accept as a prospective building block, subject to the already agreed actual cross-host comparator. This is not an execution sign-off for r3/r4 or a change to r2.** Static review only in this pass; no tests or research computations were executed. R live-status access twice returned transient HTTP429, so the current Windows supervisor, null completion and exit codes are UNKNOWN.

The code explicitly fixes decimal contexts, score/fitness digits and the genome-string tie break. The tests exercise caller-context isolation, quantization-boundary failures and a simulated libm perturbation. Keeping the comparator and one-host fallback is essential.

## Corrections requested before the r3/r4 lock

1. Narrow the module's universal bitwise/correct-rounding claims. Python's official [fsum documentation](https://docs.python.org/3.13/library/math.html#math.fsum) explicitly allows a last-bit discrepancy on some non-Windows builds through intermediate double rounding. Decimal [ln/exp guarantees](https://docs.python.org/3.13/library/decimal.html#decimal.Decimal.ln) concern the decimal result at the configured precision. Inference: correctly rounding to 34 decimal digits then converting to binary64 is not, by itself, a proof of correctly rounded binary64 results for every input. This is a documentation limitation, not an observed counterexample to these functions.
2. `test_deterministic_log_gives_bitwise_equal_results` calls the same function twice in one runtime. It establishes repeatability, not Windows-versus-Linux equivalence. Before a whole-round host is selected, compare one SHA-pinned synthetic input corpus on the actual proposed runtimes, recording runtime/libmpdec/platform identity and output `float.hex()` digests, quantized scores, selection trajectories and final fitness. Use a fixed stored corpus: independently regenerating it via host libm can change its bytes.
3. Audit all integration sites in the NEW r3/r4 path, including simulation/statistics, cached features, tie ordering and RNG consumption. A helper module alone does not establish that the complete search uses the deterministic functions. No monkey-patching or replacement of frozen r2 code.
4. Preserve the strict comparator fallback: any mismatch means the entire affected future round stays on one pinned host. No tolerance adjustment, cross-host best-of selection or reinterpretation of the failed r2 comparator.

## Current continuation

First finish verifying the existing Windows r2 supervisor and all19 immutable per-null results, publish the J3 table and perform J8/Claude review before validation. Do not infer completion from elapsed time or an old PID. The r2 first-differing-generation/best-genome comparison requested by Claude remains pending private-file access; no value invented here.

No code, frozen configuration, ledger, seed, search budget, gate, holdout, Codespace or trading state changed.
