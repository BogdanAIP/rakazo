#!/usr/bin/env python3
"""v15 fail-closed scientific readiness audit, NOT a strategy evaluator.

Counts UNIQUE preassigned market-day observations, not duplicated candidate
signals. Does not request market data, fabricate labels, read future prices,
retune hypotheses, or call any trade/order APIs.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
import json
from pathlib import Path

from algorithm_multiday_registry_v12 import (
    study_plan, read_entries, make_report, sha256, canonical
)
from algorithm_ai_research_v14 import registered, overview

SCHEMA="algorithm_multihypothesis_readiness_v15"
MIN_EVENTS_FOR_DISCUSSION=100
MIN_MARKETS_FOR_DISCUSSION=20
MIN_DAYS_FOR_DISCUSSION=10
MIN_INDEPENDENT_BLOCKS=30
FAMILY_ERROR_TARGET=Decimal("0.05")


def audit(study):
    study=Path(study)
    plan,plan_sha=study_plan(study)
    hypotheses=registered(study)
    current=make_report(study)
    signals=overview(study)
    days=plan["calendar"]
    split_capacity={
        k:sum(len(d["symbols"]) for d in days if d["split"]==k)
        for k in ("development","validation","holdout")
    }
    total_slots=sum(split_capacity.values())
    recorded=read_entries(study,plan,recheck_source=True)
    distinct={(o["observation"]["date_utc"],o["observation"]["symbol"])
              for o in recorded
              if o["observation"]["status"]=="SOURCE_VERIFIED_NO_OUTCOME"}
    n=len(hypotheses)
    if total_slots!=60 or len(days)!=12:
        raise ValueError("Unexpected original v12 immutable 12-day plan")
    if n!=len(set(p["rule_id"] for _,p in hypotheses)):
        raise ValueError("Non-independent duplicate signal-rule registration")
    alpha=str(FAMILY_ERROR_TARGET/Decimal(n)) if n else None
    candidate_table=[{
        "candidate_id":p["id"],
        "rule_id":p["rule_id"],
        "registered_utc_ms":record["registered_utc_ms"],
        "horizon_ms":p["forward_horizon_ms"],
        "economic_validation":"NOT_STARTED",
        "future_label_count":0,
        "scientific_originality":"NOT_VERIFIED",
    } for record,p in hypotheses]
    return {
        "schema":SCHEMA,
        "v12_plan_sha256":plan_sha,
        "hypotheses_registered":n,
        "candidate_precommitments":candidate_table,
        "unique_market_day_source_slots":total_slots,
        "development_max_one_event_per_slot":split_capacity["development"],
        "validation_max_one_event_per_slot":split_capacity["validation"],
        "holdout_max_one_event_per_slot":split_capacity["holdout"],
        "all_days_max_one_event_per_slot":total_slots,
        "required_qualified_events_for_generalization":MIN_EVENTS_FOR_DISCUSSION,
        "can_reach_required_qualified_event_count_with_this_plan":
            total_slots>=MIN_EVENTS_FOR_DISCUSSION,
        "repeated_predictions_per_slot_are_independent_events":False,
        "qualified_observation_count":None,
        "qualifying_signal_count_not_yet_independently_audited":True,
        "verified_source_receipts_so_far":len(distinct),
        "unverified_future_labels_so_far":current["future_outcome_labels_verified"],
        "unverified_future_labels_must_not_be_scored":True,
        "future_outcome_source_authenticated":False,
        "out_of_sample_candidate_signals_implemented":False,
        "model_sealed_before_validation":current["holdout_sealed_model"],
        "min_days_for_generalization":MIN_DAYS_FOR_DISCUSSION,
        "min_markets_for_generalization":MIN_MARKETS_FOR_DISCUSSION,
        "min_independent_blocks":MIN_INDEPENDENT_BLOCKS,
        "multiple_testing_note":
            "Descriptive only until authenticated forward labels, a SINGLE "
            "model freeze, dependence-aware day-block uncertainty and proper "
            "familywise testing; do not select the best of the candidates.",
        "exploratory_bonferroni_alpha_per_registered_candidate":
            alpha,
        "bonferroni_is_not_a_substitute_for_independent_evidence":True,
        "status":"PILOT_DESIGN_SOURCE_ONLY_NO_ALPHA_VALIDATION",
        "cannot_claim_positive_backtest_or_trade":True,
        "can_trade":False,
        "can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",required=True,type=Path)
    p.add_argument("--out",type=Path)
    args=p.parse_args()
    data=audit(args.study)
    if args.out:
        with args.out.open("xb") as f:
            f.write(canonical(data)+b"\n")
    print(json.dumps({
        "status":data["status"],
        "registered_hypotheses":data["hypotheses_registered"],
        "possible_events_max":data["all_days_max_one_event_per_slot"],
        "requirement":data["required_qualified_events_for_generalization"],
        "can_reach_requirement":data["can_reach_required_qualified_event_count_with_this_plan"],
        "received_source_count":data["verified_source_receipts_so_far"],
        "future_labels_authenticated":False,
        "alpha_per_family_member":data["exploratory_bonferroni_alpha_per_registered_candidate"],
        "can_trade":False
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
