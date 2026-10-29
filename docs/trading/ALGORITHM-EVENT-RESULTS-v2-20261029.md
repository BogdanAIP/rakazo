# Algorithm Discovery v2 — five-market development checkpoint (2026-10-29)

**Status:** negative exploratory evidence; **no trading approval**. This document records a completed run of frozen v2 definitions, not independent validation, profitability, or scientific novelty.

## Exact study boundary

- Source: officially archived OKX 1-minute candles, independently receipt- and SHA-256-verified, aggregated into closed 15-minute bars.
- Instruments: BTC-USDT-SWAP, ETH-USDT-SWAP, XRP-USDT-SWAP (2026-07 through 2026-09, **8,832 bars per market**); SOL-USDT-SWAP and DOGE-USDT-SWAP (2026-07 through 2026-08, **5,952 bars per market**).
- Split per market: first 60% train, next 20% previously exposed development, final 20% *not evaluated*. The different market windows prohibit treating the rows as a common-date cross-sectional test.
- A closed-bar decision changes position at the following bar's open. Each entry has fixed notional equal to 10% of initial equity. Base cost is 7 bps per executed side (5 bps fee + 2 bps hypothetical slippage), stress is 14 bps per side. Exposure persists until a target change; the final close liquidates any remaining position. This is a simplified linear-contract **equity proxy**, not real leveraged perpetual returns.
- All four frozen event definitions, three v1 comparators under the same replay, and a zero-exposure cash control were scored. No candidate was retuned following the results.

## Candidate net returns (% of starting test equity, not margin returns)

| Market and contiguous months | Segment | escrow-confirmation | countershock-release |
| --- | --- | ---: | ---: |
| BTC July–September | Train 60% | -1.0756 | -0.5648 |
| BTC July–September | Exposed development 20% | -0.7337 | -0.3436 |
| ETH July–September | Train 60% | -2.4761 | -0.9648 |
| ETH July–September | Exposed development 20% | -1.5615 | -0.8864 |
| XRP July–September | Train 60% | -1.9502 | -0.3920 |
| XRP July–September | Exposed development 20% | -0.8639 | +0.0987 |
| SOL July–August | Train 60% | -1.4087 | -0.6891 |
| SOL July–August | Exposed development 20% | -0.2144 | -0.4489 |
| DOGE July–August | Train 60% | -1.1091 | -1.2466 |
| DOGE July–August | Exposed development 20% | -0.3315 | -0.1538 |

**Descriptive summary, not a p-value:** Of 20 candidate × market × segment results, only **1/20** was positive net of base costs, **0/20** was positive after doubled costs, and **9/20** was positive *before* execution costs. These observations are dependent in time and across markets. Counting positive cells is not a significance test.

For the positive XRP exposed-development cell, countershock-release had +0.0987% under base assumptions and **-0.4610%** when side costs doubled. A discovery based on choosing this cell post hoc would be selection bias. Cash earned a fixed zero return in the replay; none of the candidates beat cash consistently.

Across all five markets and both development segments, escrow-confirmation opened **714** modeled entries and countershock-release **441**. Fewer entries than v1 do not imply information advantage: ablations show substantially different exposure frequencies and therefore different fee drag. No inference of real-market fill quality, safe leverage, liquidation probability, or daily expected returns is warranted.

## Failed extension / data-integrity evidence

Both SOL and DOGE September archives passed the ZIP receipt metadata checks but failed exact contiguous-minute validation:

| Instrument | Missing exact UTC minute | Result |
| --- | --- | --- |
| SOL-USDT-SWAP | 2026-09-01 10:33 UTC | September excluded |
| DOGE-USDT-SWAP | 2026-09-01 10:58 UTC | September excluded |

Each September ZIP has **43,199** minutes instead of 43,200, with precisely one two-minute timestamp jump. July and August for each instrument have **89,280** contiguous minutes and passed the strict official archive importer. **No minute was fabricated, forward-filled, interpolated, or silently skipped.** Reports for SOL/DOGE therefore use a different, fully specified two-month window.

## Reproducibility receipts (not committed to Git)

Model sources at v2 commit `ebe2433b8f069c7fd8c49502f9c5402eb0b5527c`. Frozen proposal JSON SHA-256: `a2fd66f1d323a8ca57e9b271fb9ef3d5d2bae8cc247b5f2fe19cb316e055f4e0`.

Research-machine outputs under `RakazoRuntime/trading-live-data-20261011/alpha-research/`:

- `algorithm-event-v2-development-20261029.json` — SHA-256 `66616ef1feac12daba91df1fbe929ce676db9eec1742b0bfcf940fdff8137616`
- `algorithm-event-v2-sol-doge-development-20261029.json` — SHA-256 `d8f97fe95371185e08cdc177fa02bfac1a2442d9ae066c785ba53b0fe380598c`

Dataset CSV digests:

| Symbol | SHA-256 |
| --- | --- |
| BTC | `3c55cf0c454858b9ba92e666e71aa283400ff2d8581fddd9dc1cb9615f99e7b0` |
| ETH | `020b7ecccf9b94627fc5f2d825f23d9cf8c5a606a5e265cb98cacac627b2673e` |
| XRP | `caf37774e29fdcf07267860ce092491c3dac337821ec4295647d8875a2acee9d` |
| SOL | `6651d67a0d05373791fd8ef0b227d5d562eeb4f7cb5a8a86c32225487e400825` |
| DOGE | `88d49736ab89df74d5f6a7637f6336dc4286e11096233ef3b23f53936838fb6e` |

Windows isolated worktree `rakazo-alpha-discovery-20261028`: `python -m unittest discover -s scripts/trading -p 'test_*.py'` — **91 tests passed** (including 24 new v2 tests). No PAPER services were started, no trades executed, and no active Trader settings changed.

## Falsification-to-discovery handoff

**Observation:** Delayed event confirmation reduced participation and modeled fee drag but did not produce reliable post-cost predictive performance. Raw pre-cost profitability is itself inconsistent across markets and samples.

**Next invention task (not a parameter sweep):** propose a finite-state operator whose *representation* differs from the current impulse/confirm/expiry family, with causal event ordering, a distinguishable behavioral trace, a specified abstention mechanism, a priori bounded turnover, an invalidation rule, and a falsifiable explanation for why future conditional returns should differ. Analyze whether a candidate's signal has any incremental predictive content *before costs* versus matched exposure- and turnover-controlled nulls. Do not rename the existing two operators, optimize `enter`/`confirm`/TTL from exposed data, or search repeatedly against the reserved 20%.

**Evidence gates:** (1) new semantic operator and exact/realizable counterexamples against frozen v1/v2 controls; (2) account-free adversarial and no-lookahead tests; (3) predeclared comparisons and cost stress; (4) a sufficiently broad, point-in-time market universe (target >=50 markets, subject to verified archival coverage) with a single frozen analysis plan; (5) genuinely future independent testing and dependence-aware statistical inference. Historical funding, contract size, mark prices, order book, OI and timestamp-safe news must be added before any futures risk claim. Exposed development data can generate hypotheses but cannot be turned into independent evidence by multiple-test correction.

**Policy:** research only, no autonomous scheduler, no PAPER execution, no live or main merge.
