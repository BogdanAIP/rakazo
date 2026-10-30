#!/usr/bin/env python3
"""Algorithm Discovery v13: manual-start, bounded, crash-resumable SOURCE-ONLY runner.

One foreground invocation can process at most five preassigned public WS
sources (default ONE); it exits. No daemon, scheduler, autotrade, accounts,
login, paid API, or forward outcome queries.

This is NOT a self-running LLM. Candidate generation is a bounded,
deterministic symbolic grammar; evaluation cannot claim alpha until authentic
future outcome evidence and a separate frozen model specification exist.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time

from algorithm_multiday_registry_v12 import (
    canonical, sha256, strictly_decode, study_plan, read_entries,
    make_report, register, utc_day, GENESIS,
)
from algorithm_ws_capture_v8 import collect, save_capture

SCHEMA="algorithm_manual_runner_v13"
SESSION_SCHEMA="algorithm_manual_session_v13"
CATALOG_SCHEMA="algorithm_symbolic_candidate_catalog_v13"
MAX_CAPTURES_PER_LAUNCH=5
MAX_BUDGET_SECONDS=120
LEGACY_FAMILIES=["v6_oi_funding","v7_static_book_vs_last100",
                 "v9_quote_readd_reversal","v10_opposing_depth_depletion"]
UNVERIFIED_LABEL="NO_AUTHENTIC_FORWARD_PRICE_LABELS"
FLOW_EXPRESSIONS={
    "net_taker_contracts":"buy_contracts_8s - sell_contracts_8s",
    "halftime_flow_asymmetry":"(buy0_3 - sell0_3) - (buy4_7 - sell4_7)",
}
QUOTE_EXPRESSIONS={
    "quote_response_imbalance":
      "(bid_added - bid_reduced) - (ask_added - ask_reduced)",
    "asymmetric_readdition":
      "bid_readded_price_events - ask_readded_price_events",
    "depletion_recovery_spread":
      "(bid_added + ask_added) - (bid_reduced + ask_reduced)",
}
COMBINERS={
    "coupled_sign":"sign(flow) * sign(quote_response)",
    "saturation_contrast":"sign(flow) * sign(quote_response) * abs(flow)/(1+abs(flow))",
}


def utc_now():
    return time.time_ns()//1_000_000


def catalog():
    proposals=[]
    for f,ff in FLOW_EXPRESSIONS.items():
        for q,qq in QUOTE_EXPRESSIONS.items():
            for combiner,formula in COMBINERS.items():
                key=f"{f}__{q}__{combiner}"
                proposals.append({
                    "id":sha256(key.encode("utf-8"))[:16],
                    "feature_key":key,
                    "source_flow_expression":ff,
                    "source_quote_expression":qq,
                    "composition":formula,
                    "input_data":"verified_current_8s_public_WS_only",
                    "feature_time":"complete_receive_end_of_8s_window",
                    "observation_count":0,
                    "predictive_direction":None,
                    "forward_horizon_ms":None,
                    "status":"UNTESTED_HYPOTHESIS_PROPOSAL",
                    "scientific_originality_verified":False,
                    "profitability_validated":False,
                })
    return {
        "schema":CATALOG_SCHEMA,
        "generator":"bounded_symbolic_grammar_deterministic_v13",
        "proposals":proposals,
        "prior_families_excluded_from_reuse":LEGACY_FAMILIES,
        "is_self_training_llm":False,
        "future_price_outcomes_inspected":False,
        "automatic_selection_on_holdout":False,
        "not_a_frozen_trading_model":True,
        "can_trade":False,"can_start_paper":False,
    }


def catalog_bytes():
    return canonical(catalog())+b"\n"


def read_catalog(study):
    p=Path(study)/"manual-runner-v13"/"hypothesis-catalog.json"
    raw=p.read_bytes()
    if raw!=catalog_bytes():
        raise ValueError("Hypothesis catalog tampered with, or source code changed")
    return sha256(raw)


def setup(study):
    # Read the existing plan only; never mutate the frozen 12-day study.
    plan,plan_sha=study_plan(study)
    root=Path(study)/"manual-runner-v13"
    root.mkdir(exist_ok=True)
    (root/"sessions").mkdir(exist_ok=True)
    p=root/"hypothesis-catalog.json"
    if not p.exists():
        with p.open("xb") as stream:
            stream.write(catalog_bytes())
    cat_sha=read_catalog(study)
    return plan,plan_sha,cat_sha


def verify_sessions(study,plan_sha,cat_sha):
    root=Path(study)/"manual-runner-v13"/"sessions"
    entries=sorted(root.glob("*.json"))
    prev=GENESIS
    out=[]
    for n,file in enumerate(entries,1):
        if file.name!=f"{n:06d}.json":
            raise ValueError("Session event numbering gap or unexpected file")
        obj=strictly_decode(file.read_bytes())
        head={key:obj[key] for key in (
            "schema","sequence","previous_sha256","plan_sha256",
            "catalog_sha256","session")}
        digest=sha256(canonical(head))
        if (obj["schema"]!=SESSION_SCHEMA or obj["sequence"]!=n
            or obj["previous_sha256"]!=prev
            or obj["plan_sha256"]!=plan_sha
            or obj["catalog_sha256"]!=cat_sha
            or obj.get("entry_sha256")!=digest):
            raise ValueError("Broken manual-run session hash chain")
        event=obj["session"]
        if (event.get("can_trade") is not False
            or event.get("can_start_paper") is not False
            or event.get("forward_labels_scored") is not False):
            raise ValueError("Unexpected action or impossible outcome claim")
        prev=digest
        out.append(obj)
    return out


def append_session(study,plan_sha,cat_sha,payload):
    prior=verify_sessions(study,plan_sha,cat_sha)
    seq=len(prior)+1
    head={"schema":SESSION_SCHEMA,"sequence":seq,
          "previous_sha256":prior[-1]["entry_sha256"] if prior else GENESIS,
          "plan_sha256":plan_sha,"catalog_sha256":cat_sha,
          "session":payload}
    entry={**head,"entry_sha256":sha256(canonical(head))}
    path=Path(study)/"manual-runner-v13"/"sessions"/f"{seq:06d}.json"
    with path.open("xb") as f:
        f.write(canonical(entry)+b"\n")
    verify_sessions(study,plan_sha,cat_sha)
    return entry["entry_sha256"]


def status(study,now=None):
    now=utc_now() if now is None else now
    plan,psha,csha=setup(study)
    sessions=verify_sessions(study,psha,csha)
    report=make_report(study,now)
    history=read_entries(study,plan,recheck_source=True)
    counted={(x["observation"]["date_utc"],x["observation"]["symbol"]):x["observation"]
             for x in history}
    day=utc_day(now)
    current=next((d for d in plan["calendar"] if d["date_utc"]==day),None)
    remaining=[s for s in current["symbols"]
               if (day,s) not in counted] if current else []
    future_days=[x["date_utc"] for x in plan["calendar"] if x["date_utc"]>day]
    next_scheduled=day if remaining else (future_days[0] if future_days else None)
    unsealed = report["holdout_sealed_model"] is False
    if not current and next_scheduled:
        state="WAIT_FOR_NEXT_ASSIGNED_UTC_DAY"
    elif current and remaining:
        state="READY_MANUAL_SOURCE_CAPTURE_ONLY"
    elif current:
        state="TODAY_COMPLETED_OR_FAILED_AS_RECORDED"
    else:
        state="PLAN_ENDED_NO_AUTOMATIC_EXTENSION"
    return {
        "schema":SCHEMA,"asof_utc_ms":now,"utc_day":day,
        "plan_sha256":psha,"catalog_sha256":csha,
        "candidate_proposals_not_evaluated":len(catalog()["proposals"]),
        "source_records_verified":report["source_verified_count"],
        "source_records_failed":report["explicit_failed_count"],
        "source_records_unregistered":report["source_unregistered_count"],
        "future_price_labels_verified":0,
        "model_sealed_before_validation":not unsealed,
        "automatic_trading_allowed":False,
        "next_scheduled_utc_day":next_scheduled,
        "next_assigned_symbol":remaining[0] if remaining else None,
        "manual_runner_status":state,
        "manual_sessions_completed":len(sessions),
        "no_daemon":True,"no_order_api":True,
        "can_trade":False,"can_start_paper":False,
    }


def source_path(study,day,symbol):
    if not symbol.endswith("-USDT-SWAP"):
        raise ValueError("Not a registered swap")
    base=symbol[:-len("-USDT-SWAP")]
    return Path(study).parent/f"ws-v12-{day}-{base}"


async def capture_one(symbol):
    # Public WebSocket source collection: bounded 8s observation, no login.
    return await collect(symbol)


def execute_one(study,day,symbol,now_fn,source_capture):
    """Recover original source folder if already created; never repeat receipt."""
    folder=source_path(study,day,symbol)
    if folder.exists():
        # If a prior invocation died AFTER raw capture but BEFORE registry
        # append, verify and register those EXACT bytes. Never recapture.
        operation="RESUME_EXISTING_RAW_CAPTURE"
    else:
        operation="NEW_BOUNDED_PUBLIC_SOURCE_CAPTURE"
        try:
            manifest,messages=source_capture(symbol)
            save_capture(folder,manifest,messages)
        except Exception as exc:
            # Missing capture counts against the preassigned one/day attempt:
            # no automatic retries, chasing better sources, or API fallback.
            reason=f"Manual bounded source failed: {type(exc).__name__}: {str(exc)[:120]}"
            digest=register(study,day,symbol,reason=reason,now=now_fn())
            return {"symbol":symbol,"capture_status":"SOURCE_FAILED_NOT_RETRIED",
                    "entry_sha256":digest,"source_path":str(folder),"reason":reason}
    try:
        digest=register(study,day,symbol,source=folder,now=now_fn())
        return {"symbol":symbol,"capture_status":"SOURCE_REPLAY_VERIFIED_NO_OUTCOME",
                "entry_sha256":digest,"source_path":str(folder),
                "operation":operation}
    except Exception as exc:
        # Original messages remain in folder untouched; register failed
        # integrity once, without any private endpoint or source replacement.
        reason=f"Original public source audit failed: {type(exc).__name__}: {str(exc)[:120]}"
        digest=register(study,day,symbol,reason=reason,now=now_fn())
        return {"symbol":symbol,"capture_status":"SOURCE_INVALID_NOT_RETRIED",
                "entry_sha256":digest,"source_path":str(folder),"reason":reason}


def manual_run(study,*,max_captures=1,now_fn=utc_now,capture_fn=None):
    """Finite foreground cycle; never call repeatedly without user action."""
    if type(max_captures) is not int or not 0<=max_captures<=MAX_CAPTURES_PER_LAUNCH:
        raise ValueError("max_captures must be 0..5 (default 1)")
    before=status(study,now_fn())
    plan,plan_sha,cat_sha=setup(study)
    start=now_fn()
    initial_day=utc_day(start)
    observations=[]
    if capture_fn is None:
        def capture_fn(symbol):
            return asyncio.run(capture_one(symbol))
    for _ in range(max_captures):
        # Refuse to cross into a different UTC day mid-session.
        current=status(study,now_fn())
        if (current["utc_day"]!=initial_day or
            current["manual_runner_status"]!="READY_MANUAL_SOURCE_CAPTURE_ONLY"):
            break
        symbol=current["next_assigned_symbol"]
        observations.append(execute_one(study,initial_day,symbol,now_fn,capture_fn))
    after=status(study,now_fn())
    result={
        "started_utc_ms":start,"finished_utc_ms":now_fn(),
        "day_utc":initial_day,
        "before":before["manual_runner_status"],
        "after":after["manual_runner_status"],
        "source_attempts":observations,
        "source_attempt_count":len(observations),
        "next_assigned_symbol":after["next_assigned_symbol"],
        "future_labels_inspected":False,
        "candidate_catalog_only_no_model_selected":True,
        "proposed_hypotheses":after["candidate_proposals_not_evaluated"],
        "can_trade":False,"can_start_paper":False,
        "forward_labels_scored":False,
    }
    digest=append_session(study,plan_sha,cat_sha,result)
    return {"session_sha256":digest,**result}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",type=Path,required=True)
    p.add_argument("action",choices=["status","run"])
    p.add_argument("--max-captures",type=int,default=1)
    args=p.parse_args()
    output=(status(args.study) if args.action=="status" else
            manual_run(args.study,max_captures=args.max_captures))
    print(json.dumps(output,ensure_ascii=False,sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
