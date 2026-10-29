# Algorithm Discovery Research Engine v1 - invented operators and failure lineage

Created 2026-10-29 in isolated Rakazo research branch
`research/algorithm-discovery-engine-v1-2026-10-29`.

## What genuinely changes compared with v0

Version v0 produced executable compositions of a fixed AST language.
Version v1 lets a model submit **declarative definitions of new causal
state-transition operators**. The interpreter supports an additional
bounded, resettable memory state, not merely new indicator windows:

`state[t] = clip(decay * (reset?0:state[t-1]) + gain * innovation[t])`

where both `reset` and `innovation` are separately proposed closed-bar
programs in the safe previous DSL. The resulting state can generate a
decision only for the NEXT candle. There are no arbitrary scripts or
user-programmable shell commands. The new rule family is new to this
research project, but variants of stateful filters and reset rules
already exist in other research fields. No universal algorithmic novelty
or profitability is claimed.

The model can propose structure and hypotheses, but cannot yet inject an
arbitrary novel mathematical state transition: its proposals must pass
the reviewed, hardcoded `resettable_state` schema. Supporting new
classes of transitions requires separate code review, invariants and
tests. This is a research step towards algorithm discovery, not its
final form.

## Files and source chain

- `scripts/trading/algorithm_operator_lab.py`: safe state interpreter,
  train/validation and negative controls; **never accesses reserved 20%**.
- `docs/trading/ALGORITHM-OPERATOR-PROPOSALS-v1.json`: three model-authored
  operator designs with parent v0 hypothesis and the negative result
  motivating each revision.
- `scripts/trading/operator_critique.py`: deterministic failure
  classifier. It produces a machine-readable follow-up assignment for
  model-based revision of the **representation**, without relabeling
  already-inspected validation as fresh evidence.
- `scripts/trading/test_algorithm_operator_lab.py` and
  `scripts/trading/test_operator_critique.py`: causality, state-reset,
  safe input, future mutation, negative-controls and failure-cycle tests.

## Reproduce on verified, archived BTC data (development only)

```powershell
python scripts/trading/algorithm_operator_lab.py --csv C:/data/BTC-USDT-SWAP.csv --operators docs/trading/ALGORITHM-OPERATOR-PROPOSALS-v1.json --out C:/data/operator-v1-dev-new.json
python scripts/trading/operator_critique.py --report C:/data/operator-v1-dev-new.json --out C:/data/operator-v1-next-ideas-new.json
```

Each --out must be a NEW file; otherwise refuse overwrite.
These are **development-only** experiments and do not consume the
independent holdout or authorize PAPER. Training uses [0%,60%),
validation [60%,80%) and final 20% is never read for scoring.
Model-directed iteration has now seen train/validation evidence,
so this same validation slice MUST NOT be reused as a brand-new test
of next-generation ideas.

Actual 2026-07..09 BTC-USDT-SWAP archival smoke test:
8,832 consecutive 15m bars from official monthly source ZIPs,
three model-authored resettable-state operators:

| Operator | Train assumed trades | Training compounded return | Validation return | Diagnosis |
| --- | ---: | ---: | ---: | --- |
| resettable-shock-memory | 4,052 | -43.54% | -16.75% | Negative training after modeled costs |
| wick-resilience-state | 967 | -12.76% | -5.02% | Negative training after modeled costs |
| regime-change-accumulator | 2,060 | -24.58% | -10.56% | Negative training after modeled costs |

Returns above are HYPOTHETICAL model output, not real account
losses, and apply a fixed 0.1 equity allocation and 14 basis
points total round-trip fee+slippage. They omit actual funding,
fill uncertainty, futures contract rules and liquidation.
The purpose is to **falsify** weak proposals, not to claim
a real simulation of OKX fill outcomes. No holdout was scored.

The critique ledger records whether the signal trades almost
every bar, apparent fee drag, validation status, lineage and
next representation hypothesis. Critic is a deterministic
checker, NOT an autonomous theorem-proving LLM. The
`algorithm-researcher` skill is available for future explicit,
model-authored revisions. It has no trading permissions.

## Next research direction, not yet implemented

Based on current failures, propose a new **event-triggered
finite-state controller** whose decisions are sparse and can
persist in a no-trade state; it should require a state-transition
definition, independent review and causal timing tests.
Do not merely increase a stop, change threshold or remove fees.
Compare the new mechanism with known event-driven trading,
adaptive control and statistical detection literature before
calling it novel. A defensible claim of predictive edge requires
new, time-stamped, previously unseen data across many markets,
robust cost and risk simulation, and corrected hypothesis testing.

See `docs/trading/ALGORITHM-DISCOVERY-RESEARCH-ENGINE.md` and the
separate v5 OKX archive protocol for existing history integrity.
