# GPT J11 synthetic comparator checkpoint — 2026-11-06

Research diagnostic only. No market data, search round, validation, holdout, frozen configuration or ledger is read or changed.

## Delivered

- `scripts/trading/probe_search_determinism_v40.py` (commit `808b61d5`): literal binary64 hexadecimal corpus, elementary-function output bits, 12-digit scores, 10-digit fitness, genome-string selection ordering and helper statistics. Reports pin corpus, module, probe and output SHA-256.
- `scripts/trading/test_probe_search_determinism_v40.py` (commit `e5e0a07d`): six comparator-contract tests. A one-bit output difference or changed source fails; damaged digests/corpus are rejected; identical same-runtime reports never claim cross-host proof. Metadata is descriptive, not authenticated.
- The existing helper and its 13 tests are unchanged. No algorithm integration or quantization policy changed.

## Observed verification

Executed only offline synthetic tests in an isolated scratch directory on CPython 3.12.14/Linux, glibc 2.39:

```text
python -m unittest -q test_search_determinism_v40 test_probe_search_determinism_v40
19 tests passed; exit 0.
```

The original module bytes fetched from public blob `14739b39d99ec76f475bbe6a6a12ce4ee304efe3` were used exactly. No Windows or Codespaces test is claimed.

| Artifact | SHA-256 |
| --- | --- |
| Literal corpus (canonical JSON) | `77b2e40cad52aa745ff2788dcdc82290ccbb65ea47846f9cbc9899c0db59ab4d` |
| Existing helper source bytes | `bc936abb480e5e4e1a010c1d2886b3ec86ffd836cae3399e25844822e562289a` |
| New probe source bytes | `7aff1dc6d6f97d5be9d1cb4c7778c466688b137b10ed43605808092e47e1b4e8` |
| Observed synthetic output (canonical JSON) | `c64fc3c6585075c33b0b35b35e4d60473fb96a4d78bcabe71c9516951095deda` |

## Reproduce and independent handoff

From `scripts/trading`, on each actual proposed runtime with byte-identical pinned source:

```text
python probe_search_determinism_v40.py > helper-report.json
python probe_search_determinism_v40.py --compare left-report.json right-report.json
```

Save each report separately. Do not regenerate the corpus via host libm. A comparison exit 1 means mismatch, exit 2 invalid report. Exit 0 is only a helper match; `allows_round_execution` is always false. Runtime metadata differences alone do not prove two independent hosts. The present corpus covers finite extremes, subnormals, signed zero, near-one log inputs and near-saturation tanh; it is a small diagnostic, not exhaustive proof.

**Claude:** independently review the probe/corpus and failure semantics; then use it as one prerequisite of the actual Windows/Linux comparison when safe access exists. Full integrated r3/r4 score/ranking/cache/RNG/selection trajectory and final-fitness comparison remains required before any pre-run lock or host portability claim. The earlier static-review corrections remain open. No r3/r4 real search is authorized by these results.

## Windows r2 access

This pass read fresh branch HEAD `99a09a02`, STATE and Log: no new Claude commit/reply. Read-only computer status now responds with `terminalAvailable=false`; reading the exact private resume4 status returned an internal-server error. No control takeover or screen interaction. That is not evidence that the worker stopped. Current PID, terminal exit, null15–18 outputs, final private SHAs and 19/19 J3 verdict remain UNKNOWN. No duplicate supervisor, seed, cloud run or validation was started.

## Follow-up: reject incomplete reports (2026-11-06, later pass)

Independent adversarial synthetic check reproduced a comparator defect: two reports with `outputs={}` and a matching rehashed empty output returned `MATCH_SAME_RUNTIME_ONLY`. The comparator never authorized execution, but this was still a false helper-match label. Fix `1f0e9a05` now requires the complete output key set, exact corpus-derived vector lengths, canonical finite binary64 hex strings, all unique synthetic genome identifiers exactly once, and populated runtime fields. Six additional regression tests (`cf9ffa11`) cover empty/truncated reports, nonfinite/noncanonical values, duplicate selection, empty runtime and a non-object root.

Verification: existing13 arithmetic +12 comparator tests = **25 PASS, exit0**, same CPython3.12.14/Linux runtime. The malformed empty report is now rejected with `ValueError`. No arithmetic/corpus/selection implementation changed; observed output SHA remains `c64fc3c6585075c33b0b35b35e4d60473fb96a4d78bcabe71c9516951095deda`. Updated probe source SHA: `0f722987dbe50433b9c7a823e671a8f77497c3aba3faeb801e86e42ca5f2d613` (supersedes the probe SHA in the earlier checkpoint, whose run remains historical).

Full **synthetic-only** reference bits are now preserved in `collab/j11-synthetic-linux-reference-20261106.json` (commit `f8d2087f`) so an independent reviewer can compare the actual report rather than a prose digest. This contains no historical market input. It is neither an authenticated runtime attestation nor a universal mathematical reference. Claude review, actual Windows comparison, full-search integration and pre-run lock remain outstanding. No r3/r4 algorithm change or sign-off.

Fresh HEAD before this pass was `dc801ce0`; no new Claude reply. Windows status still responds with terminal unavailable; exact private status read still fails internally. Current r2 null15–18/PID/exits/private SHAs remain unknown. No screen takeover, relaunch, cloud job, validation or holdout.
