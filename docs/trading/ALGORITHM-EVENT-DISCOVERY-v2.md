# Algorithm Discovery v2: event sequences, expiring exposure and counterexamples

Status: implemented and tested offline; real-market evaluation is pending.
This research branch cannot start PAPER, submit orders or modify Trader.

## Problem and representation change

The v1 development experiment rejected all three resettable-memory proposals.
There are two separate questions: whether the representation has predictive
information, and how much its assumed execution protocol costs. The v1 scorer
opened and closed a fresh one-bar position for every nonzero decision. That is
a valid explicit experimental convention, but its losses do not by themselves
prove that repeatedly holding the same directional view requires repeated
round-trip fees.

Version v2 accepts bounded declarative transition tables. A hypothesis can
change the sequence of events needed for a decision, the stored direction,
the cancellation path, and the states in which it abstains. It is no longer
limited to changing the decay and gain of a single scalar memory. It remains
a deliberately limited grammar, not an unrestricted algorithm inventor.

Two candidates are frozen in `ALGORITHM-EVENT-PROPOSALS-v2.json`:

| Candidate | Ordered observations required | Rejection condition |
| --- | --- | --- |
| escrow-confirmation | Surprise; later observation confirms its direction | Contrary observation cancels the pending direction |
| countershock-release | Surprise; contrary observation; another contrary observation | Reaffirmation of the initial direction cancels the rejection |

Both begin flat and wait before taking exposure. A hot range regime shortens
the remaining deadline; a subsequent calm period cannot lengthen it. Expiry
takes priority over confirmation. An exposed state cannot renew itself or
transition directly into another exposed state. Rules use first-match order,
which is part of the serialized semantics. A cooldown separates episodes.
Trigger hysteresis prevents repeatedly emitting the same event without a
release or an opposite shock. The detector uses only closed OHLCV bars.

Two matched ablations remove delayed confirmation or conflict cancellation.
They share the same detector, replay accounting and exposure limits. The
three v1 definitions are also reinterpreted as persistent target positions
under exactly the same replay model. Cash is the zero-exposure control.
No candidate thresholds were tuned against new real-market results here.

## Accounting and chronological boundaries

`algorithm_event_lab.py` evaluates a target at candle close and changes
quantity at the next open. A constant target keeps the original quantity;
costs occur on entry, exit or reversal, not every bar. Entry notional is 10%
of initial equity. Returns are additive fixed-notional equity changes, not
the compounded returns used by v1. Therefore cross-version percentage
comparisons require rerunning both signal families in this common simulator.

Base side cost is 7 bp (5 bp fee and 2 bp slippage); the stress scenario
doubles both. Gaps while holding a position count. A gap before entry is not
credited to the strategy. Marked drawdown uses opens and closes, not intrabar
extremes. Each evaluation slice starts flat and closes at its own last close;
this boundary liquidation is declared in advance. There is no funding,
contract-lot rounding, fill uncertainty, leverage or liquidation model.

All candidate and control results are reported for the first 60% and next
20% of each verified archive. Both are exploratory development data. Before
feature construction, the evaluator slices away the reserved final 20%.
Full-file hashes may still be checked for integrity; reserved prices are not
used for features, signals, returns or scoring. Previously viewed development
data are never relabeled as independent validation. No significance p-value
is produced from this adaptively reused sample.

## Formal checks and limits of novelty

`algorithm_event_audit.py` performs breadth-first product-automaton search on
36 finite event symbols. It returns a shortest distinguishing word, an exact
equivalence result only if the finite product is exhausted, or an explicit
inconclusive result at the state budget. This compares the transition tables;
it does not establish equivalence of detectors or arbitrary price processes.
The abstract alphabet deliberately includes detector-unreachable combinations.

A separate bounded search constructs realizable OHLCV paths, using five
return values after a flat warmup, and finds concrete differences against
each fixed v1 definition. Failure to find a witness means inconclusive.
These witnesses establish differences from the specified comparators only.
They do not prove that no known algorithm can implement the same mapping.

The synthetic audit also supplies one losing, correctly timed price path for
each candidate. Sparse decisions and multiple confirmations cannot guarantee
profitability. These adversarial examples are not estimated market frequency.

Relevant prior art checked on 2026-10-29:

- [Kampouridis and Otero, 2017](https://kar.kent.ac.uk/59758/): event-based
  directional-change trading and genetic search already exist. Our delayed
  confirmation tables are a project experiment, not a claim to invent
  event-driven trading.
- [Comparison of sampled-data and event-triggered control, 2012](https://doi.org/10.3182/20120606-3-NL-3011.00058):
  deadbands and event-triggered control predate this implementation. We
  provide no control-theoretic stability or economic optimality theorem.
- [Abate et al., 2018](https://doi.org/10.1007/978-3-319-96145-3_15):
  counterexample-guided synthesis is established research. This implementation
  uses explicit finite-state enumeration and bounded price probes, not a
  general SMT synthesizer or proof of a trading edge.

Scientific novelty and predictive advantage remain unproven.

## Reproduce

```sh
python -m unittest discover -s scripts/trading -p 'test_*.py'
python scripts/trading/algorithm_event_audit.py --operators docs/trading/ALGORITHM-EVENT-PROPOSALS-v2.json --legacy docs/trading/ALGORITHM-OPERATOR-PROPOSALS-v1.json --out /data/event-audit-new.json
python scripts/trading/algorithm_event_lab.py --csv /data/BTC-USDT-SWAP.csv /data/ETH-USDT-SWAP.csv /data/XRP-USDT-SWAP.csv --operators docs/trading/ALGORITHM-EVENT-PROPOSALS-v2.json --legacy docs/trading/ALGORITHM-OPERATOR-PROPOSALS-v1.json --out /data/event-development-new.json
```

Every output must be new. Archive execution verifies the existing CSV
manifest and original source archive receipts. `ALGORITHM-EVENT-AUDIT-v2.json`
contains only reproducible synthetic evidence, with no production data.

## Remaining evidence

Real-market v2 results have not been produced at this checkpoint because the
connected research computer became unavailable. Three verified historical
markets were recorded previously; this is still short of the >=50-market
protocol. Do not substitute synthetic results for that experiment.

Next: run the frozen candidates and all controls on the available development
archives, preserve every result, and investigate verified data coverage.
Before independent testing, freeze the candidate/code hashes, a point-in-time
market universe and exclusions, the full observation window, aggregate
statistics and multiplicity correction across all reported hypotheses.
Use a new forward window after that freeze, with no mid-window tuning or
optional stopping. Reused development p-values cannot be repaired merely by
applying Holm or another correction. An audited one-use evaluation and
appropriate dependence-aware inference still need implementation and review.
Funding, contract, mark, book and timestamp-safe external news/OI inputs remain
separate missing evidence; no synthetic SMC or historical news is inferred
from candles. No schedule or unattended collection is installed.
