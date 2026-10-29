#!/usr/bin/env python3
"""Operator Discovery Lab v1: bounded model-designed causal state machines.

Research only. A model proposes declarative mathematical transition rules,
which extend the former stateless AST expression language with RESETTABLE
MEMORY. No eval/exec, network, exchange activity, holdout, or scheduling.
Uniqueness within this grammar is not scientific or mathematical novelty.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import random
import re
from pathlib import Path

from algorithm_discovery_lab import (
    MIN_BARS, base_features, clip, evaluate, next_bar_returns, score,
    validate_ast, SIGNAL_FLOOR,
)
from run_alpha_audited import verify_snapshot

SCHEMA = "operator_discovery_proposals_v1"
MAX_PROPOSALS = 8
MAX_JSON = 32_768
NULL_DRAWS = 39


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, separators=(",", ":"), sort_keys=True,
                   allow_nan=False).encode("utf-8")
    ).hexdigest()


def num(value, low, high, label):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("Invalid numeric " + label)
    if not low <= value <= high:
        raise ValueError("Numeric bound exceeded " + label)
    return float(value)


def validate_operator(definition):
    if not isinstance(definition, dict):
        raise ValueError("Operator must be a mapping")
    expected = {"id", "hypothesis", "parent_id", "failure_addressed",
                "kind", "innovation", "reset_when", "decay", "gain",
                "reset_threshold", "state_limit"}
    if set(definition) != expected:
        raise ValueError("Unexpected operator fields")
    name = definition["id"]
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{3,59}", name):
        raise ValueError("Unsafe operator identifier")
    if definition["kind"] != "resettable_state":
        raise ValueError("Only declarative causal resettable state supported")
    for field in ("hypothesis", "failure_addressed"):
        value = definition[field]
        if not isinstance(value, str) or not 30 <= len(value) <= 700:
            raise ValueError("Missing scientific justification: " + field)
    parent = definition["parent_id"]
    if parent is not None and (not isinstance(parent, str) or
            not re.fullmatch(r"[a-z][a-z0-9-]{3,59}", parent)):
        raise ValueError("Invalid lineage parent")
    validate_ast(definition["innovation"])
    validate_ast(definition["reset_when"])
    num(definition["decay"], 0, 0.99, "decay")
    num(definition["gain"], 0.05, 4.0, "gain")
    num(definition["reset_threshold"], -4.0, 4.0, "reset_threshold")
    num(definition["state_limit"], 0.5, 8.0, "state_limit")
    return definition


def load_operators(path):
    path = Path(path)
    if path.stat().st_size > MAX_JSON:
        raise ValueError("Operator proposal input too large")
    data = path.read_bytes()
    doc = json.loads(data.decode("utf-8-sig"),
                     parse_constant=lambda x: (_ for _ in ()).throw(ValueError("No NaN/Infinity")))
    if (not isinstance(doc, dict) or set(doc) != {"schema", "operators"}
            or doc["schema"] != SCHEMA):
        raise ValueError("Unsupported operator proposal schema")
    rows = doc["operators"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_PROPOSALS:
        raise ValueError("Only 1..8 research operators per batch")
    ids = set()
    hashes = set()
    for row in rows:
        validate_operator(row)
        if row["id"] in ids or fingerprint(row) in hashes:
            raise ValueError("Duplicate operator")
        ids.add(row["id"])
        hashes.add(fingerprint(row))
    return {"file_sha256": hashlib.sha256(data).hexdigest(),
            "operators": rows, "untrusted_source_executed": False,
            "science_level_novelty_verified": False}


def causal_operator(definition, table):
    """r_t = clip(decay*r_{t-1} + gain*innovation_t); reset clears memory.

    Reset criterion depends on already closed candle t. The output at t
    does not depend on any future row, target or open order.
    """
    validate_operator(definition)
    innovation = evaluate(definition["innovation"], table)
    trigger = evaluate(definition["reset_when"], table)
    decay = float(definition["decay"])
    gain = float(definition["gain"])
    threshold = float(definition["reset_threshold"])
    limit = float(definition["state_limit"])
    state = 0.0
    output = []
    resets = []
    for i, (value, signal) in enumerate(zip(innovation, trigger)):
        reset = signal > threshold
        if reset:
            state = 0.0
            resets.append(i)
        state = max(-limit, min(limit, decay * state + gain * value))
        output.append(clip(state))
    return output, resets


def direction(series):
    return [1 if x > SIGNAL_FLOOR else -1 if x < -SIGNAL_FLOOR else 0
            for x in series]


def probe_signature(operator):
    """Empirical distinction on fixed synthetic probes, NOT global novelty."""
    from alpha_discovery import Candle
    from datetime import datetime, timezone, timedelta
    signatures = []
    t = datetime(2024, 1, 1, tzinfo=timezone.utc)
    for regime in ("flat", "saw", "shock"):
        rows = []
        for i in range(128):
            centre = 100.0 if regime == "flat" else (100 + (i % 12) * 0.06
                      if regime == "saw" else 100 + (4.0 if 47 <= i < 51 else 0.001*i))
            opening = centre - (0.02 if i % 2 else -0.01)
            closing = centre + (0.02 if i % 3 else -0.02)
            rows.append(Candle(t + timedelta(minutes=15*i), opening,
                               max(opening,closing)+0.04,
                               min(opening,closing)-0.04,
                               closing, 100+(i%11)*20))
        signal, _ = causal_operator(operator, base_features(rows))
        signatures.append([round(v, 6) for v in signal[20:]])
    return fingerprint(signatures)


def null_maximum(candidate_actions, outcomes, start, end, observed, seed):
    n = end - start - 1
    rng = random.Random(seed)
    shifts = rng.sample(range(32, n-32), min(NULL_DRAWS, n-64))
    maxima = [max(score(a, outcomes, start, end, shift=sh)["mean_pnl_per_bar"]
                  for a in candidate_actions)
              for sh in shifts]
    p = (1 + sum(x >= observed for x in maxima)) / (1 + len(maxima))
    return {"max_null_p_exploratory": p, "draws": len(maxima),
            "null_max_mean": max(maxima),
            "formal_familywise_error_control": False}


def research(bars, definitions, seed=42):
    if len(bars) < MIN_BARS:
        raise ValueError("At least 1200 complete bars required")
    if not 1 <= len(definitions) <= MAX_PROPOSALS:
        raise ValueError("Invalid operator batch")
    for d in definitions:
        validate_operator(d)
    features = base_features(bars)
    outcomes = next_bar_returns(bars)
    n = len(bars)
    train_end, validation_end = int(n * 0.6), int(n * 0.8)
    candidates = []
    observations = []
    fingerprints = {}
    for d in definitions:
        program_id = fingerprint(d)
        behavior_id = probe_signature(d)
        series, resets = causal_operator(d, features)
        actions = direction(series)
        training = score(actions, outcomes, 16, train_end)
        validation = score(actions, outcomes, train_end, validation_end)
        middle = (train_end + validation_end)//2
        earlier = score(actions, outcomes, train_end, middle)
        later = score(actions, outcomes, middle, validation_end)
        if training["trades"] < 20:
            diagnosis = "insufficient_train_activity"
        elif training["mean_pnl_per_bar"] <= 0:
            diagnosis = "non_positive_training_after_cost"
        elif validation["trades"] < 12:
            diagnosis = "insufficient_validation_activity"
        elif validation["mean_pnl_per_bar"] <= 0:
            diagnosis = "non_positive_validation_after_cost"
        elif earlier["mean_pnl_per_bar"] <= 0 or later["mean_pnl_per_bar"] <= 0:
            diagnosis = "failure_in_validation_subregime"
        else:
            diagnosis = "requires_selection_adjusted_null"
            candidates.append((d["id"], actions, validation))
        if behavior_id in fingerprints:
            equiv = fingerprints[behavior_id]
        else:
            fingerprints[behavior_id] = d["id"]
            equiv = None
        observations.append({
            "id": d["id"], "operator_sha256": program_id,
            "parent_id": d["parent_id"],
            "failure_addressed": d["failure_addressed"],
            "hypothesis": d["hypothesis"],
            "synthetic_probe_fingerprint": behavior_id,
            "probe_indistinguishable_from": equiv,
            "resets_train": sum(x < train_end for x in resets),
            "train": training, "validation": validation,
            "validation_first_half": earlier,
            "validation_second_half": later,
            "diagnosis": diagnosis,
            "scientific_novelty_confirmed": False,
        })
    null = None
    if candidates:
        best = max(v["mean_pnl_per_bar"] for _, _, v in candidates)
        null = null_maximum([a for _,a,_ in candidates], outcomes,
                            train_end,validation_end,best,seed)
        for o in observations:
            if o["diagnosis"] == "requires_selection_adjusted_null":
                o["diagnosis"] = ("provisional_requires_independent_replication"
                                  if null["max_null_p_exploratory"] <= 0.05
                                  else "negative_null_control")
    return {
        "protocol": "algorithm_operator_research_v1",
        "mode": "DEVELOPMENT_ONLY",
        "can_submit_orders": False,
        "can_start_paper": False,
        "research_input_features": "causal_OHLCV_only",
        "scientific_novelty_proven": False,
        "funding_and_liquidation_modeled": False,
        "dataset_bars": n,
        "train_range": [0, train_end],
        "validation_range": [train_end, validation_end],
        "reserved_holdout_range": [validation_end, n],
        "holdout_used": False,
        "operator_count": len(observations),
        "operators": observations,
        "null": null,
        "decision": (
            "PROVISIONAL_ONLY_NO_TRADING" if null and
            null["max_null_p_exploratory"] <= 0.05
            else "FALSIFIED_REVISE_OPERATOR_MECHANISM"
        ),
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv", type=Path, required=True)
    p.add_argument("--operators", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--seed", type=int, default=42)
    a=p.parse_args()
    if a.out.exists() or a.out.resolve() == a.csv.resolve():
        raise FileExistsError("Report must use a new path")
    # Source verification rechecks original archive digests.
    bars, manifest, digest = verify_snapshot(
        a.csv, a.csv.with_suffix(".manifest.json"))
    if manifest["source"] not in ("official_archive", "public_get"):
        raise ValueError("Actual verified market history required")
    proposals = load_operators(a.operators)
    result = research(bars, proposals["operators"], seed=a.seed)
    result["dataset_sha256"] = digest
    result["operator_file_sha256"] = proposals["file_sha256"]
    result["operator_source"] = str(a.operators)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("x", encoding="utf-8") as f:
        json.dump(result, f, indent=2, sort_keys=True)
        f.write("\n")
    print(json.dumps({
        "status": result["decision"], "operators": result["operator_count"],
        "holdout_used": False, "can_submit_orders": False
    }))


if __name__ == "__main__":
    main()
