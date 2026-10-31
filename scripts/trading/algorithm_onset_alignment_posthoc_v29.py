#!/usr/bin/env python3
"""v29 HINDSIGHT ONLY quote-depth alignment exploratory split.

This division was proposed AFTER reading all 15 future outcomes. It MUST NOT
be called a preregistered classifier or successful prospective trade rule.
All sources are already cached official OKX archives with frozen source SHA.
"""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal as D
from pathlib import Path
from statistics import median
import json

from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_onset_L2_posthoc_alignment_v29"
ORIGINAL_SOURCE_SHA={
    "main_onset_934":"f9e867360169fc71c17fe94c3aa4649846f98584af6617db71da18c6fc853d86",
    "2026-09-03":"661c8168ea3f811be247f78e86a150ae32d07dbf399c7e0aa9a48d751119df67",
    "2026-09-04":"4e25e6bff759d99e5e49bc3a6a82fb8fcd2c681fb6cc3c2faebee0abbcc96044",
}
CATEGORIES=("FLOW_AND_DEPTH_CHANGE_SAME_DIRECTION",
            "FLOW_AND_DEPTH_CHANGE_OPPOSED_OR_FLAT")
OUTCOMES=("DIRECTIONAL_100BPS_FIRST","ADVERSE_100BPS_FIRST",
          "CENSORED_60_MINUTES","UNSCORABLE")


def audit(main_path,day1_path,day2_path):
    path=Path(main_path);raw=path.read_bytes()
    if sha256(raw)!=ORIGINAL_SOURCE_SHA["main_onset_934"]:
        raise ValueError("Original source-only first passage result changed")
    main=strictly_decode(raw,max_bytes=2*1024*1024)
    if (main.get("schema")!="algorithm_onset_first_passage_v29"
        or main["totals"]["decisions"]!=934
        or main["totals"]["selected_unique_onsets"]!=15):
        raise ValueError("Unexpected missing original 934-minute decision cohort")
    original_l2={}
    for day,p in (("2026-09-03",day1_path),("2026-09-04",day2_path)):
        raw=Path(p).read_bytes()
        if sha256(raw)!=ORIGINAL_SOURCE_SHA[day]:
            raise ValueError("Original 400-level asof book result changed")
        source=strictly_decode(raw)
        if (source.get("schema")!="algorithm_onset_l2_original_corrob_v29"
            or source.get("study_day_utc")!=day
            or source.get("v24_original_checkpoint_chain_validated") is not True):
            raise ValueError("Unverified original L2 asof checkpoint replay")
        for x in source["events"]:
            if not x["both_strict_asof_quotes_available"] or x["event_id"] in original_l2:
                raise ValueError("Missing, duplicate or invalid original L2 asof decision")
            original_l2[x["event_id"]]=x
    if len(original_l2)!=15:
        raise ValueError("Missing original fixed 15 strict L2 onset quotes")
    rows=[]
    for e in main["all_selected_onsets"]:
        l2=original_l2[e["id"]]
        if e["decision_utc"]!=l2["decision_utc"] or e["direction"]!=l2["flow_direction"]:
            raise ValueError("Original asof quote accidentally attributed to wrong event")
        if e["onset_kind"]!=l2["onset_group_based_only_on_past_taker_flow_and_completed_1min_close"]:
            raise ValueError("Original onset group modified after quote reconstruction")
        signed_change=D(e["direction"])*D(l2["source_L2_original_top5_imbalance_change_last60s"])
        cat=CATEGORIES[0] if signed_change>0 else CATEGORIES[1]
        outcome=e["future_historical_barrier_outcome_HINDSIGHT_ONLY"]
        rows.append({
            "event_id":e["id"],"decision_utc":e["decision_utc"],
            "onset_group_predeclared":e["onset_kind"],"direction":e["direction"],
            "original_L2_top5_imbalance_delta_signed_by_taker_direction":str(signed_change),
            "POST_HOC_alignment_category":cat,
            "fixed_first_passage_outcome":outcome["outcome"],
            "first_passage_minute":outcome["first_passage_minute"],
            "depth_measurement_known_by_exchange_event_time_only_NOT_receipt_proven":True,
        })
    if len(rows)!=15 or len({x["event_id"] for x in rows})!=15:
        raise ValueError("Original event cohort incomplete")
    groups=[]
    for category in CATEGORIES:
        x=[row for row in rows if row["POST_HOC_alignment_category"]==category]
        nums=[row["first_passage_minute"] for row in x if row["first_passage_minute"] is not None]
        groups.append({
            "category":category,
            "n":len(x),
            "frozen_outcome_counts":{outcome:sum(row["fixed_first_passage_outcome"]==outcome for row in x)
                                    for outcome in OUTCOMES},
            "median_first_passage_minute_any_direction":str(median(nums)) if nums else None,
            "not_an_independent_test_or_fit_safe_predictor":True,
        })
    return {
        "schema":SCHEMA,
        "status":"POSTRESULT_DIRECTIONAL_TAKER_FLOW_VS_L2_DEPTH_DIAGNOSTIC_ONLY",
        "original_source_SHA256":ORIGINAL_SOURCE_SHA,
        "all_original_15_onsets":rows,
        "posthoc_group_summaries":groups,
        "why_retrospective":"Top5 displayed-imbalance direction was compared with future winner/loser outcomes AFTER results were known. Not a preregistered v29 signal, cannot select threshold based on this data.",
        "source_days_previously_outcome_inspected_and_only_two_adjacent_days":True,
        "exchange_timestamp_source_only_no_independent_realtime_receipt_calibration":True,
        "source_does_not_prove_actual_order_cancellation_spoofing_or_liquidation":True,
        "is_new_profitable_alpha":False,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--main",required=True,type=Path)
    p.add_argument("--l2-sep03",required=True,type=Path)
    p.add_argument("--l2-sep04",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Postresult original evidence must be immutable")
    result=audit(a.main,a.l2_sep03,a.l2_sep04)
    with a.out.open("xb") as f:f.write(canonical(result)+b"\n")
    print(json.dumps({
        "status":result["status"],
        "groups":result["posthoc_group_summaries"],
        "result_sha256":sha256(a.out.read_bytes()),
        "can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
