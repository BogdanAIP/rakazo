#!/usr/bin/env python3
"""Exploratory cost/opportunity diagnostic, with deliberately noncausal labels.

Perfect future direction/exit are hindsight bounds, NEVER a tradable program.
Uses all frozen eligible minutes; overlapping labels are not strategy PnL.
"""
import argparse
import json
import math
from pathlib import Path
from statistics import mean, median

import algorithm_path_v35 as path


def hindsight(quote_path):
    if len(quote_path) != 16 or any(q.get("status") != "AVAILABLE" for q in quote_path):
        raise ValueError("Require complete entry plus fifteen subsequent quotes")
    entry = quote_path[0]
    long = [10000*math.log(float(q["bid"])/float(entry["ask"]))-20 for q in quote_path[1:]]
    short = [-10000*math.log(float(q["ask"])/float(entry["bid"]))-20 for q in quote_path[1:]]
    return {"always_long_terminal_bp":long[-1],"always_short_terminal_bp":short[-1],
            "LOOKAHEAD_best_terminal_direction_bp":max(long[-1],short[-1]),
            "LOOKAHEAD_best_direction_and_exit_bp":max(long+short)}


def analyze(source, development):
    status = json.loads((development/"run-status.json").read_bytes())
    if status["status"] != "COMPLETE":
        raise ValueError("Do not add a secondary diagnostic before frozen v35 completion")
    prior = path.verify_prior(source)
    panels = []
    for case in prior["cases"]:
        day,symbol = case["day"],case["symbol"]
        p = source/"features"/f"{symbol}-{day}-restoration-v32.json"
        if path.replay.digest(p) != case["restoration_cache_sha"]:
            raise ValueError("Frozen prior feature cache changed")
        book = json.loads(p.read_bytes())
        rows,_,_,scope = path.lab.load_case(source/"source",day,symbol,locator=path.pilot.registered)
        rows,quotes = path.replay.attach(rows,book)
        records = []
        for row in rows:
            t = row["t"]
            if t not in scope or not row["ready"]:
                continue
            qs = [quotes.get(t+k*60000,{}) for k in range(1,17)]
            records.append({"t":t,**hindsight(qs)})
        if len(records) != case["available_decisions"]:
            raise ValueError("Diagnostic eligible universe differs from frozen primary")
        keys = [k for k in records[0] if k != "t"]
        panels.append({"day":day,"symbol":symbol,"eligible_minutes":len(records),
            "mean":{k:mean(r[k] for r in records) for k in keys},
            "median_best_terminal_direction_bp":median(r["LOOKAHEAD_best_terminal_direction_bp"] for r in records),
            "positive_best_terminal_minutes":sum(r["LOOKAHEAD_best_terminal_direction_bp"]>0 for r in records),
            "positive_best_exit_minutes":sum(r["LOOKAHEAD_best_direction_and_exit_bp"]>0 for r in records),
            "records":records})
    return {"schema":"v35_secondary_hindsight_quote_budget","panels":panels,
            "prior_result_sha":path.replay.digest(source/"first-independent-v34.json"),
            "frozen_v35_result_sha":path.replay.digest(development/"first-development-v35.json"),
            "fee_round_trip_bp":20,"entry_delay_minutes":1,"maximum_hold_minutes":15,
            "trading_strategy":False,"independent_validation":False,
            "overlapping_minute_labels_are_strategy_PnL":False,
            "candidate_results_reinterpreted":False,
            "interpretation":"Hindsight opportunity for this fixed minute scenario only; abstention can select rare opportunities. Not an impossibility proof or executable edge."}


def main():
    p=argparse.ArgumentParser()
    for name in ("source","development","out"):
        p.add_argument("--"+name,type=Path,required=True)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Preserve first exploratory diagnostic")
    result=analyze(a.source,a.development)
    with a.out.open("x",encoding="utf-8") as out:
        json.dump(result,out,sort_keys=True,allow_nan=False)
    print(json.dumps({"sha":path.replay.digest(a.out),"panels":[{k:v for k,v in panel.items()
                      if k!="records"} for panel in result["panels"]]}))


if __name__=="__main__":main()
