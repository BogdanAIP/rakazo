#!/usr/bin/env python3
"""Algorithm Discovery v19 — ONE frozen trailing 8s slice from NEW 12s WS data.

Replays independently verified source bytes and book state. No arbitrary
window selection, historical source substitution, future prices, PnL or orders.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import json
from pathlib import Path
from datetime import datetime,timezone

from algorithm_ws_12s_coverage_v18 import analyze
from algorithm_ws_capture_v8 import parse_event
from algorithm_ws_audit_v8 import strict_load,level_update,dec
from algorithm_ai_research_v14 import registered,source_only_signal
from algorithm_multiday_registry_v12 import canonical,sha256

SCHEMA="algorithm_one_fixed_tail_8s_v19"
SOURCE_DAY="2026-10-30"
WARMUP_MS=4000
N=8
STEP=1000
FROZEN={
    "BTC-USDT-SWAP":"ws-v19-oct30-btc-01",
    "SOL-USDT-SWAP":"ws-v19-oct30-sol-01",
}
HYPOTHESES=("flow-memory-flip-20261030",
            "impact-efficiency-decay-20261030")


def frozen_source(source,symbol):
    source=Path(source)
    if symbol not in FROZEN or source.name!=FROZEN[symbol]:
        raise ValueError("Source not in the precommitted v19 market/cohort")
    audit=analyze(source)
    m=strict_load((source/"manifest.json").read_bytes())
    if audit["symbol"]!=symbol:
        raise ValueError("Original source instrument mismatch")
    start,end=m["start_utc_ms"],m["end_utc_ms"]
    if any(datetime.fromtimestamp(t/1000,timezone.utc).date().isoformat()!=SOURCE_DAY
           for t in (start,end)):
        raise ValueError("Source not on Oct 30 UTC")
    return source,audit,m


def tail_buckets(source,symbol):
    folder,audit,m=frozen_source(source,symbol)
    start,end=m["start_utc_ms"],m["end_utc_ms"]
    tail_start=start+WARMUP_MS
    tail_end=tail_start+N*STEP
    if tail_end> end:
        raise ValueError("No complete fixed tail window")
    rows=[{"index":i,"source_second":i+4,
           "start_utc_ms":tail_start+i*STEP,
           "end_utc_ms":tail_start+(i+1)*STEP,
           "buy_taker_contracts":Decimal(0),
           "sell_taker_contracts":Decimal(0),
           "fill_count":0,"book_update_count":0,
           "book_end_asof_ms":None,
           "best_bid":None,"best_ask":None,
           "status":"ABSTAIN_INCOMPLETE_SECOND"} for i in range(N)]
    book={"bids":{},"asks":{}}
    acknowledged={"book":False,"trade":False}
    snap=False
    seq=None
    for line in (folder/"messages.jsonl").read_bytes().splitlines():
        e=strict_load(line)
        src=e["source"];ms=e["received_complete_utc_ms"]
        obj,kind=parse_event(src,symbol,e["raw"])
        if kind=="ack":
            acknowledged[src]=True
            continue
        if kind=="notice":
            continue
        if not acknowledged[src]:
            # The independent full 12s auditor already rejected any
            # out-of-ACK frame starting inside the synchronized window.
            continue
        b=(ms-tail_start)//STEP if tail_start<ms<tail_end else None
        if src=="book":
            payload=obj["data"][0]
            next_seq=payload["seqId"]
            if kind=="snapshot":
                # A full snapshot is the only true initial depth baseline.
                if snap:
                    raise ValueError("Second unexpected book snapshot")
                snap=True
                seq=next_seq
                book={"bids":{},"asks":{}}
                for side in ("bids","asks"):
                    level_update(book[side],payload[side],side,snapshot=True)
            else:
                if not snap or payload["prevSeqId"]!=seq or next_seq<seq:
                    raise ValueError("Reconstructed book sequence gap")
                if next_seq>seq:
                    seq=next_seq
                    for side in ("bids","asks"):
                        level_update(book[side],payload[side],side,snapshot=False)
                    if b is not None:
                        rows[b]["book_update_count"]+=1
                elif payload.get("bids") or payload.get("asks"):
                    raise ValueError("Repeated nonempty sequence")
            if not book["bids"] or not book["asks"] or max(book["bids"])>=min(book["asks"]):
                raise ValueError("Invalid replayed best quote")
            if b is not None and kind=="update" and next_seq>payload["prevSeqId"]:
                rows[b]["book_end_asof_ms"]=ms
                rows[b]["best_bid"]=str(max(book["bids"]))
                rows[b]["best_ask"]=str(min(book["asks"]))
        elif b is not None:
            tr=obj["data"][0]
            exchange_ms=int(tr["ts"])
            if tail_start<=exchange_ms<tail_end and start<=exchange_ms<end:
                size=dec(tr["sz"],positive=True)
                rows[b][tr["side"]+"_taker_contracts"]+=size
                rows[b]["fill_count"]+=1
    if not snap or not all(acknowledged.values()):
        raise ValueError("No initial book and subscription ACK")
    for row in rows:
        row["status"]=("OBSERVED_BOTH" if row["book_update_count"]>0
                       and row["fill_count"]>0 else "ABSTAIN_INCOMPLETE_SECOND")
        for key,val in tuple(row.items()):
            if isinstance(val,Decimal):
                row[key]=str(val)
    if sum(r["status"]=="OBSERVED_BOTH" for r in rows)!=audit[
        "predeclared_overlapping_eight_second_windows"][4]["joint_seconds"]:
        raise ValueError("Fixed trailing-window reconstruction disagrees with independent 12s audit")
    return {
        "schema":"algorithm_one_fixed_tail_second_bins_v19",
        "symbol":symbol,
        "source_manifest_sha256":audit["source_manifest_sha256"],
        "source_messages_sha256":audit["source_messages_sha256"],
        "window_start_utc_ms":tail_start,
        "window_end_utc_ms":end,
        "feature_window_end_utc_ms":tail_end,
        "original_full_capture_start_utc_ms":start,
        "original_capture_duration_ms":end-start,
        "fixed_tail_offset_seconds":4,
        "one_second_bins":rows,
        "bins_with_both_streams":sum(r["status"]=="OBSERVED_BOTH" for r in rows),
        "future_outcomes_accessed":False,
        "can_trade":False,
    }


def evaluate(source,study,symbol):
    data=tail_buckets(source,symbol)
    known={p["id"]:(head,p) for head,p in registered(study)}
    if set(HYPOTHESES)-set(known):
        raise ValueError("Both precommitted research proposals must exist")
    start=data["original_full_capture_start_utc_ms"]
    scored=[]
    for name in HYPOTHESES:
        header,p=known[name]
        if header["registered_utc_ms"]>=start:
            raise ValueError("Hindsight hypothesis, proposal not committed before new source")
        outcome=source_only_signal(data,p)
        if outcome["future_quote_labels_accessed"] is not False or
            outcome["can_trade"] is not False:
            raise ValueError("Invalid nontrading hypothesis result")
        scored.append({"id":name,"proposal_sha256":header["proposal_sha256"],
                       "ledger_sha256":header["entry_sha256"],
                       "source_only_result":outcome})
    return {
        "schema":SCHEMA,
        "scope":"OCT30_SOURCE_ONLY_OUTSIDE_V12_NOVEMBER_COHORT",
        "symbol":symbol,"source_folder":Path(source).name,
        "original_capture_manifest_sha256":data["source_manifest_sha256"],
        "original_raw_messages_sha256":data["source_messages_sha256"],
        "capture_start_utc_ms":data["original_full_capture_start_utc_ms"],
        "capture_end_utc_ms":data["window_end_utc_ms"],
        "fixed_eight_second_decision_start_utc_ms":data["window_start_utc_ms"],
        "fixed_eight_second_feature_end_utc_ms":data["feature_window_end_utc_ms"],
        "joint_tail_seconds":data["bins_with_both_streams"],
        "candidate_checks":scored,
        "eligible_candidate_count":sum(x["source_only_result"]["eligible"] for x in scored),
        "candidate_checks_on_same_source_are_not_independent":True,
        "no_original_v18_or_v17_source_reused":True,
        "future_market_labels":None,"realized_pnl":None,
        "scientific_result":"UNSCORED_SOURCE_ONLY_HYPOTHESES",
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",required=True,type=Path)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--symbol",required=True,choices=list(FROZEN))
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("Do not overwrite an exploratory source result")
    result=evaluate(args.source,args.study,args.symbol)
    with args.out.open("xb") as f:
        f.write(canonical(result)+b"\n")
    print(json.dumps({
        "symbol":result["symbol"],
        "joint_tail_seconds":result["joint_tail_seconds"],
        "source_manifest_sha256":result["original_capture_manifest_sha256"],
        "candidate_checks":[{
            "candidate_id":x["id"],
            "eligible":x["source_only_result"]["eligible"],
            "reason":x["source_only_result"]["eligibility_result"],
            "direction":x["source_only_result"]["hypothetical_direction"]
        } for x in result["candidate_checks"]],
        "report_sha256":sha256(args.out.read_bytes()),
        "future_market_labels":None,"can_trade":False
    },sort_keys=True))


if __name__=="__main__":
    main()
