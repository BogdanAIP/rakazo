#!/usr/bin/env python3
"""Immutable-source, resumable v30 top-five historical orderbook as-of replay.

Only original public 400-level daily OKX L2 tarball + extracted member.
Preselected candidate timestamps strictly from v30 tape detector. Historical
event-time replay, NOT real-time entitlement, tradable quotes, or causality.
"""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
from decimal import Decimal as D
import hashlib
import json
import os
from pathlib import Path
import tarfile
import time

from algorithm_v30_archive_acquire import DAYS,PRIMARIES,registered,digest
from algorithm_multiday_registry_v12 import canonical,sha256
from algorithm_historical_l2_v16 import unpack_event
from algorithm_l2_checkpoint_v22 import apply_levels,current_best,heaps_from_book
from algorithm_onset_l2_audit_v29 import asof_original

SCHEMA="algorithm_v30_original_L2_firstpass_replay"
MAX_EVENTS_PER_CASE=5_000_000
MAX_LINE_BYTES=5_000_000
STEP_SECONDS=9
MAX_EVENTS_STEP=65000

def manifest(root,day,sym):
    if day not in DAYS or sym not in PRIMARIES:
        raise ValueError("Unregistered v30 historical book cohort")
    name,url=registered(day,sym,"L2")
    original=Path(root)/"source"/day/sym/"L2"/name
    receipt=json.loads(Path(str(original)+".receipt.json").read_text(encoding="utf-8"))
    if (receipt.get("schema")!="algorithm_v30_original_source_receipt"
       or receipt.get("source_url")!=url or receipt.get("original_bytes")!=original.stat().st_size
       or receipt.get("original_sha256")!=digest(original)):
        raise ValueError("Source receipt/SHA mismatch")
    spool=Path(root)/"spool"/day/sym/f"{sym}-L2orderbook-400lv-{day}.data"
    with tarfile.open(original,"r|gz") as archive:
        member=archive.next()
        if member is None or member.name!=spool.name or member.size!=spool.stat().st_size:
            raise ValueError("Extracted original source member mismatch")
    onset=Path(root)/"onsets"/f"{sym}-{day}-source-only-v30.json"
    onset_sha=digest(onset)
    cases=json.loads(onset.read_bytes())
    if (cases.get("schema")!="algorithm_independent_v30_tape_onset_case"
        or cases.get("day_label_utc_plus8")!=day or cases.get("symbol")!=sym
        or len(cases["all_467_decision_minutes"])!=467):
        raise ValueError("Bound original case not an intact predeclared 467-minute cohort")
    events=cases["selected_onsets"]
    targets=sorted({k for e in events for k in (e["decision_ms"]-60000,e["decision_ms"])})
    return original,spool,onset,receipt,onset_sha,events,targets

def new_state(root,day,sym):
    orig,spool,onset,rc,onset_sha,events,targets=manifest(root,day,sym)
    return {
        "schema":SCHEMA,"day":day,"symbol":sym,"original_sha256":rc["original_sha256"],
        "spool_sha256":digest(spool),"onset_source_sha256":onset_sha,
        "targets":targets,"quotes":{},"quote_index":0,
        "offset_bytes":0,"events_read":0,"full_snapshots":0,
        "seq_ids_available":None,"prior_seq":None,"last_exchange_ts_ms":None,
        "last_book_asof_ms":None,"book":{"bids":{},"asks":{}},
        "done":not bool(events),"source_eof":False,
        "source_is_venue_signed":False,"network_arrival_known":False,
    }

def atomic_checkpoint(path,state):
    path.parent.mkdir(parents=True,exist_ok=True)
    part=path.with_suffix(".json.tmp")
    with part.open("wb") as f:f.write(canonical(state)+b"\n")
    os.replace(part,path)

