# Algorithm Discovery r2 — interrupted null calibration checkpoint (3 November 2026)

**Research checkpoint, not a J3 verdict or a trading signal.** Pre-fitness immutable input/source lock: [search-r2-input-lock-20261102.md](search-r2-input-lock-20261102.md), commit `2420462`. No frozen settings, costs, validation or holdout changed.

## Real pooled search is complete

- Completed all **30 generations**, scored **535 unique candidate genomes** on the two-exchange SEARCH data.
- Real best **fitness = +0.8194797148106232** (this is *not a return percentage*).
- Among the **one** diverse top-candidate family in the completed output: market-regime switch, when high market volatility select `-fund3`, otherwise `maxret20`, horizon **7 days**, inverse-volatility weighting, beta-neutral.
- Search-only annualized Sharpe across pooled segments: **1.3363**; OKX Sharpe **1.7269** (two folds 1.6086/1.8452), Binance Sharpe **1.1936** (three folds 3.3924/**0.0336**/**0.1548**). The two weak Binance folds are a serious robustness warning.
- No candidate has been promoted to validation, so **zero new validation trials and no holdout exposure**.

## First 7 exact-budget shuffled-score controls (complete, immutable)

| Null shuffle index | Best fitness |
|---:|---:|
| 0 | −0.09474612992933024 |
| 1 | −0.31311427027945316 |
| 2 | −0.16553878005457812 |
| 3 | −0.13839452694855592 |
| 4 | −0.020030038825575303 |
| 5 | −0.1388218093558385 |
| 6 | −0.48123056983402146 |

Best of first 7 controls **−0.0200**, below the real best +0.8195. These controls are incomplete evidence: with only 7 nulls the empirical minimum attainable rank-p is **1/8 = 0.125**; the preregistered J3 gate requires the real best to beat **all 19 null maxima**.

## Resource incident and exact work continuation

- Original private supervisor `runs/search-r2-pooled-20261102/status.json` ended **2026-11-02 23:25:36 UTC** (`STOPPED_ERROR`) while evaluating null seed **7** because host available RAM fell below the unchanged **256 MiB** safety floor. There is **no completed null-7 JSON**. All prior real and null0–6 file outputs remain untouched.
- At **2026-11-03 05:37 UTC**, Rakazo memory was **7.68 GiB installed, 1.14 GiB available**; no research search process was active, disk had >23 GiB free.
- One unique continuation wrapper launched **2026-11-03 05:39 UTC** in **private** `runs/search-r2-null-resume-20261103/status.json`, running exact same previously locked executable SHA `30e3e2a0…`, CSVs/configs, GA seed **41**, population **80**, generations **30** and null shuffle seeds **7–18**, each once to exclusive paths. Null-7 child was observed alive and using ~80 MiB on startup.
- This is **resource-only resumption**, not another exploratory round or additional hyperparameter search. No changes to original null0–6 outputs, seed plans, cost/gates or J3 decision rule. The continuation verifies all private artifact SHA digests and previous result files before running, caps child RSS at **1 GiB**, keeps RAM floor **256 MiB**, free disk floor **16 GiB**, and per-null **4h** ceiling; on any stop it does not silently retry.
- When all 19 nulls are complete, compare real-best > max(null0,…,null18), publish the full null table and J3 result, and send to Claude for independent review. **No automatic OKX validation or holdout**.

All original market data remain private on Rakazo; no orders, PAPER, Docker, accounts or spending.
