# r3 (J15): original real maximum vs completed null0–17, 2026-11-12

**Read-only exact J15 outcome: NO_EARLY_FAIL (CLI exit 2).** This is not a formal J3 PASS and is not a validation claim. The remaining null18 is incomplete; no r3 candidate has been advanced to the frozen validation period.

## Provenance

- Original Codespace: `algorithm-bench-v40-runner-v67gpxw4p57p26ww5`; private original location `/home/codespace/private-market-r3-20261108`. Existing Codespace was resumed within confirmed discounted/free GitHub personal Codespaces usage (Nov 2026 billing summary: 16.02671 4-core hours discounted in full, net amount $0 as of this check).
- Preserved original real `search-r3.json`, source SHA-256 `5847a9e919ce83446d2d14babab4c593850f11a1358adf49ee79a889aa30cda9` (ignore the visual space; exact hash `5847a9e919ce83446d2d14babab4c593850f11a1358adf49ee79a889aa30cda9`).
- Original real report: library `r3-f1`, seed 43, 80 population, 30 generations, 582 evaluated genomes, four search candidates, end `2025-03-01T00:00:00Z`.
- 18 original null reports `null-00.json` ... `null-17.json` copied intact through authenticated GitHub Codespaces connection to private Windows research work directory. J15 accepted all exact writer schemas, plan parameters, library SHA, history and 18 disjoint null seeds.
- Frozen search source SHA-256 `0c940e227a94ac78b49d67c5de1014cf02b79e1850d9dc6b33a8eddfdc052aee`, bench source `80fe24eacc8c2972e6e0cc870c9c3ef92566f51da90c96d87c7151c3a23d1e6e`; J15 helper `0bbe7a43eddc39f34b220d74dd2f9fbe61815c4a2250384ef438de8fb858fec1`, companion receipt `4437d3477d454c1375e6bb4083d5fef63e85ce673e236df8f56e437581433b78` all locally rehashed to their pinned values.

## Numeric outcome

- Real unfiltered generation best fitness: **0.9852835467660632**.
- Maximum of nulls 0–17: **0.14261588080986065**, at null seed **14**.
- The strict J3 condition has not yet failed, but null18 could still exceed the real maximum; the gate cannot pass until all 19 complete with receipts. This comparison creates **no** validation, no profitable-algorithm claim, and no right to open the holdout.

## Four original search candidates (development only)

| Candidate | Original description | Search annual Sharpe |
|---|---|---:|
| search-r3-1 | -liq60; hold 1d; equal weight; beta neutral | 1.6573570289236534 |
| search-r3-2 | illiq60 + resid120; hold 1d; equal weight; beta neutral | 1.1052763652151292 |
| search-r3-3 | illiq60 + resid20; hold 1d; equal weight; beta neutral | 0.5710461497180056 |
| search-r3-4 | if high market volume: illiq60, else beta60 - vol60; hold 1d; equal weight; beta neutral | 0.6687393042813599 |

Values above are **search-only**, not independent validation.

## Safe next action

First retain the original 1325-row partial null18 ledger unchanged, its SHA `ad000c5f4b5643987b40870ddf88246e6c80a22270c4d41e1dd6efdfee6cacc1`. On the original host (verify current compute, $0 overage and all six data/code pins; no other processes), replay only null18 with new private ledger/report names and exact original invocation. Require 1325-row PREFIX_MATCH ignoring only `time_utc`, original partial SHA preserved, GEN0_OK, companion RECEIPT_OK and completion hashes. Independently audit real/null receipts before formal J3. Only if J3 PASS, apply J8 novelty and J14 before any one-time frozen OKX validation. No holdout or PAPER orders.