def advance(root,day,sym,seconds=STEP_SECONDS,maximum=MAX_EVENTS_STEP):
    if not 1<=seconds<=STEP_SECONDS or not 1<=maximum<=MAX_EVENTS_STEP:
        raise ValueError("Unbounded book replay step")
    orig,spool,onset,rc,onset_sha,events,targets=manifest(root,day,sym)
    stage=Path(root)/"l2"/f"{sym}-{day}"
    cp=stage/"checkpoint.json"
    if cp.exists():
        state=json.loads(cp.read_bytes())
        if (state.get("schema")!=SCHEMA or state["day"]!=day or state["symbol"]!=sym
            or state["original_sha256"]!=rc["original_sha256"]
            or state["onset_source_sha256"]!=onset_sha or state["targets"]!=targets):
            raise ValueError("Changed frozen event/source/checkpoint identity")
    else:
        state=new_state(root,day,sym)
    if state["done"]:
        return {"status":"COMPLETE_ALREADY","day":day,"symbol":sym,"events":state["events_read"],
                "quotes":len(state["quotes"]),"checkpoint_sha256":digest(cp)}
    book,heaps=heaps_from_book(state)
    last_ts=state["last_exchange_ts_ms"]
    start=time.monotonic()
    count=0
    with spool.open("rb") as f:
        f.seek(state["offset_bytes"])
        while count<maximum and time.monotonic()-start<seconds and not state["done"]:
            line=f.readline(MAX_LINE_BYTES+1)
            if not line or len(line)>MAX_LINE_BYTES:
                raise ValueError("Original historical L2 member ended or row exceeded cap")
            ts,action,seq,prev,sides,instrument=unpack_event(line)
            if instrument!=sym or (last_ts is not None and ts<last_ts):
                raise ValueError("Original historical L2 instrument/monotonic clock invalid")
            end_utc=int(datetime.fromisoformat(day+"T00:00:00+00:00").timestamp()*1000)+86400000
            if ts>=end_utc:
                raise ValueError("Original history last target missing before source day end")
            while state["quote_index"]<len(targets) and ts>targets[state["quote_index"]]:
                target=targets[state["quote_index"]]
                state["quotes"][str(target)]=asof_original(
                    book,heaps,state["last_book_asof_ms"],target,ts)
                state["quote_index"]+=1
            if state["quote_index"]==len(targets):
                state["done"]=True
                state["offset_bytes"]=f.tell()
                break
            if action=="snapshot":
                state["full_snapshots"]+=1
                state["seq_ids_available"]=(seq is not None)
                state["prior_seq"]=seq
            elif state["full_snapshots"]==0:
                state["offset_bytes"]=f.tell()
                last_ts=ts
                state["last_exchange_ts_ms"]=ts
                state["events_read"]+=1
                count+=1
                continue
            elif state["seq_ids_available"]:
                if seq is None or prev!=state["prior_seq"] or seq<state["prior_seq"]:
                    raise ValueError("Original L2 delta sequence discontinuity")
                state["prior_seq"]=seq
            elif seq is not None:
                raise ValueError("Original book unexpectedly added sequence identifiers")
            apply_levels(book,heaps,sides,action)
            current_best(book,heaps)
            state["last_book_asof_ms"]=ts
            state["last_exchange_ts_ms"]=ts
            last_ts=ts
            state["events_read"]+=1
            if state["events_read"]>MAX_EVENTS_PER_CASE:
                raise ValueError("Source event count exceeds preregistered bound")
            state["offset_bytes"]=f.tell()
            count+=1
    state["book"]={side:{str(p):str(q) for p,q in book[side].items()} for side in ("bids","asks")}
    atomic_checkpoint(cp,state)
    return {"status":"COMPLETE" if state["done"] else "ADVANCED",
            "day":day,"symbol":sym,"step_events":count,
            "total_events":state["events_read"],"recorded_quote_targets":len(state["quotes"]),
            "expected_quote_targets":len(targets),"last_source_time_ms":state["last_exchange_ts_ms"],
            "checkpoint_sha256":digest(cp)}

def finalize(root,day,sym):
    orig,spool,onset,rc,onset_sha,events,targets=manifest(root,day,sym)
    cp=Path(root)/"l2"/f"{sym}-{day}"/"checkpoint.json"
    state=json.loads(cp.read_bytes())
    if not state["done"] or len(state["quotes"])!=len(targets):
        raise ValueError("L2 original replay has not covered all registered targets")
    table=[]
    for e in events:
        p=state["quotes"][str(e["decision_ms"]-60000)]
        q=state["quotes"][str(e["decision_ms"])]
        both=p.get("status")=="AVAILABLE" and q.get("status")=="AVAILABLE"
        a=(D(e["direction"])*(D(q["original_top5_imbalance"])-D(p["original_top5_imbalance"]))
           if both else None)
        quote_move=(D(10000)*(D(q["midquote"])/D(p["midquote"])-1)
                    if both else None)
        table.append({
            "id":e["id"],"decision_utc":e["utc"],"d":e["direction"],
            "source_quote_both_strict_available":both,
            "at_T_minus60s":p,"at_T":q,
            "signed_depth_alignment":str(a) if a is not None else None,
            "alignment_group":("ALIGNED" if a>0 else "UNALIGNED") if a is not None else "L2_UNAVAILABLE",
            "original_L2_mid_change_bps":str(quote_move) if quote_move is not None else None,
            "outcome_copied_from_frozen_tape":e["outcome_HINDSIGHT_ONLY"]["outcome"],
            "not_actual_executable_PnL":True
        })
    result={"schema":"algorithm_v30_original_L2_asof_result",
        "day_label_utc_plus8":day,"symbol":sym,
        "book_gz_original_sha256":rc["original_sha256"],
        "uncompressed_original_spool_sha256":state["spool_sha256"],
        "tape_original_sha256":onset_sha,"source_l2_replay_checkpoint_sha256":digest(cp),
        "book_events_replayed":state["events_read"],"all_targets_count":len(targets),
        "all_onsets_count":len(events),"quotes_available":sum(x["source_quote_both_strict_available"] for x in table),
        "recorded_cases":table,
        "historical_exchange_event_time_not_known_network_arrival":True,
        "source_do_not_infer_manipulation_actor_or_causes":True,
        "can_trade":False}
    outfile=Path(root)/"l2"/f"{sym}-{day}-book-alignment-result-v30.json"
    if outfile.exists():raise FileExistsError("Immutable original v30 result already created")
    with outfile.open("xb") as f:f.write(canonical(result)+b"\n")
    return {"day":day,"symbol":sym,"events":len(events),"book_verified":result["quotes_available"],
            "aligned":sum(x["alignment_group"]=="ALIGNED" for x in table),
            "unaligned":sum(x["alignment_group"]=="UNALIGNED" for x in table),
            "l2_unavailable":sum(x["alignment_group"]=="L2_UNAVAILABLE" for x in table),
            "original_result_sha256":digest(outfile),
            "rows":[(x["decision_utc"],x["alignment_group"],x["outcome_copied_from_frozen_tape"]) for x in table]}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("operation",choices=("advance","finalize"))
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--day",required=True)
    p.add_argument("--symbol",required=True)
    p.add_argument("--seconds",type=int,default=9)
    p.add_argument("--max-events",type=int,default=65000)
    a=p.parse_args()
    x=(advance(a.root,a.day,a.symbol,a.seconds,a.max_events)
       if a.operation=="advance" else finalize(a.root,a.day,a.symbol))
    print(json.dumps(x,ensure_ascii=False,sort_keys=True))
if __name__=="__main__": main()
