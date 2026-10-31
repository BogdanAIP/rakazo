#!/usr/bin/env python3
"""v23 research-only fixed temporal-response explorer of official OKX L2 archive.

NO order placement, live exchange API, news, PAPER, account or automated tasks.
Historical DEVELOPMENT analysis only: NEVER claim profitable/prospective alpha.
One real archived day; two predeclared book features; eight fixed horizons.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
from decimal import Decimal
import heapq
import json
from pathlib import Path
import statistics
import time

from algorithm_historical_l2_v16 import decimal,unpack_event,scenario
from algorithm_l2_checkpoint_v22 import (
    spool_evidence,apply_levels,heaps_from_book,current_best,SPOOL_FILE
)
from algorithm_historical_l2_official_v22 import SYMBOL,DATE,MAX_LINE_BYTES
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode,GENESIS

SCHEMA="algorithm_temporal_response_v23"
CP_SCHEMA="algorithm_temporal_response_checkpoint_v23"
STATUS="EXPLORATORY_ONE_ARCHIVE_DAY_NO_VALIDATED_ALPHA"
HORIZONS=(10,30,60,120,300,900,1800,3600)
ANCHOR_MINUTES=15
IMBALANCE_THRESHOLD=Decimal("0.30")
SHOCK_THRESHOLD=Decimal("0.50")
FLAT_MID_BPS=Decimal("3.0")
BASE_FEE="5bps_each_side"
STRESS_FEE="7bps_each_side"
MAX_EVENT_ROWS=3_000_000
MAX_STEP_EVENTS=100_000
MAX_STEP_SECONDS=10
MAX_STALE_MS=5000
MAX_BRACKET_MS=5000
ROOT_NAME="temporal-v23"
ONE_DAY_MS=86400000


def utc_ms(day,hour,minute=0,second=0):
    return int(datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:{second:02d}+00:00").timestamp()*1000)


def anchors():
    return tuple(
        utc_ms(DATE,h,m)
        for begin,end in ((2,9),(14,21))
        for slot in range((end-begin)*60//ANCHOR_MINUTES+1)
        for h,m in ((begin+(slot*ANCHOR_MINUTES)//60,(slot*ANCHOR_MINUTES)%60),)
    )


def targets():
    a=anchors()
    out=set()
    for t in a:
        out.add(t-30_000)
        out.add(t)
        for seconds in HORIZONS:
            out.add(t+seconds*1000)
    return tuple(sorted(out))


def new_state():
    return {
        "offset_bytes":0,
        "events_read":0,
        "last_exchange_ts_ms":None,
        "last_book_asof_ms":None,
        "full_snapshots":0,
        "seq_ids_available":None,
        "prior_seq":None,
        "next_target_index":0,
        "quotes":{},
        "book":{"bids":{},"asks":{}},
        "source_eof":False,
        "done":False,
    }


def load_checkpoints(folder):
    root=Path(folder)/ROOT_NAME
    cp=root/"checkpoints"
    cp.mkdir(parents=True,exist_ok=True)
    files=sorted(cp.glob("*.json"))
    prev=GENESIS
    state=new_state()
    for i,p in enumerate(files,1):
        if p.name!=f"checkpoint-{i:06d}.json":
            raise ValueError("Gap or duplicate in v23 checkpoint series")
        r=strictly_decode(p.read_bytes())
        if (r.get("schema")!=CP_SCHEMA or r.get("index")!=i
            or r.get("previous_sha256")!=prev
            or not isinstance(r.get("state"),dict)
            or r.get("study_configuration_sha256")!=config_sha()):
            raise ValueError("Bad linked v23 replay checkpoint")
        core={k:r[k] for k in ("schema","index","previous_sha256",
                                "study_configuration_sha256","state")}
        digest=sha256(canonical(core))
        if r.get("checkpoint_sha256")!=digest:
            raise ValueError("Modified v23 replay checkpoint")
        prev=digest
        state=r["state"]
    return len(files),prev,state,cp


def config():
    return {
        "schema":"algorithm_temporal_response_config_v23",
        "symbol":SYMBOL,"archive_date_utc":DATE,
        "anchor_utc_ms":list(anchors()),
        "anchor_step_minutes":ANCHOR_MINUTES,
        "horizons_seconds":list(HORIZONS),
        "pre_signal_feature_offsets_seconds":[-30,0],
        "max_quote_age_ms":MAX_STALE_MS,
        "max_next_event_bracket_ms":MAX_BRACKET_MS,
        "baseline_imbalance_abs_threshold":str(IMBALANCE_THRESHOLD),
        "shock_delta_imbalance_abs_threshold":str(SHOCK_THRESHOLD),
        "shock_max_abs_same_30s_mid_bps":str(FLAT_MID_BPS),
        "fee_scenarios":[BASE_FEE,STRESS_FEE],
        "scientific_split":"SINGLE_ARCHIVE_DAY_DEVELOPMENT_ONLY_NOT_INDEPENDENT_VALIDATION",
    }


def config_sha():
    return sha256(canonical(config()))


def valid_asof_quote(book,heaps,last_asof,target,next_event):
    if last_asof is None:
        return {"status":"UNAVAILABLE_NO_SNAPSHOT"}
    age=target-last_asof
    bracket_age=next_event-target
    if age<0:
        raise ValueError("Future book state used for past feature target")
    if age>MAX_STALE_MS:
        return {"status":"UNAVAILABLE_STALE_ASOF","age_ms":age}
    if not 0<bracket_age<=MAX_BRACKET_MS:
        return {"status":"UNAVAILABLE_NO_NEAR_FUTURE_BRACKET","bracket_age_ms":bracket_age}
    bid,ask=current_best(book,heaps)
    return {
        "status":"AVAILABLE",
        "target_exchange_utc_ms":target,
        "last_asof_exchange_utc_ms":last_asof,
        "first_post_target_exchange_utc_ms":next_event,
        "book_asof_age_ms":age,
        "book_bracket_delay_ms":bracket_age,
        "bid":str(bid),
        "ask":str(ask),
        "bid_size":str(book["bids"][bid]),
        "ask_size":str(book["asks"][ask]),
    }


def apply_one(state,book,heaps,line,tgt):
    ts,action,seq,prev,sides,instrument=unpack_event(line)
    if instrument!=SYMBOL:
        raise ValueError("Official source instrument does not match config")
    if (state["last_exchange_ts_ms"] is not None
        and ts<state["last_exchange_ts_ms"]):
        raise ValueError("Archive source event timestamp goes backwards")
    state["last_exchange_ts_ms"]=ts
    state["events_read"]+=1
    if state["events_read"]>MAX_EVENT_ROWS:
        raise ValueError("Source event count outside v23 resource cap")
    while (state["next_target_index"]<len(tgt)
           and ts>tgt[state["next_target_index"]]):
        target=tgt[state["next_target_index"]]
        state["quotes"][str(target)]=valid_asof_quote(
            book,heaps,state["last_book_asof_ms"],target,ts)
        state["next_target_index"]+=1
    if state["next_target_index"]==len(tgt):
        state["done"]=True
        return
    if action=="snapshot":
        state["full_snapshots"]+=1
        state["seq_ids_available"]=(seq is not None)
        state["prior_seq"]=seq
    elif state["full_snapshots"]==0:
        return
    elif state["seq_ids_available"]:
        if seq is None or prev!=state["prior_seq"] or seq<state["prior_seq"]:
            raise ValueError("Exchange book delta seq gap")
        state["prior_seq"]=seq
    elif seq is not None:
        raise ValueError("Source book suddenly added seq counters")
    apply_levels(book,heaps,sides,action)
    current_best(book,heaps) # fail closed on crossed or empty state
    state["last_book_asof_ms"]=ts


def advance(folder,*,max_events=MAX_STEP_EVENTS,max_seconds=MAX_STEP_SECONDS):
    if (type(max_events) is not int or not 1<=max_events<=MAX_STEP_EVENTS
        or type(max_seconds) is not int or not 1<=max_seconds<=MAX_STEP_SECONDS):
        raise ValueError("Manual process budget exceeded")
    spool,info=spool_evidence(folder)
    i,prev,state,cp=load_checkpoints(folder)
    if state["done"]:
        return {"status":"FIXED_MULTI_HORIZON_QUOTES_ALREADY_AVAILABLE",
                "events":state["events_read"],"checkpoint_index":i,"can_trade":False}
    book,heaps=heaps_from_book(state)
    target_set=targets()
    clock=time.monotonic()
    count=0
    with spool.open("rb") as stream:
        stream.seek(state["offset_bytes"])
        while count<max_events and time.monotonic()-clock<max_seconds:
            line=stream.readline(MAX_LINE_BYTES+1)
            if not line:
                state["source_eof"]=True
                break
            if len(line)>MAX_LINE_BYTES or not line.strip():
                raise ValueError("Malformed original official NDJSON source row")
            apply_one(state,book,heaps,line,target_set)
            state["offset_bytes"]=stream.tell()
            count+=1
            if state["done"]:
                break
    if state["source_eof"] and not state["done"]:
        for t in target_set[state["next_target_index"]:]:
            state["quotes"][str(t)]={"status":"UNAVAILABLE_NO_EVENT_AFTER_TARGET"}
        state["next_target_index"]=len(target_set)
        state["done"]=True
    state["book"]={side:{str(p):str(q) for p,q in book[side].items()}
                   for side in ("bids","asks")}
    core={"schema":CP_SCHEMA,"index":i+1,"previous_sha256":prev,
          "study_configuration_sha256":config_sha(),"state":state}
    digest=sha256(canonical(core))
    record={**core,"checkpoint_sha256":digest}
    with (cp/f"checkpoint-{i+1:06d}.json").open("xb") as out:
        out.write(canonical(record)+b"\n")
    return {
        "status":"ALL_REGISTERED_HORIZON_QUOTES_REPLAYED"
                 if state["done"] else "MULTI_HORIZON_REPLAY_IN_PROGRESS",
        "events_this_manual_chunk":count,
        "events_cumulative":state["events_read"],
        "source_byte_offset":state["offset_bytes"],
        "total_source_bytes":info["uncompressed_bytes"],
        "targets_completed":state["next_target_index"],
        "targets_total":len(target_set),
        "sha_checkpoint":digest,
        "can_trade":False,
    }


def imbalance(q):
    b=decimal(q["bid_size"],positive=True)
    a=decimal(q["ask_size"],positive=True)
    return (b-a)/(b+a)


def midpoint(q):
    return (decimal(q["bid"],positive=True)+decimal(q["ask"],positive=True))/Decimal(2)


def sign(x):
    return 1 if x>0 else -1 if x<0 else 0


def signal_at(q_prev,q_now,candidate):
    if not q_now or q_now.get("status")!="AVAILABLE":
        return {"status":"ABSTAIN_NO_ANCHOR_BOOK","direction":None}
    I=imbalance(q_now)
    if candidate=="baseline_imbalance":
        d=sign(I) if abs(I)>=IMBALANCE_THRESHOLD else 0
        return {
            "status":"ELIGIBLE" if d else "ABSTAIN_THRESHOLD",
            "direction":d or None,
            "imbalance_now":str(I),
        }
    if candidate!="pressure_shock_without_mid_adaptation":
        raise ValueError("Unregistered candidate")
    if not q_prev or q_prev.get("status")!="AVAILABLE":
        return {"status":"ABSTAIN_MISSING_PRESIGNAL_BOOK","direction":None}
    dI=I-imbalance(q_prev)
    mid_response=Decimal(10000)*(midpoint(q_now)/midpoint(q_prev)-Decimal(1))
    is_signal=abs(dI)>=SHOCK_THRESHOLD and abs(mid_response)<=FLAT_MID_BPS
    return {
        "status":"ELIGIBLE" if is_signal else "ABSTAIN_THRESHOLD",
        "direction":sign(dI) if is_signal else None,
        "imbalance_now":str(I),
        "imbalance_change_in_30s":str(dI),
        "midquote_drift_30s_bps":str(mid_response),
    }


def observation(direction,entry,exit_):
    if exit_ is None or exit_.get("status")!="AVAILABLE":
        return {"status":"MISSING_ARCHIVED_OUTCOME",
                "reason":exit_["status"] if exit_ else "NO_TARGET"}
    gross=scenario(direction,
                   decimal(entry["bid"],positive=True),
                   decimal(entry["ask"],positive=True),
                   decimal(exit_["bid"],positive=True),
                   decimal(exit_["ask"],positive=True))
    signed_mid_bps=Decimal(10000)*(
        midpoint(exit_)/midpoint(entry)-Decimal(1))*Decimal(direction)
    return {
        "status":"EVALUATED_HISTORICAL_QUOTE_PROXY",
        "signed_midquote_move_bps":str(signed_mid_bps),
        "long_or_short_direction":direction,
        "source_entry":{"bid":entry["bid"],"ask":entry["ask"]},
        "source_exit":{"bid":exit_["bid"],"ask":exit_["ask"]},
        "gross_crossing_bps":gross["gross_crossing_quote_bps"],
        "net_fee5_each_side_bps":gross["base_five_bps_per_side_proxy_net_bps"],
        "net_fee7_each_side_bps":gross["stress_seven_bps_per_side_proxy_net_bps"],
        "is_actual_fill":False,
        "is_prospective_prediction":False,
    }


def format_summary(vals):
    if not vals:
        return {"mean_bps":None,"median_bps":None}
    s=sorted(vals)
    mid=(s[(len(s)-1)//2]+s[len(s)//2])/Decimal(2)
    return {"mean_bps":str(sum(vals,Decimal(0))/Decimal(len(vals))),
            "median_bps":str(mid)}


def summarize(rows,candidate,horizon):
    one=[r for r in rows if r["candidate"]==candidate and r["horizon_s"]==horizon]
    eligible=[r for r in one if r["signal"]["status"]=="ELIGIBLE"]
    scored=[r["outcome"] for r in eligible if r["outcome"]["status"]=="EVALUATED_HISTORICAL_QUOTE_PROXY"]
    k="net_fee5_each_side_bps"
    vals=[Decimal(r[k]) for r in scored]
    return {
        "candidate":candidate,"horizon_s":horizon,
        "source_anchors_total":len(one),
        "signal_eligible_anchor_count":len(eligible),
        "signal_abstentions":len(one)-len(eligible),
        "scored_with_archived_bid_ask":len(scored),
        "missing_or_unscorable_source_outcomes":len(eligible)-len(scored),
        "mean_signed_midquote_bps":format_summary(
            [Decimal(r["signed_midquote_move_bps"]) for r in scored])["mean_bps"],
        "mean_gross_crossing_bps":format_summary(
            [Decimal(r["gross_crossing_bps"]) for r in scored])["mean_bps"],
        "fee5_scenario":format_summary(vals),
        "fee7_scenario":format_summary(
            [Decimal(r["net_fee7_each_side_bps"]) for r in scored]),
        "positive_after_fee5_count":sum(v>0 for v in vals),
        "positive_after_fee5_fraction":str(Decimal(sum(v>0 for v in vals))/Decimal(len(vals))) if vals else None,
        "confidence_independence_claim":False,
    }


def finalize(folder,outfile):
    outfile=Path(outfile)
    if outfile.exists():
        raise FileExistsError("Do not overwrite prior temporal response result")
    spool,source=spool_evidence(folder,rehash=True)
    i,digest,state,cp=load_checkpoints(folder)
    tgt=targets()
    if (not state["done"] or state["next_target_index"]!=len(tgt)
        or set(state["quotes"])!={str(t) for t in tgt}):
        raise ValueError("Cannot evaluate until ALL frozen quotes have been replayed")
    quotes=state["quotes"]
    candidates=("baseline_imbalance","pressure_shock_without_mid_adaptation")
    results=[]
    for anchor in anchors():
        p=quotes[str(anchor-30_000)]
        q=quotes[str(anchor)]
        for name in candidates:
            sig=signal_at(p,q,name)
            for horizon in HORIZONS:
                result=(
                    observation(sig["direction"],q,quotes[str(anchor+horizon*1000)])
                    if sig["status"]=="ELIGIBLE" else
                    {"status":"NOT_EVALUATED_SOURCE_ABSTAIN"}
                )
                results.append({
                    "anchor_exchange_utc_ms":anchor,
                    "candidate":name,
                    "horizon_s":horizon,
                    "signal":sig,
                    "outcome":result,
                })
    summary=[summarize(results,n,h) for n in candidates for h in HORIZONS]
    output={
        "schema":SCHEMA,
        "status":STATUS,
        "configuration":config(),
        "configuration_sha256":config_sha(),
        "archive_original_uncompressed_sha256":source["uncompressed_sha256"],
        "archive_original_tar_gz_sha256":source["source_archive_sha256"],
        "archived_data_exchange_order_complete_proven":state["seq_ids_available"] is True,
        "source_expected_gaplessness_unverified":state["seq_ids_available"] is not True,
        "source_events_replayed":state["events_read"],
        "full_source_book_snapshots_seen":state["full_snapshots"],
        "source_bytes_processed":state["offset_bytes"],
        "checkpoints_created":i,
        "latest_checkpoint_sha256":digest,
        "registered_quote_targets":len(tgt),
        "archived_quote_targets_available":sum(q["status"]=="AVAILABLE" for q in quotes.values()),
        "all_target_quote_statuses":quotes,
        "fixed_58_anchors_source_only_signal_results":results,
        "candidate_horizon_summary":summary,
        "fee_scenario_includes_spread":True,
        "actual_fill_slippage_funding_lots_account_fees_verified":False,
        "outcome_horizons_nested_nonindependent":True,
        "58_anchors_are_one_day_only_not_independent":True,
        "true_out_of_sample_test":False,
        "prospective_signal_registry_used":False,
        "counts_toward_validated_alpha":False,
        "model_may_choose_best_horizon_as_validated_strategy":False,
        "realized_pnl":None,
        "can_trade":False,"can_start_paper":False,
    }
    with outfile.open("xb") as out:
        out.write(canonical(output)+b"\n")
    return {
        "status":STATUS,
        "source_events_replayed":state["events_read"],
        "anchors":len(anchors()),
        "horizons_seconds":list(HORIZONS),
        "results_per_candidate":len(results)//2,
        "registered_quote_targets":len(tgt),
        "quotes_available":output["archived_quote_targets_available"],
        "candidate_eligible_anchor_counts": {
            n:sum(signal_at(quotes[str(t-30_000)],quotes[str(t)],n)["status"]=="ELIGIBLE"
                  for t in anchors())
            for n in candidates
        },
        "summary":summary,
        "output_sha256":sha256(outfile.read_bytes()),
        "validated_alpha":False,
        "can_trade":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--original-archive-dir",type=Path,required=True)
    sub=p.add_subparsers(dest="action",required=True)
    s=sub.add_parser("advance")
    s.add_argument("--max-events",type=int,default=MAX_STEP_EVENTS)
    s.add_argument("--max-seconds",type=int,default=MAX_STEP_SECONDS)
    f=sub.add_parser("finalize")
    f.add_argument("--out",type=Path,required=True)
    sub.add_parser("status")
    args=p.parse_args()
    if args.action=="advance":
        result=advance(args.original_archive_dir,max_events=args.max_events,
                       max_seconds=args.max_seconds)
    elif args.action=="finalize":
        result=finalize(args.original_archive_dir,args.out)
    else:
        idx,digest,state,cp=load_checkpoints(args.original_archive_dir)
        result={"status":"ALL_REGISTERED_HORIZON_QUOTES_REPLAYED" if state["done"]
                  else "MULTI_HORIZON_REPLAY_IN_PROGRESS",
                "source_events_read":state["events_read"],
                "targets_completed":state["next_target_index"],
                "targets_total":len(targets()),
                "checkpoint_index":idx,"can_trade":False}
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
