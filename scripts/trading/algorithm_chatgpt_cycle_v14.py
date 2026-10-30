#!/usr/bin/env python3
"""v14 ChatGPT/Rakazo one-command FOREGROUND research cycle.

Delegates to v13 manual finite source capture, then runs only already
registered AI source-only proposal rules. Does not call an external LLM API
and does not fetch future quotes, publish PnL, or touch trading accounts.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

from algorithm_manual_runner_v13 import manual_run
from algorithm_ai_research_v14 import registered, signal, overview, paths, setup
from algorithm_multiday_registry_v12 import read_entries, study_plan


def run_cycle(study,max_captures=1,*,runner=manual_run,signaler=signal):
    if type(max_captures) is not int or not 0<=max_captures<=5:
        raise ValueError("Foreground capture limit 0..5")
    study=Path(study)
    # A single user-initiated command, not a daemon or unattended recurring
    # agent. This may be called again next session.
    capture=runner(study,max_captures=max_captures)
    study_plan(study)
    proposals=registered(study)
    plan,_=study_plan(study)
    records=read_entries(study,plan,recheck_source=True)
    _,_,_,signal_root=paths(study)
    performed=[]
    skipped=[]
    for row in records:
        o=row["observation"]
        day,symbol=o["date_utc"],o["symbol"]
        part=next((b["split"] for b in plan["calendar"] if b["date_utc"]==day),None)
        if part!="development" or o["status"]!="SOURCE_VERIFIED_NO_OUTCOME":
            continue
        for header,p in proposals:
            if header["registered_utc_ms"]>=o["capture_start_utc_ms"]:
                # Never learn from a record captured before hypothesis freeze.
                skipped.append({"symbol":symbol,"day":day,
                                "proposal_id":p["id"],"reason":"HYPOTHESIS_AFTER_SOURCE"})
                continue
            name=f"{day}-{symbol}-{p['id']}.json"
            if (signal_root/name).exists():
                # Existing source-only signal is never overwritten.
                continue
            performed.append(signaler(study,p["id"],day,symbol))
    state=overview(study)
    return {
        "schema":"algorithm_chatgpt_foreground_cycle_v14",
        "capture_session":capture,
        "new_source_only_signals":performed,
        "skipped_prior_source_hypotheses":skipped,
        "research_state":state,
        "actual_market_outcomes_scored":False,
        "no_external_llm_service_or_paid_api":True,
        "no_daemon_or_scheduler":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",required=True,type=Path)
    p.add_argument("--max-captures",default=1,type=int)
    args=p.parse_args()
    print(json.dumps(run_cycle(args.study,args.max_captures),
                     ensure_ascii=False,sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
