#!/usr/bin/env python3
"""Development-only typed tape-memory experiment. JSON is never executable code.

Reads SHA-verified v30 public archives; never orders, accounts, or holdouts.
Minute decisions include the within-minute ordering of actual taker executions.
Delayed close outcomes and fee deductions are diagnostic proxies, NOT trade PnL.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import math
from pathlib import Path
from statistics import mean

import algorithm_v30_trade_onset as source
from algorithm_v30_summary import ORIGINALS

FEATURES = {"flow", "pressure", "response", "surprise", "absorption",
            "activity", "micro_shift", "market", "excess"}
HORIZON = 15
DELAY = 1
FEE_SCENARIOS = (10, 20)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def bounded(x):
    if not math.isfinite(x):
        raise ValueError("Nonfinite research value")
    return max(-8.0, min(8.0, x))


def validate(node, current=False, depth=0):
    if depth > 8 or not isinstance(node, list) or not node:
        raise ValueError("Invalid bounded AST")
    op = node[0]
    if op == "feature" and len(node) == 2 and node[1] in FEATURES:
        return
    if op == "constant" and len(node) == 2 and type(node[1]) in (int, float):
        if math.isfinite(node[1]) and -8 <= node[1] <= 8:
            return
    if node == ["previous"] or (current and node == ["current"]):
        return
    arity = {"neg": 1, "abs": 1, "positive": 1, "add": 2, "sub": 2,
             "mul": 2, "div": 2, "if_pos": 3}.get(op)
    if arity is not None and len(node) == arity + 1:
        for child in node[1:]:
            validate(child, current, depth + 1)
        return
    raise ValueError("Unsupported research operator")


def expression(node, features, previous, current):
    op = node[0]
    if op == "feature":
        return features[node[1]]
    if op == "constant":
        return float(node[1])
    if op == "previous":
        return previous
    if op == "current":
        return current
    v = [expression(n, features, previous, current) for n in node[1:]]
    if op == "neg":
        answer = -v[0]
    elif op == "abs":
        answer = abs(v[0])
    elif op == "positive":
        answer = max(0, v[0])
    elif op == "add":
        answer = v[0] + v[1]
    elif op == "sub":
        answer = v[0] - v[1]
    elif op == "mul":
        answer = v[0] * v[1]
    elif op == "div":
        answer = v[0] / v[1] if abs(v[1]) >= 0.05 else 0.0
    elif op == "if_pos":
        answer = v[1] if v[0] > 0 else v[2]
    else:
        raise ValueError("Unvalidated operation")
    return bounded(answer)


def proposals(path):
    def unique(items):
        d = {}
        for k, v in items:
            if k in d:
                raise ValueError("Duplicate JSON key")
            d[k] = v
        return d
    raw = Path(path).read_bytes()
    if len(raw) > 65536:
        raise ValueError("Proposal input too large")
    doc = json.loads(raw, object_pairs_hook=unique)
    if set(doc) != {"schema", "programs"} or doc["schema"] != "tape_memory_v31":
        raise ValueError("Unsupported proposal schema")
    if not 1 <= len(doc["programs"]) <= 12:
        raise ValueError("Bounded search budget exceeded")
    ids, semantics = set(), set()
    for p in doc["programs"]:
        if set(p) != {"id", "role", "hypothesis", "state", "output", "threshold"}:
            raise ValueError("Unexpected program fields")
        if p["role"] not in ("candidate", "ablation", "baseline"):
            raise ValueError("Unexpected role")
        if not isinstance(p["id"], str) or not p["id"].replace("-", "").isalnum():
            raise ValueError("Unsafe ID")
        if not isinstance(p["hypothesis"], str) or len(p["hypothesis"]) < 30:
            raise ValueError("Missing falsifiable rationale")
        if type(p["threshold"]) not in (int, float) or not 0 < p["threshold"] <= 8:
            raise ValueError("Invalid finite threshold")
        validate(p["state"])
        validate(p["output"], True)
        h = digest([p["state"], p["output"], p["threshold"]])
        if p["id"] in ids or h in semantics:
            raise ValueError("Duplicate program or semantics")
        ids.add(p["id"])
        semantics.add(h)
    return doc["programs"], hashlib.sha256(raw).hexdigest()


def run_program(p, rows):
    state = 0.0
    signals = []
    for row in rows:
        f = row["features"]
        old = state
        state = expression(p["state"], f, old, 0)
        value = expression(p["output"], f, old, state)
        signals.append(1 if value >= p["threshold"] else
                       -1 if value <= -p["threshold"] else 0)
    return signals


def features_from_minutes(minutes):
    """Normalization and impact regression use strictly PREVIOUS minutes."""
    returns, volumes, impacts = deque(maxlen=60), deque(maxlen=20), deque(maxlen=60)
    rows = []
    for m in minutes:
        sigma = max(1.0, math.sqrt(mean(x*x for x in returns))) if returns else 1.0
        avg_volume = mean(volumes) if volumes else 0
        flow = (m["buy"] - m["sell"]) / m["volume"] if m["volume"] else 0.0
        pressure = bounded((m["buy"] - m["sell"]) / avg_volume) if avg_volume else 0.0
        response = bounded(m["return_bps"] / sigma)
        beta = max(0.0, sum(x*y for x, y in impacts) /
                   (1 + sum(x*x for x, y in impacts)))
        f = {"flow": flow, "pressure": pressure, "response": response,
             "surprise": bounded(response - beta*pressure),
             "absorption": bounded(pressure - response / max(beta, 0.25)),
             "activity": bounded(m["volume"] / avg_volume) if avg_volume else 0.0,
             "micro_shift": m["late_flow"] - m["early_flow"],
             "market": bounded(m["market_bps"] / sigma),
             "excess": bounded((m["return_bps"] - m["market_bps"]) / sigma)}
        rows.append({"t": m["t"], "close": m["close"], "sigma": sigma,
                     "ready": len(returns) == 60 and avg_volume > 0,
                     "features": f})
        returns.append(m["return_bps"])
        volumes.append(m["volume"])
        impacts.append((pressure, response))
    return rows


def load_case(root, day, symbol):
    bars, hashes = {}, {}
    for s in (symbol,) + source.SYMS:
        bars[s], hashes[s] = source.load_bars(root, day, s)
    trades, hashes["tape"] = source.load_trades(root, day, symbol)
    stamps = [x[0] for x in trades]
    buckets = {}
    for ms, side, size in trades:
        minute = ms // 60000 * 60000
        b = buckets.setdefault(minute, [0.0]*6)
        index = 0 if side == "buy" else 1
        q = float(size)
        b[index] += q
        if ms % 60000 < 20000:
            b[2+index] += q
        if ms % 60000 >= 40000:
            b[4+index] += q
    keys = sorted(bars[symbol])
    minutes = []
    for i, k in enumerate(keys):
        b = buckets.get(k, [0.0]*6)
        prev = keys[max(0, i-1)]
        ret = lambda s: 10000*math.log(float(bars[s][k] / bars[s][prev]))
        minutes.append({"t": k+60000, "close": float(bars[symbol][k]),
                        "buy": b[0], "sell": b[1], "volume": b[0]+b[1],
                        "early_flow": (b[2]-b[3])/(b[2]+b[3]) if b[2]+b[3] else 0,
                        "late_flow": (b[4]-b[5])/(b[4]+b[5]) if b[4]+b[5] else 0,
                        "return_bps": ret(symbol),
                        "market_bps": (ret("BTC-USDT-SWAP")+ret("ETH-USDT-SWAP"))/2})
    rows = features_from_minutes(minutes)
    scope = set(source.cohort(day))
    v29 = []
    for row in rows:
        if row["t"] in scope:
            d = source.v29.detector_at(row["t"], trades, stamps, bars[symbol])
            v29.append(d["direction"] if d["trigger_qualification"] == "QUALIFIED_WITHOUT_COOLDOWN" else 0)
        else:
            v29.append(0)
    return rows, v29, hashes, scope


def barrier(row):
    return max(20.0, 3*math.sqrt(HORIZON)*row["sigma"])


def outcome(rows, i, direction):
    """Delayed minute CLOSE entry and exit, explicitly not executable quotes."""
    entry_i = i + DELAY
    end = entry_i + HORIZON
    if end >= len(rows):
        raise ValueError("Missing full outcome horizon")
    entry = rows[entry_i]["close"]
    boundary = barrier(rows[i])
    label, exit_i = "CENSORED", end
    for j in range(entry_i+1, end+1):
        r = direction*10000*math.log(rows[j]["close"]/entry)
        if abs(r) >= boundary:
            label, exit_i = ("FAVORABLE" if r > 0 else "ADVERSE"), j
            break
    gross = direction*10000*math.log(rows[exit_i]["close"]/entry)
    return {"outcome": label, "entry_i": entry_i, "exit_i": exit_i,
            "barrier_bps": boundary, "gross_close_proxy_bps": gross,
            "cost_proxy_bps": {str(f): gross-f for f in FEE_SCENARIOS}}


def episodes(rows, scope):
    """Algorithm-independent greedy nonoverlapping price-path episodes.

    Retrospective labels only. Detection requires an alarm at/before the
    anchor, within 5min; an alarm after anchor does not count as early.
    """
    out = []
    next_t = -1
    for i, row in enumerate(rows):
        if row["t"] not in scope or row["t"] < next_t or not row["ready"]:
            continue
        r = outcome(rows, i, 1)
        if r["outcome"] == "CENSORED":
            continue
        out.append({"anchor": row["t"], "crossing": rows[r["exit_i"]]["t"],
                    "direction": 1 if r["outcome"] == "FAVORABLE" else -1})
        next_t = row["t"] + (HORIZON+DELAY)*60000
    return out


def score(rows, actions, scope, episode_labels):
    alarms, next_t = [], -1
    for i, (row, d) in enumerate(zip(rows, actions)):
        if row["t"] not in scope or not row["ready"] or not d or row["t"] < next_t:
            continue
        o = outcome(rows, i, d)
        alarms.append({"t": row["t"], "direction": d, **o})
        # Fixed episode horizon, including the entry delay; never overlap positions.
        next_t = row["t"] + (HORIZON+DELAY)*60000
    detected, matched_alarm_times = [], set()
    for e in episode_labels:
        matches = [a for a in alarms if e["anchor"]-300000 <= a["t"] <= e["anchor"]
                   and a["direction"] == e["direction"]]
        if matches:
            detected.append((e["crossing"]-min(a["t"] for a in matches))/60000)
            matched_alarm_times.update(a["t"] for a in matches)
    n = len(alarms)
    return {"alarms": n, "favorable": sum(a["outcome"] == "FAVORABLE" for a in alarms),
            "adverse": sum(a["outcome"] == "ADVERSE" for a in alarms),
            "censored": sum(a["outcome"] == "CENSORED" for a in alarms),
            "episodes": len(episode_labels), "detected_early": len(detected),
            "missed": len(episode_labels)-len(detected),
            "early_recall": len(detected)/len(episode_labels) if episode_labels else None,
            "mean_warning_minutes": mean(detected) if detected else None,
            "unmatched_early_alarms": sum(a["t"] not in matched_alarm_times for a in alarms),
            "mean_cost_proxy_bps": {str(f): mean(a["cost_proxy_bps"][str(f)] for a in alarms)
                                    if n else None for f in FEE_SCENARIOS},
            "records": alarms}


def run(root, defs, proposal_sha):
    cases = []
    for day, symbol in ORIGINALS:
        rows, v29, hashes, scope = load_case(root, day, symbol)
        labels = episodes(rows, scope)
        result = {}
        for p in defs:
            result[p["id"]] = score(rows, run_program(p, rows), scope, labels)
        result["original-v29-trigger"] = score(rows, v29, scope, labels)
        cases.append({"day": day, "symbol": symbol, "source_sha": hashes,
                      "feature_sha": digest(rows), "expected_decisions": len(scope),
                      "episodes": labels, "programs": result})
    summary = {}
    for name in cases[0]["programs"]:
        samples = [c["programs"][name] for c in cases]
        all_records = [r for s in samples for r in s["records"]]
        per_case = [s["mean_cost_proxy_bps"]["20"] for s in samples]
        summary[name] = {"alarms": len(all_records),
                         "favorable": sum(s["favorable"] for s in samples),
                         "adverse": sum(s["adverse"] for s in samples),
                         "censored": sum(s["censored"] for s in samples),
                         "episodes": sum(s["episodes"] for s in samples),
                         "detected_early": sum(s["detected_early"] for s in samples),
                         "mean_20bp_close_proxy": mean(r["cost_proxy_bps"]["20"] for r in all_records)
                         if all_records else None,
                         "per_case_20bp_close_proxy": per_case,
                         "development_screen_pass": all(s["alarms"] >= 4 for s in samples)
                         and all(x is not None and x > 0 for x in per_case)}
    return {"schema": "algorithm_stream_v31_development", "proposals_sha": proposal_sha,
            "programs": [{**p, "semantic_sha": digest([p["state"],p["output"],p["threshold"]])}
                         for p in defs], "summary": summary, "cases": cases,
            "evaluation": {"horizon_minutes": HORIZON, "entry_delay_minutes": DELAY,
                           "cooldown_minutes": HORIZON+DELAY,
                           "barrier": "max(20bp,3*sqrt(15)*prior60min_RMS_return_bp)",
                           "effective_independent_day_count": 2,
                           "source_data_previously_examined": True,
                           "independent_validation": False,
                           "actual_quote_costs_available": False,
                           "news_coverage": "UNKNOWN",
                           "L2_replenishment_measured": False,
                           "realistic_trade_PnL": "UNAVAILABLE",
                           "scientific_novelty_established": False,
                           "approved_effective_algorithm": False}}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--proposals", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    a = p.parse_args()
    if a.out.exists():
        raise FileExistsError("Preserve original experiment output")
    defs, sha = proposals(a.proposals)
    result = run(a.root, defs, sha)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("x", encoding="utf-8") as f:
        json.dump(result, f, sort_keys=True, allow_nan=False)
    print(json.dumps({"summary": result["summary"], "output_sha":
                      hashlib.sha256(a.out.read_bytes()).hexdigest()}, allow_nan=False))


if __name__ == "__main__":
    main()
