# Algorithm Discovery v3 — dual-clock intrinsic-event sequence experiment

Checkpoint: 2026-10-29. **Negative exploratory evidence; DO NOT TRADE.**

## The new project-level representation

This revision replaces the v2 surprise/confirmation detector with two independent *close-only* directional-change clocks. Fixed fast threshold is 0.2% and slow threshold is 0.8%. Every slow reversal starts a fresh episode and clears the evidence ledger and any exposure. Fast reversals become symbols relative to the latest slow direction (+1 aligned, -1 opposing). No order is filled on the signal bar: target changes are replayed at the following candle's open.

Two frozen candidates, without parameter fitting:

1. **recoil-recovery**: relative event word (-1,+1) -> hold in slow direction for at most eight bars.
2. **recovery-failure**: relative event word (-1,+1,-1) -> hold against slow direction for at most eight bars.

Matched-clock control variants enter on the first opposing fast event or directly on slow events; all use the same eight-bar expiry and simulation fees. A slow event cancels exposure. There is at most one entry per slow episode. Pending patterns expire after 96 clock-time bars. A deterministic one-third-length circular shift of each candidate target vector is included as an *explicitly noncausal* placebo that destroys timing while approximately preserving exposure/turnover (boundary trades may differ). It is not an executable algorithm or a p-value generator.

