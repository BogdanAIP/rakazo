#!/usr/bin/env python3
"""v29 independent cached original NEAR L2 as-of book diagnostic at actual onsets.

No new downloads or model retuning. Quote at each target is computed BEFORE
the first exchange event timestamp after that target is applied; that future
event only supplies a <=5s bracket, never its prices or quantities. Original
v24 SHA audit/checkpoint chain and 1.5MB v29 onset result SHA are mandatory.
"""
from __future__ import annotations
import argparse
from decimal import Decimal as D
from datetime import datetime,timezone
import json
from pathlib import Path

import algorithm_independent_days_v24 as v24
import algorithm_temporal_response_v23 as v23
from algorithm_historical_l2_v16 import unpack_event
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_onset_l2_original_corrob_v29"
ORIGINAL_ONSET_SHA="f9e867360169fc71c17fe94c3aa4649846f98584af6617db71da18c6fc853d86"
MAX_REPLAY_EVENTS_PER_EVENT=160000


def asof_original(book,heaps,asof,target,next_exchange_event):
    q=v23.valid_asof_quote(book,heaps,asof,target,next_exchange_event)
    if q.get("status")!="AVAILABLE":
        return q
    b=sorted(book["bids"],reverse=True)[:5]
    a=sorted(book["asks"])[:5]
    bsum=sum((book["bids"][p] for p in b),D(0))
    asum=sum((book["asks"][p] for p in a),D(0))
    if not bsum>0 or not asum>0:
        raise ValueError("Invalid original level2 displayed depth at event")
    mid=(D(q["bid"])+D(q["ask"]))/D(2)
    return {
        **q,
        "original_top5_bid_depth":str(bsum),
        "original_top5_ask_depth":str(asum),
        "original_top5_imbalance":str((bsum-asum)/(bsum+asum)),
        "original_top1_imbalance":str((D(q["bid_size"])-D(q["ask_size"]))/(D(q["bid_size"])+D(q["ask_size"]))),
        "midquote":str(mid),
        "displayed_depth_is_not_executed_volume_or_order_intent":True,
    }


def replay_one_event(source_folder,spool,valid_checkpoint_files,event):
    t=event["decision_ms"]
    targets=(t-60000,t)
    prior=None
    prior_idx=0
    # The original checkpoint SHA chain is verified in caller before reading.
    for i,p in enumerate(valid_checkpoint_files,1):
        record=strictly_decode(p.read_bytes())
        state=record["state"]
        when=state["last_exchange_ts_ms"]
        if when is not None and when<targets[0]:
            prior=record;prior_idx=i
        elif when is not None and when>=targets[0]:
            break
    state=v23.new_state() if prior is None else prior["state"]
    start_offset=state["offset_bytes"]
    state["quotes"]={}
    state["next_target_index"]=0
    state["done"]=False
    state["source_eof"]=False
    book,heaps=v23.heaps_from_book(state)
    quote_diagnostics={}
    count=0
    with Path(spool).open("rb") as source:
        source.seek(start_offset)
        while not state["done"]:
            line=source.readline(v24.MAX_LINE_BYTES+1)
            if not line or len(line)>v24.MAX_LINE_BYTES:
                raise ValueError("Missing original L2 source row / row exceeds original cap")
            exchange_ts=unpack_event(line)[0]
            if exchange_ts>=v24.day_ms("2026-09-05"):
                raise ValueError("Never open original reserved Sep05 source")
            j=state["next_target_index"]
            while j<len(targets) and exchange_ts>targets[j]:
                qt=targets[j]
                quote_diagnostics[str(qt)]=asof_original(
                    book,heaps,state["last_book_asof_ms"],qt,exchange_ts
                )
                j+=1
            v23.apply_one(state,book,heaps,line,targets)
            count+=1
            if count>MAX_REPLAY_EVENTS_PER_EVENT:
                raise ValueError("Unbounded original book replay not allowed")
    if len(quote_diagnostics)!=2:
        raise ValueError("Missing original L2 asof book targets")
    if any(state["quotes"].get(str(t)) is None for t in targets):
        raise ValueError("Built-in v23 independently missing target quote")
    for target in targets:
        orig=state["quotes"][str(target)]
        augmented=quote_diagnostics[str(target)]
        if orig.get("status")!=augmented.get("status"):
            raise ValueError("Independent v23 asof state diverged from augmented level5 replay")
        if orig.get("status")=="AVAILABLE":
            for key in ("bid","ask","bid_size","ask_size","last_asof_exchange_utc_ms","book_asof_age_ms"):
                if orig[key]!=augmented[key]:
                    raise ValueError("Original asof quote diverges from level5 replay")
    p=quote_diagnostics[str(targets[0])]
    q=quote_diagnostics[str(targets[1])]
    both=(p["status"]=="AVAILABLE" and q["status"]=="AVAILABLE")
    midmove=(D(10000)*(D(q["midquote"])/D(p["midquote"])-1)) if both else None
    di=(D(q["original_top5_imbalance"])-D(p["original_top5_imbalance"])) if both else None
    return {
        "event_id":event["id"],
        "decision_utc":event["decision_utc"],
        "flow_direction":event["direction"],
        "onset_group_based_only_on_past_taker_flow_and_completed_1min_close":event["onset_kind"],
        "source_start_checkpoint_index":prior_idx,
        "source_start_checkpoint_sha256":prior["checkpoint_sha256"] if prior else "ORIGINAL_SOURCE_START",
        "original_L2_rows_replayed_for_two_asof_targets":count,
        "original_tminus60s_book":p,
        "original_at_decision_book":q,
        "both_strict_asof_quotes_available":both,
        "source_L2_original_mid_change_last60s_bps":str(midmove) if midmove is not None else None,
        "source_L2_original_top5_imbalance_change_last60s":str(di) if di is not None else None,
        "L2_quote_observations_are_not_execution_or_individual_order_IDs":True,
        "no_entry_price_or_trade_FILLS_implied":True,
    }


