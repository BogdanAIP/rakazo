#!/usr/bin/env python3
"""v28 AFTER-the-fact 60m crossed-quote fee sensitivity, original immutable sources.

This is NOT a trading backtest: sources are outcome-aware, 14 samples overlapping
two days, assumed fees5bps PER SIDE, no actual execution or funding. Top-winner
removal is a postresult fragility diagnostic, never a strategy training step.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
from pathlib import Path
import json

from algorithm_controls_v28 import V24_RESULTS,anchors
from algorithm_controls_episode_audit_v28 import RESULT_ORIGINAL_SHA
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_controls_fee_fragility_v28"


def score(original_root,joined_result):
    p=Path(joined_result)
    raw=p.read_bytes()
    if sha256(raw)!=RESULT_ORIGINAL_SHA:
        raise ValueError("v28 source original SHA mismatch")
    source=strictly_decode(raw)
    rows=source["all_anchors_full_evidence"]
    if len(rows)!=66 or {r["signal_exchange_utc_ms"] for r in rows}!=set(anchors()):
        raise ValueError("v28 source anchor cohort changed")
    v24={}
    for day,expected_sha in V24_RESULTS.items():
        path=Path(original_root)/f"NEAR-{day}"/f"NEAR-{day}-frozen-v23-replication-v24.json"
        data=path.read_bytes()
        if sha256(data)!=expected_sha:
            raise ValueError("Original v24 actual archived source changed")
        record=strictly_decode(data)
        source_matches=[
            a for a in record["anchor_candidate_horizon_rows"]
            if a["candidate"]=="pressure_shock_without_mid_adaptation" and a["horizon_s"]==3600
        ]
        v24[day]={x["anchor_exchange_utc_ms"]:x for x in source_matches}
        if len(v24[day])!=58:
            raise ValueError("Incomplete pre-registered original v24 source rows")
    cases=[]
    for event in rows:
        exante=event["exante_features"]["shock_rule"]
        source_row=v24[event["day"]][event["signal_exchange_utc_ms"]]
        if exante["status"]!=source_row["signal"]["status"] or exante["direction"]!=source_row["signal"]["direction"]:
            raise ValueError("Original frozen signal differs from v28 recovered feature")
        if exante["status"]!="ELIGIBLE":continue
        outcome=source_row["outcome"]
        if outcome["status"]!="EVALUATED_HISTORICAL_QUOTE_PROXY":
            raise ValueError("Missing actual source data at scheduled 60m horizon")
        cases.append({
            "signal_utc":event["signal_utc"],
            "direction":exante["direction"],
            "source_quote_hypothetical_net_fee5_bps":outcome["net_fee5_each_side_bps"],
            "source_quote_hypothetical_net_fee7_bps":outcome["net_fee7_each_side_bps"],
            "historical_outcome_class_NEAR_move":event["outcome_60m"]["NEAR_absolute_class"],
            "actual_execution":False,
        })
    values=sorted(Decimal(x["source_quote_hypothetical_net_fee5_bps"]) for x in cases)
    total=sum(values,Decimal(0))
    n=len(values)
    if n<3:raise ValueError("Too few original eligible rows to audit")
    median=(values[(n-1)//2]+values[n//2])/Decimal(2)
    return {
        "schema":SCHEMA,
        "status":"POST_HOC_ORIGINAL_SOURCE_QUOTE_FEE_SENSITIVITY_NOT_VALIDATED_ALPHA",
        "joined_v28_original_sha256":RESULT_ORIGINAL_SHA,
        "original_v24_source_sha256":V24_RESULTS,
        "total_frozen_time_anchors":66,
        "original_v23_shock_eligible_anchor_count":n,
        "hypothetical_profitable_count_fee5_each_side":sum(x>0 for x in values),
        "fee5_mean_bps":str(total/Decimal(n)),
        "fee5_median_bps":str(median),
        "fee5_min_bps":str(values[0]),
        "fee5_max_bps":str(values[-1]),
        "post_hoc_fee5_mean_excluding_one_best_bps":str((total-values[-1])/Decimal(n-1)),
        "post_hoc_fee5_mean_excluding_two_best_bps":str((total-values[-1]-values[-2])/Decimal(n-2)),
        "original_case_outcomes":cases,
        "cases_overlap_in_two_adjacent_days":True,
        "fee_rates_account_verified":False,
        "actual_fills_slippage_funding_verified":False,
        "hindsight_removal_is_not_rule_selection_or_preregistered_filter":True,
        "realized_PnL":None,
        "validated_profitable_algorithm":False,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--original-l2-root",type=Path,required=True)
    ap.add_argument("--joined-v28",type=Path,required=True)
    ap.add_argument("--out",type=Path,required=True)
    args=ap.parse_args()
    if args.out.exists():raise FileExistsError("Immutable diagnostic already exists")
    r=score(args.original_l2_root,args.joined_v28)
    with args.out.open("xb") as f:f.write(canonical(r)+b"\n")
    print(json.dumps({
        "status":r["status"],
        "signals":r["original_v23_shock_eligible_anchor_count"],
        "gross_profitable_after_assumed_fee":r["hypothetical_profitable_count_fee5_each_side"],
        "mean_net_fee5_bps":r["fee5_mean_bps"],
        "median_net_fee5_bps":r["fee5_median_bps"],
        "posthoc_mean_excluding_one_best_bps":r["post_hoc_fee5_mean_excluding_one_best_bps"],
        "output_sha256":sha256(args.out.read_bytes()),"can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
