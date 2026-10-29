#!/usr/bin/env python3
"""Bounded event-controller interpreter and research-only execution model.

JSON is data, never executable code. No network, accounts, orders or schedule.
Outputs are target signs decided AFTER a closed bar, effective NEXT open.
"""
from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass
from itertools import product
import json
import math
from pathlib import Path
import re

from algorithm_discovery_lab import FEATURES, base_features, evaluate, validate_ast
from algorithm_operator_lab import fingerprint, num

SCHEMA = "event_controller_proposals_v2"
EVENT_FIELDS = {"trigger", "confirm", "hot", "calm"}
ALPHABET = tuple(product((-1, 0, 1), (-1, 0, 1), (False, True), (False, True)))
CONDITIONS = {"any", "zero", "nonzero", "same", "opposite"}
LABEL = re.compile(r"[a-z][a-z0-9-]{2,59}")


def strict_json(path):
    path = Path(path)
    if path.stat().st_size > 65_536:
        raise ValueError("Proposal file too large")

    def unique(pairs):
        out = {}
        for k, v in pairs:
            if k in out:
                raise ValueError("Duplicate JSON field")
            out[k] = v
        return out

    def reject_constant(value):
        raise ValueError("Nonfinite JSON")

    return json.loads(path.read_text(encoding="utf-8-sig"),
                      object_pairs_hook=unique, parse_constant=reject_constant)


def integer(x, lo, hi):
    if type(x) is not int or not lo <= x <= hi:
        raise ValueError("Invalid bounded integer")


def validate(d):
    fields = {"id", "parent_id", "hypothesis", "failure_addressed", "role",
              "features", "detector", "initial", "states"}
    if not isinstance(d, dict) or set(d) != fields:
        raise ValueError("Unexpected controller fields")
    for key in ("id", "parent_id"):
        if not isinstance(d[key], str) or not LABEL.fullmatch(d[key]):
            raise ValueError("Invalid controller lineage")
    if d["role"] not in ("candidate", "ablation"):
        raise ValueError("Invalid role")
    for key in ("hypothesis", "failure_addressed"):
        if not isinstance(d[key], str) or not 30 <= len(d[key]) <= 1000:
            raise ValueError("Missing hypothesis and failure rationale")
    features = d["features"]
    if not isinstance(features, dict) or set(features) != {"impulse", "confirmation", "regime"}:
        raise ValueError("Invalid feature definitions")
    for ast in features.values():
        validate_ast(ast)
    limits = d["detector"]
    if not isinstance(limits, dict) or set(limits) != {"enter", "release", "confirm", "hot"}:
        raise ValueError("Invalid detector")
    for key, value in limits.items():
        num(value, 0, 8, key)
    if not 0 <= limits["release"] < limits["enter"] or limits["confirm"] <= 0 or limits["hot"] <= 0:
        raise ValueError("Detector must have a real deadband")
    states = d["states"]
    if not isinstance(states, dict) or not 2 <= len(states) <= 8:
        raise ValueError("Need 2..8 finite states")
    if d["initial"] not in states:
        raise ValueError("Unknown initial state")
    for name, state in states.items():
        if not isinstance(name, str) or not LABEL.fullmatch(name):
            raise ValueError("Invalid state name")
        if not isinstance(state, dict) or set(state) != {"exposure", "ttl", "expire_to", "rules"}:
            raise ValueError("Invalid state definition")
        if state["exposure"] not in ("flat", "reference"):
            raise ValueError("Only flat/reference exposure")
        ttl = state["ttl"]
        if ttl is not None:
            if not isinstance(ttl, list) or len(ttl) != 2:
                raise ValueError("TTL is [calm bars, hot bars]")
            for value in ttl:
                integer(value, 1, 64)
            if ttl[1] > ttl[0]:
                raise ValueError("High-risk regime cannot lengthen deadline")
            if state["expire_to"] not in states:
                raise ValueError("Unknown expiration destination")
            if states[state["expire_to"]]["exposure"] != "flat":
                raise ValueError("Expiration must flatten")
        elif state["exposure"] != "flat" or state["expire_to"] is not None:
            raise ValueError("An exposed state must expire")
        rules = state["rules"]
        if not isinstance(rules, list) or len(rules) > 8:
            raise ValueError("Too many transition rules")
        for rule in rules:
            if not isinstance(rule, dict) or set(rule) != {"when", "to", "reference"}:
                raise ValueError("Invalid transition")
            if rule["to"] not in states or rule["to"] == name:
                raise ValueError("Unknown or self-renewing transition")
            if rule["reference"] not in ("keep", "clear", "trigger", "confirm"):
                raise ValueError("Invalid reference assignment")
            # Never allow one exposed state to renew another exposed lease.
            if state["exposure"] == states[rule["to"]]["exposure"] == "reference":
                raise ValueError("Exposure cannot renew itself through another state")
            cond = rule["when"]
            if not isinstance(cond, dict) or not cond or not set(cond) <= EVENT_FIELDS | {"min_age"}:
                raise ValueError("Invalid guard")
            for key, value in cond.items():
                if key in ("trigger", "confirm") and value not in CONDITIONS:
                    raise ValueError("Invalid symbolic comparison")
                if key in ("hot", "calm") and type(value) is not bool:
                    raise ValueError("Boolean guard required")
                if key == "min_age":
                    integer(value, 1, 64)
            if rule["reference"] in ("trigger", "confirm") and cond.get(rule["reference"]) not in ("nonzero", "same", "opposite"):
                raise ValueError("Reference must be assigned from nonzero evidence")
    if states[d["initial"]]["exposure"] != "flat":
        raise ValueError("Initial state must abstain")
    return d