Directional-change/intrinsic-time concepts and event-based trading are well established, including [Kampouridis & Otero (2017)](https://doi.org/10.1016/j.eswa.2016.12.032), [Petrov, Golub & Olsen (2020)](https://doi.org/10.1080/14697688.2019.1669809), [Glattfelder & Olsen (2024)](https://arxiv.org/abs/2406.07354). The grammar is **only new to this repository**, not a scientific novelty claim. Its directional prediction mechanism has not been demonstrated.

## Pre-existing data and split policy

All five official OKX 15-minute archives were reused from earlier research: BTC/ETH/XRP July–September 2026 (8,832 candles each) and SOL/DOGE July–August 2026 (5,952 candles each). The SOL/DOGE September files each contain an unrepaired missing minute, so September was not used for them. These different historical windows **must not** be pooled as a synchronized market-wide portfolio. For each verified archive, the first 60% is train, the next 20% is previously exposed development, and the final 20% is **not read by the algorithm**, preserving the previous boundary. As v2 results were already inspected on these markets, neither the train nor the next 20% is independent evidence for v3.

A side costs 7 bps (5 bp hypothetical taker fee + 2 bp slippage), or 14 bps in stress. Each entry targets 10% initial equity notional with a constant quantity until exit. No funding, tick/lot sizing, orderbook fills, stop execution, mark-price or liquidation models. Percentages are simplified fixed-notional equity-proxy returns, **not leveraged futures account returns**.

## Results: each candidate's net return (% initial modeled equity)

| Market | Partition | recoil-recovery, 7 bp/side | recovery-failure, 7 bp/side |
| --- | --- | ---: | ---: |
| BTC | train | -1.4589 | -1.1290 |
| BTC | exposed development | -0.4310 | -0.6841 |
| ETH | train | -2.5506 | -1.5147 |
| ETH | exposed development | -1.5712 | **+0.0936** |
| XRP | train | **+0.2477** | -2.9332 |
| XRP | exposed development | -1.3077 | -0.0336 |
| SOL | train | -2.0168 | -0.7135 |
| SOL | exposed development | -0.5667 | -0.2825 |
| DOGE | train | -1.1768 | -1.3307 |
| DOGE | exposed development | -0.4480 | -0.6206 |

**Only 2/20 candidate × market × partition outcomes positive under the base-cost assumption; 0/20 under doubled costs.** Pre-cost, recoil-recovery is positive in 3/10 and recovery-failure in 7/10. One-time post-hoc selection of ETH or XRP would be selection bias, and these dependent cells are not independent statistical samples. On aggregated cells, recoil-recovery has 762 entries with approximately 10.670% summed base-cost drag across non-comparable independent simulations; recovery-failure has 705 and 9.872% respectively. These sums are **not** portfolio P&L.

The one-event and slow-event controls have zero positive net outcomes (0/10 each), and the old v2 frozen candidates retain 0/10 and 1/10 base-cost positive outcomes respectively. Candidate vs its own noncausal circular placebo has a better net value in only 1/10 cells for recoil-recovery and 7/10 for recovery-failure. This *cannot* establish a profitable timing edge. No inferential p-value is warranted. The cash replay baseline always has zero cost and zero P&L.

## Formal limits and counterexamples

- The controller is a deterministic bounded state machine driven by *two causally observed price clocks*, unlike v2's scalar return surprise plus immediate confirmation flags. A replayable synthetic witness with 16 flat bars followed by closes 100.9, 100.6, 100.9, 100.6 produces the outputs: recoil-recovery 0,0,1,1; recovery-failure 0,0,0,-1; and v2 escrow-confirmation 0,0,0,0. This shows a concrete behavior difference from **that comparator on that path**, not general novelty or functional nonequivalence to the universe of known strategies.
- Event clocks only read current/past **closes**, avoiding ambiguous within-bar OHLC order. Future mutation tests verify that earlier outputs do not change.
- Adversarial post-entry price falls produce a losing example even with the sparse controller.
- Tests forbid reading the reserved 20% for features or scoring and exercise resets/expiry and no same-close fills.
- The simple noncausal nulls are not controlled for the precise same entry count at slice boundaries. More rigorous exposure- and turnover-matched nulls and dependence-aware inference are still needed.

## Exact evidence and reproduction

Code branch: `research/algorithm-discovery-intrinsic-v3-2026-10-29`. Engine `scripts/trading/algorithm_intrinsic_lab.py`; 12 dedicated tests in `scripts/trading/test_algorithm_intrinsic_lab.py`. Full research suite: **103 tests passed** on the isolated Windows host (no server processes touched). Current implementation commit before this document: `ca5d898c1b6a43fce35acfdca42d565a6a511bf7`. Frozen protocol digest: `c03efa8324d1f02cb953b168e4e1c8af41cecb87f5c6c79f0ccbbb5f64204025`.

Research result stored **outside Git** on the Windows machine:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/algorithm-intrinsic-v3-development-20261029.json` SHA-256 `1033ae11abb86d970cb26acefc6a2e05ec34ea16d02b3c464eb25cdf2c1637af`. Code file SHA-256 `978cb87d98fe00c05d60aba5c1cbc91dbfea2fd448dd6ce7f9b3f032fe390e36`.

Reproduce on verified datasets:

```sh
python -m unittest discover -s scripts/trading -p 'test_*.py'
python scripts/trading/algorithm_intrinsic_lab.py \
  --csv /data/BTC-USDT-SWAP.csv /data/ETH-USDT-SWAP.csv /data/XRP-USDT-SWAP.csv /data/SOL-USDT-SWAP.csv /data/DOGE-USDT-SWAP.csv \
  --v2 docs/trading/ALGORITHM-EVENT-PROPOSALS-v2.json \
  --out /data/a-new-unique-v3-report.json
```

The run will reject reports with existing output paths, dataset hash or symbol duplicates, corrupted official data manifests, and insufficient candle counts.

## Next discovery direction

**Stop recoding the same directional-change patterns** without new information. The results show that event-order compression may change trade frequency but has not overcome predictable execution drag. A next representation should formalize the *information content of the event itself*: for example, a point-in-time competing-hypothesis ledger conditioned on external timestamp-safe order-flow/funding/OI/news inputs, compared with a price-only ablation. This is only a research direction, not an implicit assertion that those sources predict price.

Before any independent performance statement: acquire coverage-valid historical inputs across a predeclared point-in-time liquidity universe (target >=50 only if verifiable); freeze the universe, exclusions, data availability timestamps, grammar and cost model; use a **new future** evaluation window not previously examined; implement robust block bootstrap or an equivalently dependence-aware control with explicit multiplicity handling. Never reclassify previously exposed development data as untouched validation by applying a correction to p-values.

No automated model, no schedule, no main merge, no active Trader change, no PAPER trade, and no live orders were performed.
