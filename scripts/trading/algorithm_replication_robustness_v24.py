#!/usr/bin/env python3
"""v24 POST-RESULT descriptive robustness audit, NEVER a preregistered selection.

Reads exactly both previously obtained immutable v24 real-day outputs; verifies
their original saved SHA256 and exhaustive 58×2×8 data. This is exploratory
sensitivity to one/two best observations, NOT statistical significance and NOT
a method for choosing a trading horizon. No network, orders or PAPER.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path
import json

from algorithm_independent_days_v24 import DAYS,CANDIDATES,config_sha,SCHEMA
from algorithm_temporal_response_v23 import HORIZONS
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

AUDIT_SCHEMA="algorithm_replication_postresult_robustness_v24"
FROZEN_RESULT_SHA={
    "2026-09-03":"056aaca7417863f76b9445d692a82ae971f1f0f647c47f999d40173d000049e2",
    "2026-09-04":"d66eb33ebd6e76f9fe407ba91d2bd5a41a61f94b735018125abedac9b1fa2fe5",
}


def source_result_path(root,day):
    if day not in DAYS:
        raise ValueError("Not a frozen v24 replicated historical day")
    return Path(root)/f"NEAR-{day}"/f"NEAR-{day}-frozen-v23-replication-v24.json"


def mean(vals):
    return sum(vals,Decimal(0))/Decimal(len(vals)) if vals else None


def decimal_str(value):
    return None if value is None else str(value)


def diagnosis(values,directions):
    if not values:
        return {"observations":0,"mean_net5_bps":None}
    s=sorted(values)
    n=len(s)
    if len(directions)!=n or not all(x in (-1,1) for x in directions):
        raise ValueError("Unrecognized predeclared long/short direction")
    median=(s[(n-1)//2]+s[n//2])/Decimal(2)
    return {
        "observations":n,
        "long_count":sum(d==1 for d in directions),
        "short_count":sum(d==-1 for d in directions),
        "positive_net5_count":sum(v>0 for v in values),
        "mean_net5_bps":str(mean(values)),
        "median_net5_bps":str(median),
        "best_single_net5_bps":str(s[-1]),
        "worst_single_net5_bps":str(s[0]),
        "mean_excluding_one_best_bps":decimal_str(mean(s[:-1])),
        "mean_excluding_two_best_bps":decimal_str(mean(s[:-2])),
        "post_hoc_trim_is_not_a_registered_strategy":True,
    }


def load_and_verify(root,day):
    path=source_result_path(root,day)
    raw=path.read_bytes()
    if sha256(raw)!=FROZEN_RESULT_SHA[day]:
        raise ValueError("Source result changed after original v24 evaluation")
    r=strictly_decode(raw)
    if (r.get("schema")!=SCHEMA or r.get("day_utc")!=day
        or r.get("symbol")!="NEAR-USDT-SWAP"
        or r.get("configuration_sha256")!=config_sha(day)
        or r.get("counts_toward_validated_alpha") is not False
        or r.get("can_trade") is not False
        or r.get("targets_available")!=414):
        raise ValueError("Unverified or post-hoc modified v24 input")
    rows=r["anchor_candidate_horizon_rows"]
    if len(rows)!=58*len(CANDIDATES)*len(HORIZONS):
        raise ValueError("Incomplete anchor-candidate-horizon source report")
    for candidate in CANDIDATES:
        for horizon in HORIZONS:
            matching=[x for x in rows if x["candidate"]==candidate and x["horizon_s"]==horizon]
            if len(matching)!=58 or len({x["anchor_exchange_utc_ms"] for x in matching})!=58:
                raise ValueError("Unregistered/missing/duplicate source anchors")
            sigs={x["signal"]["status"] for x in matching}
            if not sigs.issubset({"ELIGIBLE","ABSTAIN_THRESHOLD","ABSTAIN_NO_ANCHOR_BOOK",
                                  "ABSTAIN_MISSING_PRESIGNAL_BOOK"}):
                raise ValueError("Unexpected lookahead/updated source signal")
    return r


def build(root):
    days={}
    all_values={}
    all_directions={}
    for day in DAYS:
        src=load_and_verify(root,day)
        rows=src["anchor_candidate_horizon_rows"]
        day_record={
            "source_result_sha256":FROZEN_RESULT_SHA[day],
            "source_archive_sha256":src["original_archive_sha256"],
            "events_replayed":src["events_replayed"],
            "predeclared_quote_targets_available":src["targets_available"],
            "candidate_horizon_posthoc_sensitivity":[],
        }
        for candidate in CANDIDATES:
            for horizon in HORIZONS:
                matching=[x for x in rows if x["candidate"]==candidate and x["horizon_s"]==horizon]
                eligible=[x for x in matching if x["signal"]["status"]=="ELIGIBLE"]
                valid=[x for x in eligible if x["outcome"]["status"]=="EVALUATED_HISTORICAL_QUOTE_PROXY"]
                vals=[Decimal(x["outcome"]["net_fee5_each_side_bps"]) for x in valid]
                directions=[x["signal"]["direction"] for x in valid]
                label=(candidate,horizon)
                all_values.setdefault(label,[]).extend(vals)
                all_directions.setdefault(label,[]).extend(directions)
                entry={
                    "candidate":candidate,"horizon_seconds":horizon,
                    "eligible":len(eligible),"scored":len(valid),
                    "missing":len(eligible)-len(valid),
                    "posthoc_sensitivity":diagnosis(vals,directions),
                }
                day_record["candidate_horizon_posthoc_sensitivity"].append(entry)
        days[day]=day_record
    pooled=[
        {
            "candidate":candidate,
            "horizon_seconds":horizon,
            "days":len(DAYS),
            "descriptive_signal_weighted_posthoc_sensitivity":
                diagnosis(all_values[(candidate,horizon)],
                          all_directions[(candidate,horizon)]),
            "overlapping_horizons_and_adjacent_days_not_independent_samples":True,
        }
        for candidate in CANDIDATES for horizon in HORIZONS
    ]
    return {
        "schema":AUDIT_SCHEMA,
        "status":"POSTRESULT_DESCRIPTIVE_SENSITIVITY_ONLY_NO_ALPHA",
        "original_historical_development_date_utc":"2026-09-02",
        "v24_replication_days":list(DAYS),
        "source_observations_per_day":58,
        "candidate_hypotheses":list(CANDIDATES),
        "all_fixed_horizons_seconds":list(HORIZONS),
        "input_day_integrity":days,
        "descriptive_pooled_across_adjacent_days":pooled,
        "single_best_removal_is_post_hoc_diagnostic_not_predictive_model":True,
        "multiple_comparisons_not_adjusted_for_significance":True,
        "real_execution_funding_slippage_not_established":True,
        "independently_venue_signed_original_data":False,
        "archived_book_gaplessness_proven":False,
        "all_results_are_historical_quote_proxies":True,
        "may_choose_a_profitable_horizon_for_trading":False,
        "true_prospective_signal_validation":False,
        "counts_toward_validated_alpha":False,
        "can_trade":False,
        "can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Immutable historical robustness report exists")
    result=build(a.root)
    with a.out.open("xb") as f:
        f.write(canonical(result)+b"\n")
    print(json.dumps({
        "status":result["status"],
        "days":result["v24_replication_days"],
        "source_checksums":[x["source_result_sha256"] for x in result["input_day_integrity"].values()],
        "shock_60min":[
            {
                "day":day,
                "sensitivity":next(r for r in result["input_day_integrity"][day]["candidate_horizon_posthoc_sensitivity"]
                    if r["candidate"]=="pressure_shock_without_mid_adaptation" and r["horizon_seconds"]==3600)["posthoc_sensitivity"]
            } for day in DAYS
        ],
        "output_sha256":sha256(a.out.read_bytes()),
        "can_trade":False,"validated_alpha":False
    },sort_keys=True,ensure_ascii=False))


if __name__=="__main__":
    main()
