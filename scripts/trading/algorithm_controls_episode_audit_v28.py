#!/usr/bin/env python3
"""v28 POST-RESULT overlap sensitivity audit: extreme hour windows are dependent.

Reads unchanged original 66-anchor joined result by strict original SHA.
Groups overlapping same-class 60min outcome windows; groups are descriptive
clusters, NOT independent events or causal proof and not a strategy.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
from decimal import Decimal
from pathlib import Path
import json

from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode
from algorithm_controls_v28 import SCHEMA,anchors

SCHEMA_AUDIT="algorithm_controls_overlap_episodes_v28"
RESULT_ORIGINAL_SHA="979c5fe4ba4a2925570349368fd8cfd415e94663c41ae9178dd5d56ed487cbb2"
EXTREME=("EXTREME_UP","EXTREME_DOWN")
WINDOW_MS=3600000


def iso(ms):
    return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat()


def inspect(original):
    raw=Path(original).read_bytes()
    if sha256(raw)!=RESULT_ORIGINAL_SHA:
        raise ValueError("Original v28 66-anchor source changed since analysis")
    obj=strictly_decode(raw)
    rows=obj["all_anchors_full_evidence"]
    if obj.get("schema")!=SCHEMA or len(rows)!=66 or {r["signal_exchange_utc_ms"] for r in rows}!=set(anchors()):
        raise ValueError("Unexpected missing, duplicated or repriced v28 source anchors")
    episodes=[]
    for klass in EXTREME:
        selected=sorted(
            (x for x in rows if x["outcome_60m"]["NEAR_absolute_class"]==klass),
            key=lambda r:r["signal_exchange_utc_ms"],
        )
        arr=[]
        for x in selected:
            t=x["signal_exchange_utc_ms"]
            start=t;end=t+WINDOW_MS
            if arr and arr[-1]["day"]==x["day"] and t<arr[-1]["end_utc_ms"]:
                ep=arr[-1]
                ep["end_utc_ms"]=max(end,ep["end_utc_ms"])
                ep["anchor_utc_ms"].append(t)
                ep["historical_shock_signals"].append(
                    x["exante_features"]["shock_rule"]["direction"]
                    if x["exante_features"]["shock_rule"]["status"]=="ELIGIBLE" else None)
            else:
                arr.append({
                    "day":x["day"],"first_anchor_utc_ms":t,
                    "end_utc_ms":end,
                    "anchor_utc_ms":[t],
                    "historical_shock_signals":[
                       x["exante_features"]["shock_rule"]["direction"]
                       if x["exante_features"]["shock_rule"]["status"]=="ELIGIBLE" else None],
                })
        episodes.append({
            "class":klass,"original_anchors":len(selected),
            "same_class_hour_window_overlap_groups":len(arr),
            "episodes":[{
                "day":e["day"],
                "first_anchor_utc":iso(e["first_anchor_utc_ms"]),
                "latest_horizon_end_utc":iso(e["end_utc_ms"]),
                "anchor_count":len(e["anchor_utc_ms"]),
                "underlying_frozen_anchor_times":[iso(t) for t in e["anchor_utc_ms"]],
                "pre_signal_shock_directions_or_null":e["historical_shock_signals"],
            } for e in arr],
            "groups_are_NOT_statistically_independent":True,
            "opposite_outcome_group_windows_may_also_overlap":True,
        })
    counts={}
    for r in rows:
        key=r["outcome_60m"]["NEAR_absolute_class"]
        item=counts.setdefault(key,{"anchors":0,"shock_total":0,"shock_long":0,"shock_short":0})
        item["anchors"]+=1
        rule=r["exante_features"]["shock_rule"]
        if rule["status"]=="ELIGIBLE":
            item["shock_total"]+=1
            item["shock_long" if rule["direction"]==1 else "shock_short"]+=1
    return {
        "schema":SCHEMA_AUDIT,
        "status":"POSTRESULT_DEPENDENT_WINDOW_AUDIT_NOT_TRADING_PROOF",
        "source_joined_original_sha256":RESULT_ORIGINAL_SHA,
        "outcome_classes_frozen_original":counts,
        "overlap_groups":episodes,
        "groups_cannot_be_used_as_independent_trading_events_or_days":True,
        "no_statistical_significance_or_pvalue":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--original-result",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Do not overwrite original posthoc audit")
    x=inspect(a.original_result)
    with a.out.open("xb") as f:f.write(canonical(x)+b"\n")
    print(json.dumps({
        "status":x["status"],
        "classes":x["outcome_classes_frozen_original"],
        "overlap_classes":[{"class":e["class"],"anchors":e["original_anchors"],
                            "overlapping_hour_groups":e["same_class_hour_window_overlap_groups"]}
                           for e in x["overlap_groups"]],
        "source_original_sha":x["source_joined_original_sha256"],
        "output_sha":sha256(a.out.read_bytes()),
        "can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