def audit(root,onset_result,day):
    if day not in ("2026-09-03","2026-09-04"):
        raise ValueError("Unregistered/holdout market day")
    raw=Path(onset_result).read_bytes()
    if sha256(raw)!=ORIGINAL_ONSET_SHA:
        raise ValueError("Original all-minute onset study changed after outcomes")
    # The immutable 934-decision result is ~1.58MB; default v12 bound is 1MB.
    # Keep strict duplicate/nonfinite rejection and cap at exactly 2MiB.
    result=strictly_decode(raw,max_bytes=2*1024*1024)
    if (result.get("schema")!="algorithm_onset_first_passage_v29"
        or len(result.get("all_934_precommitted_decision_minutes_including_abstains",[]))!=934
        or result.get("sep05_frozen_holdout_untouched") is not True):
        raise ValueError("Incomplete original v29 minute cohort")
    original_folder=Path(root)/"official-l2-v24"/f"NEAR-{day}"
    spool,metadata,source_receipt=v24.spool_evidence(original_folder,day,rehash=True)
    n,last,state,folder=v24.checkpoints(original_folder,day)
    valid_files=[folder/f"checkpoint-{i:06d}.json" for i in range(1,n+1)]
    cases=[x for x in result["all_selected_onsets"] if x["day"]==day]
    if not cases:raise ValueError("Expected real onset cases on requested day")
    records=[]
    for e in cases:
        records.append(replay_one_event(original_folder,spool,valid_files,e))
    return {
        "schema":SCHEMA,
        "study_day_utc":day,
        "status":"REAL_SOURCE_400LEVEL_BOOK_CHECKPOINT_REPLAY_ON_15_ONSET_EVENTS",
        "prior_onset_original_SHA256":ORIGINAL_ONSET_SHA,
        "original_L2_gzip_SHA256":source_receipt["original_sha256"],
        "original_decompressed_L2_SHA256":metadata["uncompressed_sha256"],
        "v24_original_checkpoint_chain_validated":True,
        "replayed_event_count":len(records),
        "strict_book_quotes_at_both_targets":sum(x["both_strict_asof_quotes_available"] for x in records),
        "events":records,
        "source_events_cannot_prove_order_actor_spoofing_or_cancellation_intent":True,
        "no_prospective_or_independent_alpha_validation":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--original-research-root",required=True,type=Path)
    p.add_argument("--original-v29-onset",required=True,type=Path)
    p.add_argument("--day",required=True,choices=("2026-09-03","2026-09-04"))
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Immutable original L2 corroboration result exists")
    output=audit(a.original_research_root,a.original_v29_onset,a.day)
    with a.out.open("xb") as f:f.write(canonical(output)+b"\n")
    print(json.dumps({
        "status":output["status"],"day":a.day,
        "events":output["replayed_event_count"],
        "strict_quotes":output["strict_book_quotes_at_both_targets"],
        "event_summaries":[{
            "id":x["event_id"],"onset_kind":x["onset_group_based_only_on_past_taker_flow_and_completed_1min_close"],
            "strict_L2":x["both_strict_asof_quotes_available"],
            "L2_mid60_bps":x["source_L2_original_mid_change_last60s_bps"],
            "L2_top5_dimbalance":x["source_L2_original_top5_imbalance_change_last60s"],
        } for x in output["events"]],
        "output_SHA256":sha256(a.out.read_bytes()),"can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
