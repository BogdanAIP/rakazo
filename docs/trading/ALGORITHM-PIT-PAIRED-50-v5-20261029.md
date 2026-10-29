# Algorithm Discovery v5 — second 50-market PIT snapshot and paired evidence

**Checkpoint: 2026-10-29. Research-only, no trading approval.**

## Completed

A second **manual** public OKX observation round used exactly the same frozen candidate list and the same source-capture verifier as v5. No re-ranking, no price-return selection, no trading, no private API access, no unattended scheduler.

First ranked round: `2026-10-29 17:48:04.872–17:50:47.996 UTC`. Second ranked round: `2026-10-29 18:18:15.616–18:21:09.492 UTC`. Each comprises 10 sequential batches, 5 instruments per batch, 12 public replies per batch (5 OI, 5 prospective funding, 2 exchange-time controls).

**Outcome:** 50/50 successfully paired instruments, each with two individually SHA-verified OI snapshots and two funding *forecast* snapshots, approximately **30.135–30.364 minutes** between receipts for the same instrument. All 20 batch manifests and all 240 first/second-round public replies remain on the isolated Windows research host. A separate preliminary BTC/ETH capture from earlier v5 is not added to this 50-market comparison.

The frozen 50-market membership came from the prior saved exchange-screen file; historical point-in-time listing/survivorship and raw API bytes of the original screening response are **not** verified. Only the present two capture rounds have raw-source provenance.

## Machine-checked descriptive observations

| Feature | Count |
| --- | ---: |
| Open Interest increased, using same-instrument `oiCcy` | 20 |
| Open Interest decreased | 30 |
| Funding forecasts reference the same future settlement period in both snapshots | 49 |
| Funding forecast period changed, not directly comparable | 1 (**BLUR-USDT-SWAP**) |
| Funding forecast rate increased on comparable pairs | 7 |
| Funding forecast rate decreased on comparable pairs | 5 |
| Funding forecast unchanged on comparable pairs | 37 |
| Joint OI/funding-change event: same sign | 5 |
| Joint event: opposite signs | 7 |
| Explicit abstain: unchanged funding forecast | 37 |
| Explicit abstain: funding period switch | 1 |

Largest *descriptive*, not forecast returns or trade suggestions: OI percentage increases **INIT +2.635%**, **USELESS +1.853%**, and decreases **APR −3.044%**, **HYPE −1.854%**. Changes over a single ~30-minute interval do not establish return predictiveness or generality. By definition, increasing OI reflects matched long and short counterparties; it **cannot** independently identify net aggressive buyer pressure, liquidations, or smart money.

The formal event alphabet is `CO_MOVEMENT`, `OPPOSITION`, and `ABSTAIN` with precise invalidation reasons. It has **no long/short/order action**. Price movements, forward returns, contract leverage, liquidations and futures P&L **were not scored**.

## Point-in-time implementation and safeguards

Added to separate branch `research/algorithm-discovery-pit-pairs-v5-2026-10-29`:

- `scripts/trading/algorithm_pit_pair_v5.py`: before computing a pair, re-verifies the frozen universe and each first/second-round raw capture via its existing verifier. Requires unique instruments, exact ranked order, timestamp chronology, distinct reply SHA-256, and a 15-minute to 2-hour inter-snapshot gap. No field is available before its **second complete response-receipt timestamp**; features older than one hour are stale. Funding forecast deltas are withheld if the prospective settlement time changed between requests.
- `scripts/trading/algorithm_pit_events_v5.py`: conservative event/abstain labeling at a declared research observation time. Requires both OI and funding forecast to be received and fresh; it produces an observation label, never executable position directions. The event report binds to a **specific panel file's actual byte SHA-256**, after independent semantic reconstruction from raw source records.
- `scripts/trading/test_algorithm_pit_pair_v5.py` and `test_algorithm_pit_events_v5.py`: new regression and no-lookahead tests.

**Correction during this checkpoint:** The first generated event-label artifact mistakenly hashed a re-serialized LF string rather than the original Windows CRLF panel bytes. It is **superseded and must not be used for provenance**. The implementation was corrected to accept `--panel`, compare the supplied panel to a freshly rebuilt source-verified panel, and hash the exact stored bytes. Added an explicit Windows CRLF regression test. The resulting `event-labels-50-20261029-verified.json` correctly points to the exact panel hash, and the full test suite passed **137/137**.

## Files and integrity (local Windows research storage, not Git)

All files below are under `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`:

| File | SHA-256 |
| --- | --- |
| `universe-50-20261029.json` | `3193fcab0a38e6a881d5b26e28efb1db59e60a0e051a8084112a19f53274a9d3` |
| `two-round-panel-50-20261029.json` | `13c327b3658c6b98d8bf5d3a42605ddc733f8764b569535bf15fbc6b02391f23` |
| `event-labels-50-20261029-verified.json` | `eb62a12aeeaa753e596b5b44b954ff59d41dfe15922aed2d30fe8fc3605146a0` |

The earlier second-round manifests reside in `okx-pit-v5-20261029-second-batch01` through `...batch10`; first-round manifests reside in `okx-pit-v5-20261029-batch01` through `...batch10`. Source archive JSONs include exact raw replies, complete receipt times and per-blob SHA-256.

The old `event-labels-50-20261029.json` with SHA-256 `760b3b726c96209fca076b69954f13fd21c200e07b46e172119ed16e82ebf3df` has an **invalid source hash reference**. Preserve it as a trace of the corrected defect, but it is NOT an approved result.

## Reproducibility

Run in the isolated v5 pairs worktree, using new output file paths:

```sh
python -m unittest discover -s scripts/trading -p 'test_*.py'

python scripts/trading/algorithm_pit_pair_v5.py \
  --root /data/pit-captures \
  --universe /data/pit-captures/universe-50-20261029.json \
  --out /data/pit-captures/a-new-paired-panel.json

python scripts/trading/algorithm_pit_events_v5.py \
  --root /data/pit-captures \
  --universe /data/pit-captures/universe-50-20261029.json \
  --panel /data/pit-captures/two-round-panel-50-20261029.json \
  --out /data/pit-captures/a-new-verified-event-labels.json
```

## What must happen before any new algorithm performance claim

A single interval supplies one change observation per market. **Fifty markets do not mean fifty independent validation windows.** This is not enough to establish a trading alpha, sampling distribution, financial edge, or margin safety. Next work should specify and freeze a *forward* event-to-return matching rule, a point-in-time 50-market universe and exclusions, known latency/staleness, causal bar-close vs next-open execution, funding realized settlements, contract units and mark/index fill costs, and dependence-aware multiple-comparison controls. After a predeclared future data window is collected, score every hypothesis and non-trade control. No rewriting past funding settlements as their publication timestamps.

**Restrictions maintained:** no main merge, active Trader changes, PAPER or real orders, account authentication, paid data, monitoring schedules, or guaranteed ROI claims.
