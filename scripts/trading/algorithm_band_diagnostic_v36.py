#!/usr/bin/env python3
"""Post-run source ambiguity and counterexample traces; no new candidate fit."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
from statistics import mean, median

import algorithm_band_v36 as band


def analyze(root,expected_sha):
    journal=json.loads((root/"run-status.json").read_bytes())
    result_file=root/"first-development-v36.json"
    if journal["status"]!="COMPLETE" or band.replay.digest(result_file)!=expected_sha:
        raise ValueError("Require exact completed frozen primary result")
    result=json.loads(result_file.read_bytes())
    definitions={p["id"]:p for p in result["programs"]}
    panels=[]
    for case in result["cases"]:
        p=root/"features"/f"{case['symbol']}-{case['day']}-restoration-v32.json"
        if band.replay.digest(p)!=case["restoration_cache_sha"]:
            raise ValueError("Original geometry cache changed")
        book=json.loads(p.read_bytes())
        rows,_=band.attach([{"t":t,"ready":True,"features":{"flow":0.0}}
                           for t in band.lab.source.cohort(case["day"])],book)
        counts=Counter()
        for row in rows:
            if not row["ready"]:continue
            counts["covered_decisions"]+=1
            f=row["features"]
            bid_uncertain=f["bid_lower"]<=0<=f["bid_upper"] and f["bid_lower"]!=f["bid_upper"]
            ask_uncertain=f["ask_lower"]<=0<=f["ask_upper"] and f["ask_lower"]!=f["ask_upper"]
            counts["bid_sign_ambiguous"]+=bid_uncertain
            counts["ask_sign_ambiguous"]+=ask_uncertain
            counts["either_side_sign_ambiguous"]+=bid_uncertain or ask_uncertain
            values={name:band.lab.expression(definitions[name]["output"],f,0,0)
                    for name in ("interval-accounting","all-visible-point","depth-delta-only")}
            v,point,delta=(values[k] for k in ("interval-accounting","all-visible-point","depth-delta-only"))
            counts["raw_interval_nonzero"]+=v!=0
            counts["raw_point_nonzero"]+=point!=0
            counts["raw_delta_nonzero"]+=delta!=0
            counts["point_nonzero_interval_zero"]+=point!=0 and v==0
            counts["delta_nonzero_interval_zero"]+=delta!=0 and v==0
            if v:
                if not (point*v>0 and delta*v>0 and abs(v)<=abs(point)+1e-12 and abs(v)<=abs(delta)+1e-12):
                    raise ValueError("Conditional interval support/magnitude invariant failed")
        if counts["covered_decisions"]!=case["available_decisions"]:
            raise ValueError("Post-run coverage differs from frozen primary")
        c=case["programs"]["interval-accounting"]
        if len(c["records"])!=len(c["quoted_scenarios"]):
            raise ValueError("Alarm/scenario identity differs")
        quoted=[(a,q) for a,q in zip(c["records"],c["quoted_scenarios"])
                if q["status"]=="QUOTED_TOP_OF_BOOK_SCENARIO"]
        values=[q["after_20bp_fee_bps"] for a,q in quoted]
        worst=None
        if quoted:
            a,q=min(quoted,key=lambda x:x[1]["after_20bp_fee_bps"])
            worst={"signal_utc":datetime.fromtimestamp(a["t"]/1000,timezone.utc).isoformat(),
                   "direction":a["direction"],"after20bp":q["after_20bp_fee_bps"],
                   "gross_quote_bp":q["gross_quote_bps"],"outcome":q["outcome"],
                   "minutes_after_entry":q["exit_minutes_after_entry"]}
        panels.append({"day":case["day"],"symbol":case["symbol"],"source_counts":dict(counts),
            "candidate_positive_after20":sum(v>0 for v in values),
            "candidate_negative_after20":sum(v<0 for v in values),
            "candidate_median_after20":median(values) if values else None,
            "candidate_mean_after20":mean(values) if values else None,
            "worst_candidate_quoted_scenario":worst,
            "candidate_scheduled_context_alarms":sum(bool(a["scheduled_context_120min"]) for a in c["records"]),
            "candidate_actual_news_coverage":"UNKNOWN"})
    return {"schema":"v36_post_run_ambiguity_counterexamples","primary_sha":expected_sha,
            "panels":panels,"source_ambiguity_counts_have_no_future_outcomes":True,
            "worst_examples_selected_retrospectively":True,"new_candidate_search":False,
            "changes_primary_verdict":False,"observed_support_invariants_passed":True}


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--primary-sha",required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Preserve first diagnostic")
    result=analyze(a.root,a.primary_sha)
    with a.out.open("x",encoding="utf-8") as f:json.dump(result,f,sort_keys=True,allow_nan=False)
    print(json.dumps({"sha":band.replay.digest(a.out),"panels":result["panels"]}))


if __name__=="__main__":main()
