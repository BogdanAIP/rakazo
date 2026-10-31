#!/usr/bin/env python3
"""v22 bounded manual checkpointed replay of a real OFFICIAL historical L2 .data.

Separates faithful decompression and finite, SHA-chained processing steps so
large OKX NDJSON archives can run on an 8GB Windows laptop without an always-
on job. No future REST quote endpoints, paid API, account keys or orders.
Historical 5min benchmark is NOT a prospective trading prediction.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import heapq
import json
import os
from pathlib import Path
import tarfile
import time

from algorithm_historical_l2_official_v22 import (
    SYMBOL,DATE,ENTRY_MS,EXIT_MS,SCHEMA as BENCH_SCHEMA,
    REQUIRED_MEMBER,MAX_LINE_BYTES,MAX_UNCOMPRESSED_BYTES,
    MAX_SOURCE_EVENTS,validate_receipt,quote
)
from algorithm_historical_l2_v16 import unpack_event,decimal,scenario,sha_file
from algorithm_official_archive_download_v22 import CAP,URL,ARCHIVE_NAME
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode,GENESIS

SCHEMA="algorithm_l2_archive_checkpoint_v22"
SPOOL_RECEIPT_SCHEMA="algorithm_l2_archive_spool_v22"
BENCHMARK_REPLAY_SCHEMA="algorithm_l2_official_staged_benchmark_v22"
SPOOL_FILE="NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.data"
SPOOL_RECEIPT="NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.spool-receipt.json"
MAX_STEPS=100_000
MAX_SECONDS=11


def initialize_state():
    return {
        "offset_bytes":0,
        "events_read":0,
        "events_applied":0,
        "snapshots_seen":0,
        "asof_exchange_ts_ms":None,
        "last_event_exchange_ts_ms":None,
        "book":{"bids":{},"asks":{}},
        "seq_available":None,
        "prior_seq":None,
        "entry":None,
        "exit":None,
        "complete":False,
        "uncompressed_stream_eof":False,
    }


def unpack(folder):
    folder=Path(folder)
    archive,receipt,receipt_sha=validate_receipt(folder)
    spool=folder/SPOOL_FILE
    tmp=folder/(SPOOL_FILE+".part")
    receipt_file=folder/SPOOL_RECEIPT
    if any(p.exists() for p in (spool,tmp,receipt_file)):
        raise FileExistsError("Decompression or prior attempt already exists")
    hashed=hashlib.sha256()
    seen=0
    with tarfile.open(archive,"r|gz") as tf:
        members=iter(tf)
        item=next(members,None)
        if (item is None or not item.isfile() or item.issym() or item.islnk()
            or item.name!=REQUIRED_MEMBER
            or not 0<item.size<=MAX_UNCOMPRESSED_BYTES):
            raise ValueError("Unexpected official .data archive member")
        stream=tf.extractfile(item)
        if stream is None:
            raise ValueError("Cannot open historical .data stream")
        with tmp.open("xb") as out:
            while True:
                buf=stream.read(1<<20)
                if not buf:
                    break
                seen+=len(buf)
                if seen>MAX_UNCOMPRESSED_BYTES:
                    raise ValueError("Uncompressed data resource cap exceeded")
                hashed.update(buf)
                out.write(buf)
        if seen!=item.size:
            raise ValueError("Historical archive truncated")
        if next(members,None) is not None:
            raise ValueError("Extra tar member; expected exactly one .data file")
    result={
        "schema":SPOOL_RECEIPT_SCHEMA,
        "source_archive_sha256":receipt["original_archive_sha256"],
        "source_download_receipt_sha256":receipt_sha,
        "original_member_name":REQUIRED_MEMBER,
        "uncompressed_sha256":hashed.hexdigest(),
        "uncompressed_bytes":seen,
        "no_pricing_values_interpreted":True,
        "compression_was_streamed_with_memory_bound":True,
        "can_trade":False,
    }
    with receipt_file.open("xb") as f:
        f.write(canonical(result)+b"\n")
    os.replace(tmp,spool)
    return {
        "status":"HISTORICAL_ARCHIVE_UNPACKED_NO_PRICES_PARSED",
        "compressed_original_sha256":receipt["original_archive_sha256"],
        "spool_original_sha256":hashed.hexdigest(),
        "uncompressed_bytes":seen,
        "can_trade":False,
    }


def spool_evidence(folder,*,rehash=False):
    folder=Path(folder)
    archive,receipt,receipt_sha=validate_receipt(folder)
    raw=(folder/SPOOL_RECEIPT).read_bytes()
    info=strictly_decode(raw)
    spool=folder/SPOOL_FILE
    if (not isinstance(info,dict) or info.get("schema")!=SPOOL_RECEIPT_SCHEMA
        or info.get("source_archive_sha256")!=receipt["original_archive_sha256"]
        or info.get("source_download_receipt_sha256")!=receipt_sha
        or info.get("original_member_name")!=REQUIRED_MEMBER
        or spool.stat().st_size!=info.get("uncompressed_bytes")
        or not 0<info["uncompressed_bytes"]<=MAX_UNCOMPRESSED_BYTES):
        raise ValueError("Unpacked source does not match official binary receipt")
    if rehash and sha_file(spool)!=info["uncompressed_sha256"]:
        raise ValueError("Unpacked source bytes changed since original decompression")
    return spool,info


def checkpoints(folder):
    root=Path(folder)/"checkpoints"
    root.mkdir(exist_ok=True)
    names=sorted(root.glob("*.json"))
    prev=GENESIS
    last=initialize_state()
    for i,file in enumerate(names,1):
        if file.name!=f"checkpoint-{i:06d}.json":
            raise ValueError("Gap in immutable checkpoint numbering")
        row=strictly_decode(file.read_bytes())
        if (not isinstance(row,dict) or row.get("schema")!=SCHEMA
            or row.get("sequence")!=i
            or row.get("previous_sha256")!=prev
            or not isinstance(row.get("state"),dict)):
            raise ValueError("Invalid checkpoint structure/chain")
        head={k:row[k] for k in ("schema","sequence","previous_sha256","state")}
        digest=sha256(canonical(head))
        if row.get("checkpoint_sha256")!=digest:
            raise ValueError("Modified previous source replay checkpoint")
        prev=digest
        last=row["state"]
    return len(names),prev,last


def heaps_from_book(state):
    books={}
    for side in ("bids","asks"):
        data=state["book"][side]
        books[side]={Decimal(p):Decimal(q) for p,q in data.items()}
    bidheap=[-p for p in books["bids"]]
    askheap=[p for p in books["asks"]]
    heapq.heapify(bidheap)
    heapq.heapify(askheap)
    return books,{"bids":bidheap,"asks":askheap}


def current_best(books,heaps):
    bids,asks=books["bids"],books["asks"]
    b=heaps["bids"]
    a=heaps["asks"]
    while b and -b[0] not in bids:
        heapq.heappop(b)
    while a and a[0] not in asks:
        heapq.heappop(a)
    if not b or not a:
        raise ValueError("Historical book missing bid or ask side")
    bid=-b[0]
    ask=a[0]
    if not 0<bid<ask:
        raise ValueError("Crossed/locked or invalid historical quote")
    return bid,ask


def apply_levels(books,heaps,sides,action):
    if action=="snapshot":
        for side in ("bids","asks"):
            books[side].clear()
            heaps[side].clear()
    for side in ("bids","asks"):
        for px,qty in sides[side]:
            if qty==0:
                books[side].pop(px,None)
            else:
                if px not in books[side]:
                    heapq.heappush(heaps[side],-px if side=="bids" else px)
                books[side][px]=qty


def capture_quote(books,heaps,asof,target,bracket):
    bid,ask=current_best(books,heaps)
    return quote({"bids":{bid:books["bids"][bid]},
                  "asks":{ask:books["asks"][ask]}},asof,target,bracket)


def process_one(state,books,heaps,line):
    ts,action,seq,prev,sides,instrument=unpack_event(line)
    if instrument!=SYMBOL:
        raise ValueError("Wrong exchange instrument in original .data")
    prior_time=state["last_event_exchange_ts_ms"]
    if prior_time is not None and ts<prior_time:
        raise ValueError("Exchange data events are not time ordered")
    state["last_event_exchange_ts_ms"]=ts
    state["events_read"]+=1
    if state["events_read"]>MAX_SOURCE_EVENTS:
        raise ValueError("Historical event count exceeds fixed budget")
    if ts>ENTRY_MS and state["entry"] is None:
        if state["snapshots_seen"]<1:
            raise ValueError("Missing earlier order book snapshot")
        state["entry"]=capture_quote(
            books,heaps,state["asof_exchange_ts_ms"],ENTRY_MS,ts)
    if ts>EXIT_MS:
        if state["snapshots_seen"]<1:
            raise ValueError("Missing earlier full snapshot before exit")
        state["exit"]=capture_quote(
            books,heaps,state["asof_exchange_ts_ms"],EXIT_MS,ts)
        state["complete"]=True
        return
    if action=="snapshot":
        state["snapshots_seen"]+=1
        state["seq_available"]=seq is not None
        state["prior_seq"]=seq
    elif not state["snapshots_seen"]:
        return
    elif state["seq_available"]:
        if seq is None or prev!=state["prior_seq"] or seq<state["prior_seq"]:
            raise ValueError("Archive contained sequence gap after its snapshot")
        state["prior_seq"]=seq
    elif seq is not None:
        raise ValueError("Source sequence-field availability changed midstream")
    apply_levels(books,heaps,sides,action)
    current_best(books,heaps)
    state["events_applied"]+=1
    state["asof_exchange_ts_ms"]=ts


def advance(folder,*,max_events=MAX_STEPS,max_seconds=MAX_SECONDS):
    if (type(max_events) is not int or not 1<=max_events<=MAX_STEPS
        or type(max_seconds) is not int or not 1<=max_seconds<=MAX_SECONDS):
        raise ValueError("Manual bounded slice exceeds prereg code limits")
    spool,info=spool_evidence(folder)
    i,prev,state=checkpoints(folder)
    if state["complete"]:
        return {"status":"FIXED_HISTORICAL_TARGETS_ALREADY_REPLAYED",
                "checkpoint_sequence":i,"events_read":state["events_read"],
                "can_trade":False}
    books,heaps=heaps_from_book(state)
    clock=time.monotonic()
    done=0
    with spool.open("rb") as stream:
        stream.seek(state["offset_bytes"])
        while done<max_events and time.monotonic()-clock<max_seconds:
            line=stream.readline(MAX_LINE_BYTES+1)
            if not line:
                state["uncompressed_stream_eof"]=True
                break
            if len(line)>MAX_LINE_BYTES or not line.strip():
                raise ValueError("Malformed/oversized official historical NDJSON event")
            process_one(state,books,heaps,line)
            state["offset_bytes"]=stream.tell()
            done+=1
            if state["complete"]:
                break
    state["book"]={
        side:{str(p):str(q) for p,q in books[side].items()}
        for side in ("bids","asks")
    }
    seq=i+1
    record={"schema":SCHEMA,"sequence":seq,"previous_sha256":prev,"state":state}
    digest=sha256(canonical(record))
    record["checkpoint_sha256"]=digest
    path=Path(folder)/"checkpoints"/f"checkpoint-{seq:06d}.json"
    with path.open("xb") as out:
        out.write(canonical(record)+b"\n")
    return {
        "status":"COMPLETE_FIXED_QUOTES_READY_FOR_BOTH_DIRECTION_FEES"
                 if state["complete"] else
                 "REPLAY_IN_PROGRESS_NO_OUTCOME_CLAIM",
        "checkpoint_sequence":seq,
        "checkpoint_sha256":digest,
        "events_read_total":state["events_read"],
        "events_processed_this_step":done,
        "source_offset_bytes":state["offset_bytes"],
        "uncompressed_total_bytes":info["uncompressed_bytes"],
        "snapshot_count":state["snapshots_seen"],
        "whole_archive_day_fully_audited":False,
        "can_trade":False,
    }


def finalize(folder,output):
    folder=Path(folder)
    output=Path(output)
    if output.exists():
        raise FileExistsError("Historical benchmark already exists")
    archive,r,receipt_sha=validate_receipt(folder)
    spool,spool_info=spool_evidence(folder,rehash=True)
    i,prev,state=checkpoints(folder)
    if not state["complete"] or state["entry"] is None or state["exit"] is None:
        raise ValueError("Fixed 12:00 and 12:05 quotes not yet both verified")
    entry=state["entry"];exit_=state["exit"]
    eb=decimal(entry["bid"],positive=True)
    ea=decimal(entry["ask"],positive=True)
    xb=decimal(exit_["bid"],positive=True)
    xa=decimal(exit_["ask"],positive=True)
    result={
        "schema":BENCHMARK_REPLAY_SCHEMA,
        "scientific_scope":"RETROSPECTIVE_HISTORICAL_L2_5MIN_QUOTE_ARITHMETIC_NO_FORECAST",
        "original_btc_file_status":"ARCHIVE_SIZE_OVER_250_MIB_CAP_NO_BTC_PRICE_REPLAY",
        "supplementary_symbol_selected_before_prices":"NEAR-USDT-SWAP_30.18MB_LOWEST_FILE_SIZE",
        "symbol":SYMBOL,"date_utc":DATE,
        "official_original_download_url":URL,
        "original_archive_sha256":r["original_archive_sha256"],
        "original_archive_bytes":r["original_bytes"],
        "download_receipt_sha256":receipt_sha,
        "uncompressed_member_sha256":spool_info["uncompressed_sha256"],
        "checkpoint_count":i,"latest_checkpoint_sha256":prev,
        "original_event_rows_replayed":state["events_read"],
        "original_rows_applied":state["events_applied"],
        "full_original_snapshots_seen":state["snapshots_seen"],
        "exchange_sequence_ids_present":state["seq_available"] is True,
        "exchange_update_stream_independently_gapless_proven":state["seq_available"] is True,
        "historical_entry_book":entry,
        "historical_exit_book":exit_,
        "time_horizon_ms":EXIT_MS-ENTRY_MS,
        "both_direction_quote_crossing_fee_proxies":{
            "long":scenario(1,eb,ea,xb,xa),
            "short":scenario(-1,eb,ea,xb,xa),
        },
        "commission_scenarios":"assumed 5bps/side and 7bps/side, not account verified",
        "spread_included_by_crossing":True,
        "slippage_funding_contract_lots_not_modelled":True,
        "actual_fills_verified":False,
        "realized_pnl":None,
        "past_price_sample_selected_by_success":False,
        "cryptographic_exchange_file_signature_present":False,
        "true_prospective_model_prediction":False,
        "counts_toward_validated_alpha":False,
        "status":"REAL_OFFICIAL_ARCHIVE_QUOTES_HISTORICAL_ARITHMETIC_ONLY",
        "can_trade":False,"can_start_paper":False,
    }
    with output.open("xb") as out:
        out.write(canonical(result)+b"\n")
    return {
        "status":result["status"],
        "archive_original_sha256":result["original_archive_sha256"],
        "entry":entry,"exit":exit_,
        "long_gross_bps":result["both_direction_quote_crossing_fee_proxies"]["long"]["gross_crossing_quote_bps"],
        "long_net_bps_5_per_side":result["both_direction_quote_crossing_fee_proxies"]["long"]["base_five_bps_per_side_proxy_net_bps"],
        "short_gross_bps":result["both_direction_quote_crossing_fee_proxies"]["short"]["gross_crossing_quote_bps"],
        "short_net_bps_5_per_side":result["both_direction_quote_crossing_fee_proxies"]["short"]["base_five_bps_per_side_proxy_net_bps"],
        "output_sha256":sha256(output.read_bytes()),
        "validated_alpha":False,
        "can_trade":False,
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir",type=Path,required=True)
    subs=parser.add_subparsers(dest="action",required=True)
    subs.add_parser("unpack")
    step=subs.add_parser("advance")
    step.add_argument("--max-events",type=int,default=MAX_STEPS)
    step.add_argument("--max-seconds",type=int,default=MAX_SECONDS)
    done=subs.add_parser("finalize")
    done.add_argument("--out",type=Path,required=True)
    subs.add_parser("status")
    args=parser.parse_args()
    if args.action=="unpack":
        r=unpack(args.source_dir)
    elif args.action=="advance":
        r=advance(args.source_dir,max_events=args.max_events,
                  max_seconds=args.max_seconds)
    elif args.action=="finalize":
        r=finalize(args.source_dir,args.out)
    else:
        n,digest,state=checkpoints(args.source_dir)
        r={"status":"COMPLETE" if state["complete"] else "IN_PROGRESS",
           "checkpoint_count":n,
           "events_read":state["events_read"],
           "source_offset_bytes":state["offset_bytes"],
           "source_complete":state["complete"],
           "can_trade":False}
    print(json.dumps(r,ensure_ascii=False,sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
