# Search round 1 (OKX 3-year calendar)

Search segment only (2023-10-01 → 2025-02-28, export CSV `c16cc3c3…`, config `1674e683…`). 835 distinct programs explored with `algorithm_search_v40.py` (population 80, 30 generations, seed 40, beta-neutral books, holds limited to 1–10 days so the 11-month validation segment can judge them). The five best distinct signal families below are committed **before** any validation run. Search-segment numbers are in-sample and optimistic by construction: on pure-noise synthetic panels the best search Sharpe reached ~6 while validation was ~0.

| Rule | Rule SHA | Program | Search Sharpe (annual, net 10 bp) | Halves | Mean IC | Turnover/step |
|---|---|---|---:|---|---:|---:|
| search-r1-1 | `ced553edd247` | if mvol_high: -beta120 + -trend_break20 else resid60 + volume_z60; hold 3d; inverse_vol weights; beta-neutral | 3.82 | 3.84 / 3.80 | 0.0375 | 0.305 |
| search-r1-2 | `6fabaf5afd7e` | if mvol_high: -beta120 + -resid60 else resid60 + -fund7; hold 5d; inverse_vol weights; beta-neutral | 3.46 | 2.53 / 4.39 | 0.0526 | 0.171 |
| search-r1-3 | `85425d0f91b5` | if mvol_high: -beta120 + -trend_break20 else trend_break20; hold 3d; inverse_vol weights; beta-neutral | 3.08 | 2.29 / 3.88 | 0.0538 | 0.292 |
| search-r1-4 | `83ce2ebbef33` | if mvol_high: -range20 else ret10; hold 5d; inverse_vol weights; beta-neutral | 2.90 | 2.02 / 3.79 | 0.0635 | 0.193 |
| search-r1-5 | `d2a0c62e7cf6` | if mvol_high: -fund3 + -vol20 else resid60; hold 2d; inverse_vol weights; beta-neutral | 2.61 | 2.36 / 2.86 | 0.0233 | 0.292 |

Building blocks: `beta120` rolling beta to the market average; `trend_break20` distance of the close below its 20-day high; `resid60` 60-day beta-adjusted residual return; `volume_z60` volume shock; `fund7`/`fund3` mean funding; `range20` mean high–low range; `vol20` 20-day volatility; `ret10` 10-day return. Regime `mvol_high`: 20-day volatility of the market average above its 120-day level.

**Reading.** Four of five use the same switch: in high market volatility, long low-beta and short high-beta contracts (a betting-against-beta pattern) plus contracts far below their recent high; in calm markets, residual momentum. Both are documented effects in equities; the regime switch between them is the search's contribution. Rules 1, 2, 3 and 5 share the high-volatility branch, so their validation results will be correlated.

Per-regime breakdown on the search segment (mean net bp per step when the regime is on / off):

- search-r1-1: mdisp_high: 27.1 on (150) / 11.0 off (216); mtrend_up: 22.0 on (157) / 14.2 off (209); mvol_high: 20.1 on (167) / 15.4 off (199)
- search-r1-2: mdisp_high: 27.0 on (150) / 10.4 off (216); mtrend_up: 25.8 on (157) / 10.8 off (209); mvol_high: 20.2 on (167) / 14.8 off (199)
- search-r1-3: mdisp_high: 15.3 on (150) / 12.5 off (216); mtrend_up: 14.3 on (157) / 13.2 off (209); mvol_high: 18.4 on (167) / 9.7 off (199)
- search-r1-4: mdisp_high: 24.5 on (150) / 8.7 off (216); mtrend_up: 30.0 on (157) / 4.0 off (209); mvol_high: 17.0 on (167) / 13.6 off (199)
- search-r1-5: mdisp_high: 14.3 on (150) / 11.6 off (216); mtrend_up: 17.6 on (157) / 9.0 off (209); mvol_high: 11.9 on (167) / 13.3 off (199)

Next: GPT runs `promote` on the full daily panel (config `de588938…`) with `docs/trading/bench/hypotheses/search-r1.json`; all five count as validation trials from the first one.
