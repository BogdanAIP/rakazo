#!/usr/bin/env python3
"""Development-only event-path features on previously opened v34 sources.

Typed reviewed primitives, no generated code, source requests, orders or fits.
Equal-exchange-time packets are coalesced before measuring event ordering.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import subprocess
import sys

import algorithm_independent_v34 as pilot
import algorithm_restoration_v32 as replay
import algorithm_stream_v31 as lab
from algorithm_l2_checkpoint_v22 import current_best
from algorithm_rank_v33 import rank_actions

EXTRA_FEATURES = {"event_ofi", "queue_ofi", "transport_ofi", "phase_area"}
PROGRAM_IDS = {"queue-leads-price", "queue-follows-price", "order-blind-area",
               "canonical-ofi", "static-queue", "price-transport", "flow-baseline",
               "depth-baseline", "return-baseline"}


def capture(book, heaps):
    bid, ask = current_best(book, heaps)
    return bid, book["bids"][bid], ask, book["asks"][ask]


def contributions(old, new):
    """Canonical best-quote OFI, split into unchanged-price and transport parts."""
    b0, qb0, a0, qa0 = old
    b1, qb1, a1, qa1 = new
    bid = (qb1 if b1 >= b0 else 0)-(qb0 if b1 <= b0 else 0)
    ask = -(qa1 if a1 <= a0 else 0)+(qa0 if a1 >= a0 else 0)
    static = [float(bid) if b1 == b0 else 0.0,
              float(ask) if a1 == a0 else 0.0]
    transport = [float(bid)-static[0], float(ask)-static[1]]
    dy = 10000*math.log(float((b1+a1)/(b0+a0)))
    return [float(bid), float(ask)], static, transport, dy


def accumulate(bucket, old, new):
    all_ofi, static, transport, dy = contributions(old, new)
    p = bucket.setdefault("path", {"n":0, "ofi":0.0, "ofi_abs":0.0,
        "static":0.0, "static_abs":0.0, "transport":0.0, "transport_abs":0.0,
        "x":0.0, "y":0.0, "abs_x":0.0, "abs_y":0.0, "area":0.0})
    dx = sum(static)
    p["area"] += p["x"]*dy-p["y"]*dx
    p["x"] += dx
    p["y"] += dy
    p["abs_x"] += abs(dx)
    p["abs_y"] += abs(dy)
    for key, parts in (("ofi",all_ofi),("static",static),("transport",transport)):
        p[key] += sum(parts)
        p[key+"_abs"] += sum(abs(v) for v in parts)
    p["n"] += 1


class PathHook:
    """Observe the net quote transition for one entire exchange timestamp."""
    def __init__(self):
        self.ts = None
        self.old = None
        self.bucket = None
        self.blocked = False

    def advance(self, ts, book, heaps):
        if self.ts is not None and ts < self.ts:
            raise ValueError("Noncausal exchange timestamp")
        if self.ts is not None and ts != self.ts:
            if self.old is not None and not self.blocked:
                accumulate(self.bucket, self.old, capture(book,heaps))
            self.old, self.bucket = None, None
            self.blocked = False
        self.ts = ts

    def stage(self, ts, action, book, heaps, bucket):
        if ts != self.ts:
            raise ValueError("Advance each timestamp before staging")
        if action == "snapshot":
            self.old, self.bucket, self.blocked = None, None, True
        elif action == "update":
            if not self.blocked and self.old is None:
                self.old, self.bucket = capture(book,heaps), bucket
        else:
            raise ValueError("Unsupported original event action")


def normalized(path):
    def ratio(x, y):
        value = x/y if y else 0.0
        if not math.isfinite(value) or abs(value) > 1+1e-7:
            raise ValueError("Invalid normalized path feature")
        return max(-1.0,min(1.0,value))
    return {"event_ofi":ratio(path["ofi"],path["ofi_abs"]),
            "queue_ofi":ratio(path["static"],path["static_abs"]),
            "transport_ofi":ratio(path["transport"],path["transport_abs"]),
            "phase_area":ratio(path["area"],path["abs_x"]*path["abs_y"])}


def attach(rows, book):
    rows, quotes = replay.attach(rows,book)
    bins = {int(t):b for t,b in book["bins"].items()}
    for row in rows:
        path = bins.get(row["t"],{}).get("path")
        available = row["restoration_available"] and path is not None and path["n"] > 0
        row["restoration_available"] = available
        row["ready"] = row["ready"] and available
        row["features"].update(normalized(path) if available else
                               {key:0.0 for key in EXTRA_FEATURES})
    return rows, quotes


def verify_prior(root):
    if json.loads((root/"run-status.json").read_bytes())["status"] != "COMPLETE":
        raise ValueError("Prior frozen experiment is not complete")
    prior = root/"first-independent-v34.json"
    if replay.digest(prior) != "1fedb2058c5612c5bee5e82d60ce31f7d1eb61fdc899e5890f340bda5c697272":
        raise ValueError("Unexpected prior cohort/result identity")
    return json.loads(prior.read_bytes())


def extract(root, day, symbol):
    prior = verify_prior(root)
    case = next(c for c in prior["cases"] if (c["day"],c["symbol"]) == (day,symbol))
    p = root/"features"/f"{symbol}-{day}-restoration-v32.json"
    if replay.digest(p) != case["restoration_cache_sha"]:
        raise ValueError("Previously observed feature cache changed")
    old = json.loads(p.read_bytes())
    result = replay.extract(root,day,symbol,source_manifest=pilot.manifest,
        index_name=f"{symbol}-{day}-snapshot-index-v34.json",transition_hook=PathHook())
    # Instrumentation must not alter any prior quote or restoration observation.
    if ({str(t):q for t,q in result["quotes"].items()} != old["quotes"]
            or result["source_rows"] != old["source_rows"]):
        raise ValueError("Instrumented replay disagrees with original observations")
    if {str(t):{k:v for k,v in b.items() if k != "path"}
            for t,b in result["bins"].items()} != old["bins"]:
        raise ValueError("Instrumented minute buckets changed")
    result["schema"] = "original_event_path_v35_development"
    result["prior_cache_sha"] = replay.digest(p)
    result["equal_timestamp_packets_coalesced"] = True
    result["legacy_observations_reconciled"] = True
    return result


def evaluate(root, cache, proposals):
    prior = verify_prior(root)
    for case in prior["cases"]:
        p = cache/f"{case['symbol']}-{case['day']}-restoration-v32.json"
        stored = json.loads(p.read_bytes())
        if (stored.get("schema") != "original_event_path_v35_development"
                or stored.get("prior_cache_sha") != case["restoration_cache_sha"]
                or stored.get("day") != case["day"] or stored.get("symbol") != case["symbol"]
                or stored.get("legacy_observations_reconciled") is not True
                or stored.get("equal_timestamp_packets_coalesced") is not True):
            raise ValueError("New path cache has an invalid lineage")
    lab.FEATURES.update(replay.EXTRA_FEATURES|EXTRA_FEATURES)
    definitions, sha = lab.proposals(proposals)
    if {p["id"] for p in definitions} != PROGRAM_IDS:
        raise ValueError("Fixed development budget changed")
    result = replay.evaluate(root,cache,definitions,sha,action_function=rank_actions,
        cohort=pilot.CASES,locator=pilot.registered,feature_attacher=attach)
    result["schema"] = "event_path_v35_development"
    result["prior_result_sha"] = replay.digest(root/"first-independent-v34.json")
    result["independent_validation"] = False
    result["source_data_previously_examined"] = True
    result["programs"] = definitions
    candidate = "queue-leads-price"
    required_controls = ("queue-follows-price","order-blind-area","canonical-ofi",
                         "flow-baseline","depth-baseline","return-baseline")
    screen = []
    for case in result["cases"]:
        c = case["programs"][candidate]
        comparators = [case["programs"][k] for k in required_controls]
        passed = (c["alarms"] >= 4 and c["quote_path_unavailable"] == 0
                  and c["mean_quote_20bp"] is not None and c["mean_quote_20bp"] > 0
                  and all(p["alarms"] >= 4 and p["quote_path_unavailable"] == 0
                          and p["mean_quote_20bp"] is not None
                          and c["mean_quote_20bp"] > p["mean_quote_20bp"] for p in comparators))
        screen.append({"day":case["day"],"symbol":case["symbol"],"pass":passed})
    result["candidate_control_screen"] = screen
    result["candidate_development_pass"] = all(x["pass"] for x in screen)
    result["effective_algorithm_confirmed"] = False
    result["scientific_novelty_established"] = False
    result["news_coverage"] = prior["news"]["complete_coverage"]
    return result


def run_all(source, output, expected_head):
    workspace = Path(__file__).resolve().parents[2]
    head = subprocess.run(["git","rev-parse","HEAD"],cwd=workspace,capture_output=True,
                          text=True,check=True).stdout.strip()
    status = subprocess.run(["git","status","--porcelain"],cwd=workspace,capture_output=True,
                            text=True,check=True).stdout.strip()
    if head != expected_head or status:
        raise ValueError("Require frozen clean development head")
    verify_prior(source)
    if output.resolve() == source.resolve() or source.resolve() in output.resolve().parents:
        raise ValueError("New development outputs must be separate from the frozen source run")
    output.mkdir(parents=True,exist_ok=True)
    journal_path = output/"run-status.json"
    journal = {"schema":"v35_finite_stage_journal","frozen_head":head,"status":"RUNNING",
               "completed":[],"started_utc":datetime.now(timezone.utc).isoformat()}
    with journal_path.open("x",encoding="utf-8") as f:
        json.dump(journal,f,sort_keys=True)
    stages = []
    cache = output/"features"
    for day,symbol in pilot.CASES:
        stages.append((f"extract-{symbol}-{day}",
            ["--day",day,"--symbol",symbol],cache/f"{symbol}-{day}-restoration-v32.json",300))
    stages.append(("evaluate",["--cache",str(cache),"--proposals",
        str(workspace/"docs/trading/ALGORITHM-PATH-PROPOSALS-v35.json")],
        output/"first-development-v35.json",180))
    for label,extras,out,timeout in stages:
        journal.update(stage=label,updated_utc=datetime.now(timezone.utc).isoformat())
        journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
        print(json.dumps({"stage":label,"status":"STARTING"}),flush=True)
        try:
            subprocess.run([sys.executable,str(Path(__file__).resolve()),"--root",str(source),
                            "--out",str(out)]+extras,cwd=workspace,check=True,timeout=timeout)
        except (subprocess.SubprocessError,OSError) as error:
            journal.update(status="INCOMPLETE_EXECUTION",error_type=type(error).__name__)
            journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
            raise
        journal["completed"].append({"stage":label,"sha":replay.digest(out)})
        journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
    journal.update(status="COMPLETE",updated_utc=datetime.now(timezone.utc).isoformat())
    journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
    return {"status":"COMPLETE","frozen_head":head,
            "result_sha":replay.digest(output/"first-development-v35.json")}


def main():
    p = argparse.ArgumentParser()
    for arg in ("root","out"):
        p.add_argument("--"+arg,type=Path,required=True)
    p.add_argument("--day",choices=pilot.DAYS)
    p.add_argument("--symbol",choices=pilot.SYMBOLS)
    p.add_argument("--cache",type=Path)
    p.add_argument("--proposals",type=Path)
    p.add_argument("--run-dir",type=Path)
    p.add_argument("--expected-head")
    a = p.parse_args()
    if a.out.exists():
        raise FileExistsError("Preserve first development output")
    if a.run_dir:
        result = run_all(a.root,a.run_dir,a.expected_head)
    else:
        result = extract(a.root,a.day,a.symbol) if a.day else evaluate(a.root,a.cache,a.proposals)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    with a.out.open("x",encoding="utf-8") as f:
        json.dump(result,f,sort_keys=True,allow_nan=False)
    print(json.dumps({"sha":replay.digest(a.out),"summary":result.get("summary"),
                      "source_rows":result.get("source_rows"),
                      "candidate_pass":result.get("candidate_development_pass")}))


if __name__ == "__main__":
    main()