def semantic_hash(d):
    return fingerprint({k: d[k] for k in ("features", "detector", "initial", "states")})


def load(path):
    doc = strict_json(path)
    if not isinstance(doc, dict) or set(doc) != {"schema", "operators"} or doc["schema"] != SCHEMA:
        raise ValueError("Unsupported proposal schema")
    rows = doc["operators"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 8:
        raise ValueError("Need 1..8 fixed proposals")
    ids, semantics = set(), set()
    for row in rows:
        validate(row)
        sig = semantic_hash(row)
        if row["id"] in ids or sig in semantics:
            raise ValueError("Duplicate identifier or semantics under a new label")
        ids.add(row["id"])
        semantics.add(sig)
    return rows


@dataclass(frozen=True)
class State:
    name: str
    reference: int = 0
    remaining: int = 0
    age: int = 0


def matches(cond, event, state):
    for key, expected in cond.items():
        if key == "min_age":
            if state.age < expected:
                return False
        elif key in ("hot", "calm"):
            if event[key] != expected:
                return False
        else:
            value = event[key]
            ok = {"any": True, "zero": value == 0, "nonzero": value != 0,
                  "same": state.reference != 0 and value == state.reference,
                  "opposite": state.reference != 0 and value == -state.reference}[expected]
            if not ok:
                return False
    return True


def enter(d, name, reference, hot):
    ttl = d["states"][name]["ttl"]
    return State(name, reference, ttl[int(hot)] if ttl else 0, 0)


def step(d, state, event):
    """Priority: expire, then first matching rule, then hold; no deadline renewal."""
    cfg = d["states"][state.name]
    ttl = cfg["ttl"]
    remaining = min(state.remaining - 1, ttl[int(event["hot"])]) if ttl else 0
    current = State(state.name, state.reference, remaining, min(64, state.age + 1))
    reason = "hold"
    if ttl and remaining <= 0:
        current = enter(d, cfg["expire_to"], 0, event["hot"])
        reason = "expired"
    else:
        for i, rule in enumerate(cfg["rules"]):
            if matches(rule["when"], event, current):
                ref = rule["reference"]
                value = (current.reference if ref == "keep" else 0 if ref == "clear" else event[ref])
                current = enter(d, rule["to"], value, event["hot"])
                reason = "rule:" + str(i)
                break
    action = current.reference if d["states"][current.name]["exposure"] == "reference" else 0
    return current, action, reason


def interpret(d, events):
    validate(d)
    state = State(d["initial"])
    actions, trace = [], []
    for i, event in enumerate(events):
        if (not isinstance(event, dict) or set(event) != EVENT_FIELDS
                or any(type(event[x]) is not int or event[x] not in (-1, 0, 1) for x in ("trigger", "confirm"))
                or any(type(event[x]) is not bool for x in ("hot", "calm"))):
            raise ValueError("Invalid finite event")
        before = state
        state, action, reason = step(d, state, event)
        actions.append(action)
        if state.name != before.name or reason == "expired":
            trace.append({"bar": i, "from": before.name, "to": state.name,
                          "reference": state.reference, "action": action, "reason": reason})
    return actions, trace


def eventize(d, table, warmup=16):
    validate(d)
    if not set(FEATURES) <= set(table):
        raise ValueError("Incomplete OHLCV feature table")
    n = len(table["return"])
    if any(len(table[x]) != n or any(type(v) not in (int, float) or not math.isfinite(v) for v in table[x]) for x in FEATURES):
        raise ValueError("Invalid finite feature table")
    integer(warmup, 0, 128)
    impulse, confirm, regime = (evaluate(d["features"][k], table) for k in ("impulse", "confirmation", "regime"))
    lim = d["detector"]
    latch = 0
    events = []
    for i, (x, y, z) in enumerate(zip(impulse, confirm, regime)):
        trigger = 0
        hot = abs(z) >= lim["hot"]
        calm = abs(x) <= lim["release"] and not hot
        if i < warmup:
            events.append({"trigger": 0, "confirm": 0, "hot": False, "calm": True})
            continue
        if abs(x) <= lim["release"]:
            latch = 0
        elif abs(x) >= lim["enter"]:
            side = 1 if x > 0 else -1
            if side != latch:
                trigger, latch = side, side
        confirmation = 1 if y > lim["confirm"] else -1 if y < -lim["confirm"] else 0
        events.append({"trigger": trigger, "confirm": confirmation, "hot": hot, "calm": calm})
    return events


def distinguishing_witness(left, right, budget=30_000):
    """Exact BFS product for finite abstract event controllers (detector excluded).

    An exhausted product proves equivalence ONLY for these two transducers.
    A finite witness proves non-equivalence, not novelty against all algorithms.
    Alphabet includes impossible detector combinations, a conservative superset.
    """
    validate(left)
    validate(right)
    integer(budget, 1, 100_000)
    start = (State(left["initial"]), State(right["initial"]))
    queue = deque([start])
    parents = {start: None}
    while queue:
        pair = queue.popleft()
        for values in ALPHABET:
            event = dict(zip(("trigger", "confirm", "hot", "calm"), values))
            a, out_a, _ = step(left, pair[0], event)
            b, out_b, _ = step(right, pair[1], event)
            if out_a != out_b:
                word = [event]
                node = pair
                while parents[node] is not None:
                    node, prior_event = parents[node]
                    word.append(prior_event)
                word.reverse()
                return {"status": "DISTINGUISHED", "events": word,
                        "left_actions": interpret(left, word)[0],
                        "right_actions": interpret(right, word)[0],
                        "visited_pairs": len(parents)}
            child = (a, b)
            if child not in parents:
                if len(parents) >= budget:
                    return {"status": "INCONCLUSIVE_BUDGET", "visited_pairs": len(parents)}
                parents[child] = (pair, event)
                queue.append(child)
    return {"status": "EQUIVALENT_ABSTRACT_TRANSDUCERS", "visited_pairs": len(parents)}


def replay(bars, actions, side_cost=0.0007, allocation=0.1):
    """Fixed entry notional, quantity held until target changes; mark every bar.

    Cash + marked PnL is a hypothetical linear-contract equity proxy.
    Gaps and variable holding periods count. Exit last close is predeclared.
    No leveraged futures, funding, margin, stops, liquidity or real fill model.
    """
    if len(bars) < 2 or len(actions) != len(bars):
        raise ValueError("Inconsistent replay length")
    if any(type(x) is not int or x not in (-1, 0, 1) for x in actions):
        raise ValueError("Invalid target")
    num(side_cost, 0, 0.01, "side_cost")
    num(allocation, 0.001, 1, "allocation")
    equity = peak = 1.0
    quantity = previous_mark = 0.0
    side = entries = executions = exposed = 0
    gross = costs = maxdd = 0.0
    equity_path, changes = [], []

    def mark(price):
        nonlocal equity, previous_mark, gross, peak, maxdd
        change = quantity * (price - previous_mark) if quantity else 0.0
        gross += change
        equity += change
        previous_mark = price
        peak = max(peak, equity)
        maxdd = max(maxdd, 1 - equity / peak)

    for j in range(1, len(bars)):
        bar = bars[j]
        if not all(math.isfinite(x) and x > 0 for x in (bar.op, bar.cl)):
            raise ValueError("Invalid execution price")
        mark(bar.op)
        target = actions[j-1]
        if target != side:
            new_quantity = target * allocation / bar.op
            cost = abs(new_quantity - quantity) * bar.op * side_cost
            costs += cost
            equity -= cost
            executions += int(side != 0) + int(target != 0)
            entries += int(target != 0)
            changes.append({"decision_bar": j-1, "fill_bar": j,
                            "from": side, "to": target})
            quantity, side = new_quantity, target
        exposed += int(side != 0)
        mark(bar.cl)
        equity_path.append(equity)
    if quantity:
        cost = abs(quantity) * bars[-1].cl * side_cost
        costs += cost
        equity -= cost
        executions += 1
        maxdd = max(maxdd, 1 - equity / peak)
        equity_path[-1] = equity
    return {"entries": entries, "executions": executions,
            "observations": len(bars)-1, "exposure_bars": exposed,
            "net_return": equity-1, "gross_return": gross, "cost_drag": costs,
            "max_drawdown": maxdd, "insolvent": equity <= 0,
            "mean_holding_bars": exposed/entries if entries else 0.0,
            "exposure_fraction": exposed/(len(bars)-1),
            "entry_density": entries/(len(bars)-1),
            "equity_path": equity_path, "changes": changes}


def compact_score(bars, actions, cost):
    return {k: v for k, v in replay(bars, actions, side_cost=cost).items()
            if k not in ("equity_path", "changes")}


def development(bars, definitions, legacy):
    """Physically slice BEFORE feature construction: holdout is never evaluated."""
    from algorithm_operator_lab import causal_operator, direction
    if len(bars) < 1200:
        raise ValueError("At least 1200 verified candles required")
    n = len(bars)
    bounds = (("train", 0, int(n*.6)), ("exposed_development", int(n*.6), int(n*.8)))
    result = []
    for name, start, end in bounds:
        sample = bars[start:end]
        table = base_features(sample)
        signals = []
        for d in definitions:
            events = eventize(d, table)
            actions, trace = interpret(d, events)
            signals.append((d["id"], d["role"], actions, trace, semantic_hash(d)))
        for d in legacy:
            raw, _ = causal_operator(d, table)
            signals.append(("legacy-"+d["id"], "legacy_same_replay", [0]*16+direction(raw)[16:], [], fingerprint(d)))
        signals.append(("cash", "baseline", [0]*len(sample), [], None))
        for ident, role, actions, trace, digest in signals:
            result.append({"id": ident, "role": role, "segment": name,
                           "range": [start, end], "operator_sha256": digest,
                           "base_cost": compact_score(sample, actions, .0007),
                           "double_cost": compact_score(sample, actions, .0014),
                           "transition_count": len(trace), "trace_sample": trace[:12]})
    return {"mode": "EXPLORATORY_DEVELOPMENT_ONLY", "holdout_used": False,
            "reserved_range": [int(n*.8), n], "fresh_validation": False,
            "can_submit_orders": False, "can_start_paper": False,
            "scientific_novelty_proven": False, "results": result}


def main():
    from algorithm_operator_lab import load_operators
    from run_alpha_audited import verify_snapshot
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, nargs="+", required=True)
    parser.add_argument("--operators", type=Path, required=True)
    parser.add_argument("--legacy", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    a = parser.parse_args()
    if a.out.exists() or a.out.resolve() in {p.resolve() for p in a.csv+[a.operators, a.legacy]}:
        raise FileExistsError("New report path required")
    definitions = load(a.operators)
    legacy = load_operators(a.legacy)["operators"]
    markets, seen, symbols = [], set(), set()
    for path in a.csv:
        bars, manifest, digest = verify_snapshot(path, path.with_suffix(".manifest.json"))
        if digest in seen or manifest["symbol"] in symbols:
            raise ValueError("Duplicate dataset or market")
        seen.add(digest)
        symbols.add(manifest["symbol"])
        result = development(bars, definitions, legacy)
        result.update({"symbol": manifest["symbol"], "dataset_sha256": digest,
                       "source": manifest["source"], "bars": len(bars)})
        markets.append(result)
    witnesses = [{"left": left["id"], "right": right["id"],
                  **distinguishing_witness(left, right)}
                 for i, left in enumerate(definitions) for right in definitions[i+1:]]
    report = {"schema": "algorithm_event_development_v2", "markets": markets,
              "proposal_sha256": fingerprint(definitions), "semantic_witnesses": witnesses,
              "all_inspected_hypotheses_reported": True,
              "inference": "NO_SIGNIFICANCE_CLAIM_ADAPTIVE_DEVELOPMENT",
              "decision": "NO_TRADE_INDEPENDENT_EVIDENCE_REQUIRED",
              "independent_validation": "PENDING_FUTURE_FROZEN_PROTOCOL",
              "cost_model": {"allocation": .1, "side_cost": .0007,
                             "funding": False, "liquidation": False,
                             "fill_uncertainty": False, "leverage": False}}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("x", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True, allow_nan=False)
        f.write("\n")
    print(json.dumps({"markets": len(markets), "hypotheses_per_market": len(definitions)+len(legacy),
                      "holdout_used": False, "decision": report["decision"]}))


if __name__ == "__main__":
    main()
