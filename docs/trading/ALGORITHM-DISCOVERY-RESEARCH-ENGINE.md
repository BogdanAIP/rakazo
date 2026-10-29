# Algorithm Discovery Lab - research engine v0

State: independent prototype in the Rakazo Trading research project.
This is an **algorithmic-hypothesis discovery lab**, NOT the running
Rakazo Trader, and not a claim to have invented a scientifically new
trading algorithm.

## Why the project was redesigned

The original Alpha Discovery v1-v5 optimized predefined momentum,
reversal, threshold and stop combinations. That is a baseline, not
an autonomous scientific research process.

The new engine (scripts/trading/algorithm_discovery_lab.py) does
**typed program synthesis**: it constructs executable AST programs
from arithmetic operations, nonlinear transformations, trailing
windows, causal stateful accumulators and conditional branches.
Programs may combine multiple representations and construct
intermediate values before outputting a signal.

The grammar is explicitly bounded. It cannot yet invent arbitrary
new mathematical operators, autonomously conduct literature review,
or prove a general scientific breakthrough. Structural uniqueness
within the generated population is NOT novelty relative to the
scientific literature. LLM-generated hypotheses enter via a
separate, validated JSON file; no arbitrary Python/JS code is run.

## Research loop

1. Read only data with verified source-provenance and SHA-256 checks.
2. Generate and hash candidate ASTs (compositions, nonlinear
   interactions, stateful/conditional mechanisms).
3. Accept additional model-proposed ASTs from
   docs/trading/ALGORITHM-DISCOVERY-PROPOSALS-v0.json
   through scripts/trading/algorithm_proposals.py.
4. Verify operators, argument types, recursion depth and program
   uniqueness; do not execute user-supplied code.
5. Evaluate strictly causal features (only closed past/current bars).
   One-bar hypothetical position: signal after candle i close,
   enter i+1 open and exit i+1 close; fixed roundtrip cost 14bp
   and modeled equity allocation 10%. No real execution.
6. Search on the first 60% of the dataset; evaluate shortlists on
   the next 20%. Compare shortlisted candidates to a limited
   circular-shift negative control of 39 draws. This protects
   against SOME selection effects, not all forms of multiple testing.
7. If rejected, record a concrete diagnosis and pivot to a
   different family. Preserve every attempted program, AST and
   training metric in a machine-readable research ledger.
8. Only provisional survivors can access the final 20% holdout.
   The external audited runner exclusively claims each verified
   dataset fingerprint before this can happen. No same-holdout
   retest after a failure or favorable result.
9. Even after a positive holdout there is no permission to trade.
   A separate independent forward test, risk model and human
   review would be needed.

## Data and algorithmic limitations

Current primitive features come solely from bar OHLCV: log return,
body, range, candle location, wick imbalance, and change in
reported quote volume. The DSL supports lag, trailing mean, EMA,
causal CUSUM, temporal difference, nonlinear tanh, arithmetic,
protected ratio and conditional programs.

News, SMC/order book, open interest, liquidation and on-chain
data have NOT been connected to this engine. Future external
signals must carry point-in-time publication/availability stamps,
version history and no future revisions. Do not manufacture
historical news or assume a large candle indicates an informed
institutional trade. The existing v5 archived OHLCV data remain
available and unchanged.

No funding, real exchange contract size, order-book slippage,
margin maintenance or liquidation is modeled in the new engine.
A price-only signal positive after simplistic costs is not
a verified perpetual-futures edge. Independent literature
novelty and rigorous across-family statistical testing are
not yet implemented. Generated programs should not be called
discoveries until independently validated.

## First implementation check

- 3 model-authored candidate programs: liquidity-recovery shock,
  wick-imbalance memory, and conditional candle memory.
- Flat synthetic test: 27 distinct programs generated across
  4 families, all rejected; reserved holdout untouched.
- Read-only development smoke test on verified BTC-USDT-SWAP
  July-September 2026: 8,832 closed 15-minute bars, 75 programs,
  4 families, no training-positive families after assumed costs,
  ZERO provisional candidates; reserved holdout untouched.
  This pilot is NOT the 50+ market evaluation and is NOT evidence
  of either profitability or impossibility of an edge.
- The previous v5 cross-market standard remains >=50 independently
  verified markets and historical membership/survivorship controls.

## How to use

First run local regression tests:

```powershell
python -m unittest discover -s scripts/trading -p "test_*.py" -v
```

Model hypothesis grammar JSON example:

`docs/trading/ALGORITHM-DISCOVERY-PROPOSALS-v0.json`

Single-use **audited** research entrypoint, ONLY after choosing a
genuinely unexamined dataset/holdout:

```powershell
python scripts/trading/algorithm_discovery_lab.py --csv C:/data/BTC-USDT-SWAP.csv --registry C:/data/holdout-claims --out C:/data/research-001.json --per-family 24 --null-shifts 39 --proposals docs/trading/ALGORITHM-DISCOVERY-PROPOSALS-v0.json
```

This CLI consumes the dataset's holdout claim, even on a failed
development result. Do not run the command repeatedly on the
same dataset; do not delete/recreate the claim to try again.
A separate, explicitly approved 50+ market protocol is required
before any broad market conclusions.

## Necessary next milestone

The next research cycle should be LLM-guided rather than bounded
random search only: model proposes new operator semantics and
testable hypotheses; independent static review accepts or rejects
an expanded formal DSL; a deterministic evaluator seeks
counterexamples and outputs failure traces; the model analyzes
them to change its representation, not just tweak parameters.

Implement timestamp-safe SMC/order-flow/funding/news event feeds,
scientific-reference matching (algorithmic novelty), durable
hypothesis lineage across datasets, multi-family/data-set
multiple-testing corrections and purged cross-asset evaluation.
Never allow an unreviewed generated algorithm to loosen risk
controls or submit PAPER/live orders.
