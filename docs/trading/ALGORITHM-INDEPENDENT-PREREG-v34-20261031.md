# Algorithm Discovery v34: frozen fresh-date NEAR-specific pilot

This protocol and the COMPLETE executable adapters, extraction, signal and
evaluation pipeline must be committed before ANY designated market source is
downloaded or its outcomes inspected. A metadata/filename-only audit of the
existing research archive found no exact October 1/8 filenames or matching
receipt/registry/manifest records. This bounded audit is not proof that no human,
model or unrelated source ever saw those historical prices.

## Selection and new scope

Development v33 examined nine scores on September 10/17 NEAR/SOL. None passed
its broad criterion. `restoration-flow-no-memory` was positive on both NEAR days
and negative on both SOL days. Selecting it and restricting the hypothesis to
NEAR was POSTHOC. This new test explicitly records that selection; never relabel
the development finding as independent evidence.

Freeze original OKX UTC+8 archive labels **2026-10-01 and 2026-10-08**, primary
NEAR-USDT-SWAP and comparison SOL-USDT-SWAP, with original BTC/ETH minute candles
as unchanged market controls. No replacement dates or instruments if source,
provenance or resource checks fail. September 5 and November 1-12 are excluded.
Use 467 exact minute decisions per panel, 02:00..09:00 and 14:00..14:45 UTC,
1,868 expected in total. Feature warmup and outcome coverage follow v33.

Exactly THREE frozen ASTs: the selected `restoration-flow-no-memory`,
`flow-baseline`, and `depth-baseline`, byte-equivalent definitions selected from
the v32 proposal JSON. No other candidates or parameter search on new outcomes.
Keep the same original L2 representation: positive/negative displayed quantity
changes at previously best prices, neutral restoration share 0.5 if no changes,
bid restoration minus ask restoration, signed-flow agreement gate. This does
not identify orders, makers, cancellation/execution identities or causality.

## Exact signal and outcome

Use the unchanged v33 empirical absolute midrank policy: prior 120 available
scores, at least 60 prior observations, >=90th percentile, zero-score abstention,
current score excluded from calibration. No memory term in the chosen candidate.
Book observations are strictly before T (target T-1ms). Prior and subsequent
source-time brackets must each be <=5 seconds. Snapshot-reset minutes abstain.
Preserve missingness in the expected decision denominator; all comparators use
the same availability rules. Sequence IDs and live receipt times may be absent.

One-minute delayed entry crosses original ask for long/bid for short; exits
cross the opposite side. Observe the next 15 minute quotes for first crossing
of +/-max(20bp,3*sqrt(15)*previous60minute_RMS_return_bp), otherwise exit at the
fixed horizon. Fixed 16-minute alarm spacing prevents overlapping scenarios.
Observed spread is included; additional round-trip fee scenario is **20bp**.
Report all outcomes, signal counts, algorithm-independent episodes, misses,
warning time, missing quotes and each panel's quoted result.

## Primary pilot rule

On EACH of the two NEAR days require >=4 candidate alarms, no missing quote
paths, a positive mean after the quoted spread and 20bp fees, and a larger mean
than BOTH frozen flow/depth comparators on that same day. Both days must pass.
Do not accept pooled-positive/one-day-negative results, change fees, exclude
losing signals, change the rank/horizon or substitute SOL for a failed NEAR day.
All SOL results remain visible comparison evidence, even if negative.

This is a deliberately small **historical pilot**, not statistical confirmation,
forward validation or certified PnL. Sparse days, dependent events and prior
selection among nine variants prevent a broad significance claim. If successful,
expand independent periods and perform order-free forward evaluation with real
availability/cost evidence. A broad transfer claim still needs 50+ verified
markets. If unsuccessful, preserve the result and retire this narrow candidate
for this protocol, rather than tune against the same new cohort.

## Original sources and finite resources

Use the existing official-source URL schema with a NEW explicit two-day allowlist
and a separate source root. Existing v30 defaults/roots stay unchanged. Verify
HTTP origin, byte lengths, ETag/range resume, archive/decompressed SHA-256,
expected single member, snapshot hashes and monotonic source clocks. Legacy
receipt and feature-file format versions are reused for compatibility; exact
source dates and SHA remain explicit. No outcome-derived synthetic replacements.
No original source is venue-signed, and missing sequence IDs limit continuity.

Fixed compressed source cap 400MiB/file, ZIP member cap 128MiB, uncompressed L2
cap 6GiB/file, minimum free disk reserve 10GiB, acquisition total <=900 seconds
and <=12 chunks/source of <=8 seconds, replay <=4 million updates/case. Each
extraction/replay step is a finite child with timeout. Missing/oversized/incomplete
sources or resource limits yield INCOMPLETE, not a negative market result. Do
not overwrite partial originals or first results. Preserve checkpoints.

## News/context and remaining costs

Before source outcomes, the New York Fed October calendar identifies scheduled
claims releases on both dates at 08:30 ET (12:30 UTC), October 1 ISM manufacturing
and construction at 10:00 ET (14:00 UTC), and October 8 wholesale trade at 10:00
ET. [Primary calendar](https://www.newyorkfed.org/research/calendars/i-oct26.html).
These are schedule facts, NOT certified actual payload/network availability.
Record preceding-120-minute scheduled context per alarm, no news exclusion or
predictor in this test. Additional official news can be documented separately
with verified first-publication times; coverage remains UNKNOWN. Historical
surprise, OI and liquidations are unavailable unless separately sourced.

Real fills, size, extra slippage, actual account fees, funding and real-time
availability remain unverified; never call quoted scenarios realized profit.
Research only: no orders, Trader/PAPER/live changes, paid sources, key access,
deployments, merges or new background monitors. Existing authorized research
continuation handles future cycles; release the computer lease on completion.
