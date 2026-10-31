#!/usr/bin/env python3
"""v24 OFFLINE frozen v23 formula replication on exactly two NEW official L2 days.

No live quote requests, orders, PAPER, background daemon or model tuning.
Use manual download/unpack/advance/finalize, original SHA and immutable chained
checkpoints. A 2-day replication is NOT validated profitable alpha.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import time
import urllib.request

import algorithm_temporal_response_v23 as v23
from algorithm_historical_l2_v16 import sha_file,unpack_event
from algorithm_historical_l2_official_v22 import MAX_LINE_BYTES
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode,GENESIS

SCHEMA="algorithm_independent_day_v24"
RECEIPT_SCHEMA="algorithm_v24_official_history_receipt"
SPOOL_SCHEMA="algorithm_v24_decompressed_historical_source"
CHECKPOINT_SCHEMA="algorithm_v24_independent_day_checkpoint"
CANDIDATES=("baseline_imbalance","pressure_shock_without_mid_adaptation")
DAYS={
 "2026-09-03":{
  "url":"https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/20260903/NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-03.tar.gz",
  "catalogue_size_mb":"31.01"},
 "2026-09-04":{
  "url":"https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/20260904/NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-04.tar.gz",
  "catalogue_size_mb":"41.52"},
}
MAX_COMPRESSED=250*1024*1024
MAX_DECOMPRESSED=1024*1024*1024
MAX_STEP_EVENTS=100000
MAX_STEP_SECONDS=10
MAX_DOWNLOAD_SECONDS=40
ROOT_NAME="temporal-v24"


def day_meta(day):
    if day not in DAYS:
        raise ValueError("Unpreregistered archive day: no substitution allowed")
    return DAYS[day]


def filename(day):
    day_meta(day)
    return f"NEAR-USDT-SWAP-L2orderbook-400lv-{day}.tar.gz"


def membername(day):
    day_meta(day)
    return f"NEAR-USDT-SWAP-L2orderbook-400lv-{day}.data"


def day_ms(day):
    # Pure time parser also needs the v23 DEVELOPMENT baseline 2026-09-02.
    # Only the actual data-accessing target and anchor APIs are allowlisted.
    return int(datetime.fromisoformat(day+"T00:00:00+00:00").timestamp()*1000)


def shifted_anchors(day):
    day_meta(day) # Holdout 2026-09-05 remains inaccessible.
    shift=day_ms(day)-day_ms("2026-09-02")
    return tuple(t+shift for t in v23.anchors())


def shifted_targets(day):
    day_meta(day) # Holdout 2026-09-05 remains inaccessible.
    shift=day_ms(day)-day_ms("2026-09-02")
    return tuple(t+shift for t in v23.targets())


def config(day):
    base=v23.config()
    base["schema"]="algorithm_independent_day_config_v24"
    base["archive_date_utc"]=day
    base["anchor_utc_ms"]=list(shifted_anchors(day))
    base["scientific_split"]="FROZEN_FORMULA_REPLICATION_NEW_ARCHIVE_DAY_NOT_PROVEN_ALPHA"
    base["original_feature_code_lineage"]="algorithm_temporal_response_v23.signal_at,apply_one,observation,summarize"
    return base


def config_sha(day):
    return sha256(canonical(config(day)))


def original_paths(folder,day):
    folder=Path(folder)
    return folder/filename(day),folder/(filename(day)+".receipt.json")


def download(folder,day):
    meta=day_meta(day)
    folder=Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    original,receipt=original_paths(folder,day)
    partial=folder/(filename(day)+".part")
    if any(f.exists() for f in (original,receipt,partial)):
        raise FileExistsError("Immutable original archive already attempted or downloaded")
    if shutil.disk_usage(folder).free<MAX_COMPRESSED+MAX_DECOMPRESSED+100*1024*1024:
        raise OSError("Not enough disk for bounded original source")
    req=urllib.request.Request(meta["url"],headers={
        "Accept":"application/octet-stream",
        "User-Agent":"AlgorithmDiscovery-v24-OFFICIAL-HISTORICAL-L2/1.0"})
    sha=hashlib.sha256()
    count=0
    clock=time.monotonic()
    with urllib.request.urlopen(req,timeout=18) as http:
        if http.status!=200 or http.geturl()!=meta["url"]:
            raise ValueError("Unexpected official URL redirect or HTTP status")
        length=http.headers.get("Content-Length")
        if length is not None and int(length)>MAX_COMPRESSED:
            raise ValueError("Original archive exceeds prereg resource limit")
        http_meta={
            "url":http.geturl(),"status":http.status,
            "content_length":length,
            "etag":http.headers.get("ETag"),
            "last_modified":http.headers.get("Last-Modified"),
            "content_type":http.headers.get("Content-Type")
        }
        with partial.open("xb") as out:
            while True:
                if time.monotonic()-clock>MAX_DOWNLOAD_SECONDS:
                    raise TimeoutError("Fixed one-shot historical download deadline exceeded")
                buf=http.read(1024*1024)
                if not buf: break
                count+=len(buf)
                if count>MAX_COMPRESSED:
                    raise ValueError("Compressed original archive exceeds cap")
                sha.update(buf);out.write(buf)
    if count==0 or (length is not None and count!=int(length)):
        raise ValueError("Incomplete official original file")
    record={
        "schema":RECEIPT_SCHEMA,
        "symbol":"NEAR-USDT-SWAP","day_utc":day,
        "catalogue_advertised_size_mb":meta["catalogue_size_mb"],
        "original_filename":filename(day),
        "original_sha256":sha.hexdigest(),"original_bytes":count,
        "http_source":http_meta,
        "official_origin_independently_digitally_signed":False,
        "no_price_data_viewed_before_archive_download":True,
        "can_trade":False,
    }
    with receipt.open("xb") as f:
        f.write(canonical(record)+b"\n")
    os.replace(partial,original)
    return {"day":day,"status":"OFFICIAL_HISTORICAL_ARCHIVE_DOWNLOADED",
            "source_sha256":sha.hexdigest(),"bytes":count,"can_trade":False}


def original_evidence(folder,day,*,rehash=False):
    meta=day_meta(day)
    original,receipt_path=original_paths(folder,day)
    receipt=strictly_decode(receipt_path.read_bytes())
    if (receipt.get("schema")!=RECEIPT_SCHEMA or receipt.get("day_utc")!=day
        or receipt.get("symbol")!="NEAR-USDT-SWAP"
        or receipt.get("original_filename")!=filename(day)
        or receipt.get("http_source",{}).get("url")!=meta["url"]
        or receipt.get("http_source",{}).get("status")!=200
        or receipt.get("official_origin_independently_digitally_signed") is not False
        or original.stat().st_size!=receipt.get("original_bytes")
        or not 0<receipt["original_bytes"]<=MAX_COMPRESSED):
        raise ValueError("Unverified original historical archive receipt")
    if rehash and sha_file(original)!=receipt["original_sha256"]:
        raise ValueError("Original archive changed after download")
    return original,receipt,sha256(receipt_path.read_bytes())


def spool_paths(folder,day):
    path=Path(folder)
    return path/membername(day),path/(membername(day)+".receipt.json")


def unpack(folder,day):
    original,receipt,receipt_sha=original_evidence(folder,day,rehash=True)
    spool,spool_receipt=spool_paths(folder,day)
    part=Path(str(spool)+".part")
    if any(f.exists() for f in (spool,spool_receipt,part)):
        raise FileExistsError("Original uncompressed spool already attempted")
    size=0
    sha=hashlib.sha256()
    with tarfile.open(original,"r|gz") as tar:
        members=iter(tar)
        member=next(members,None)
        if (member is None or not member.isfile() or member.issym()
            or member.islnk() or member.name!=membername(day)
            or not 0<member.size<=MAX_DECOMPRESSED):
            raise ValueError("Unsupported or extra file in historical OKX archive")
        stream=tar.extractfile(member)
        if stream is None:raise ValueError("Cannot stream real original .data member")
        with part.open("xb") as out:
            while True:
                buf=stream.read(1024*1024)
                if not buf:break
                size+=len(buf)
                if size>MAX_DECOMPRESSED:
                    raise ValueError("Uncompressed original exceeds frozen budget")
                sha.update(buf);out.write(buf)
        if member.size!=size or next(members,None) is not None:
            raise ValueError("Truncated original or extra tar members")
    data={
        "schema":SPOOL_SCHEMA,"day_utc":day,
        "original_gzip_sha256":receipt["original_sha256"],
        "original_download_receipt_sha256":receipt_sha,
        "original_member_name":membername(day),
        "uncompressed_sha256":sha.hexdigest(),
        "uncompressed_bytes":size,
        "can_trade":False,
    }
    with spool_receipt.open("xb") as f:
        f.write(canonical(data)+b"\n")
    os.replace(part,spool)
    return {"day":day,"status":"ORIGINAL_L2_SPOOL_VERIFIED",
            "uncompressed_bytes":size,"uncompressed_sha256":sha.hexdigest(),
            "can_trade":False}


def spool_evidence(folder,day,*,rehash=False):
    original,receipt,receipt_sha=original_evidence(folder,day,rehash=rehash)
    spool,spool_receipt=spool_paths(folder,day)
    raw=spool_receipt.read_bytes()
    record=strictly_decode(raw)
    if (record.get("schema")!=SPOOL_SCHEMA
        or record.get("day_utc")!=day
        or record.get("original_gzip_sha256")!=receipt["original_sha256"]
        or record.get("original_download_receipt_sha256")!=receipt_sha
        or record.get("original_member_name")!=membername(day)
        or spool.stat().st_size!=record.get("uncompressed_bytes")
        or not 0<record["uncompressed_bytes"]<=MAX_DECOMPRESSED):
        raise ValueError("Original source spool receipt invalid")
    if rehash and sha_file(spool)!=record["uncompressed_sha256"]:
        raise ValueError("Uncompressed original data is tampered")
    return spool,record,receipt


def checkpoints(folder,day):
    day_meta(day)
    root=Path(folder)/ROOT_NAME/"checkpoints"
    root.mkdir(parents=True,exist_ok=True)
    names=sorted(root.glob("*.json"))
    prev=GENESIS
    state=v23.new_state()
    for i,file in enumerate(names,1):
        if file.name!=f"checkpoint-{i:06d}.json":
            raise ValueError("Unexpected checkpoint series numbering")
        row=strictly_decode(file.read_bytes())
        if (row.get("schema")!=CHECKPOINT_SCHEMA or row.get("day_utc")!=day
            or row.get("index")!=i or row.get("previous_sha256")!=prev
            or row.get("configuration_sha256")!=config_sha(day)
            or not isinstance(row.get("state"),dict)):
            raise ValueError("Invalid immutable replay checkpoint metadata")
        core={k:row[k] for k in ("schema","day_utc","index",
                "previous_sha256","configuration_sha256","state")}
        digest=sha256(canonical(core))
        if row.get("checkpoint_sha256")!=digest:
            raise ValueError("Modified replay checkpoint")
        prev=digest;state=row["state"]
    return len(names),prev,state,root


def advance(folder,day,*,max_events=MAX_STEP_EVENTS,max_seconds=MAX_STEP_SECONDS):
    if (type(max_events) is not int or not 1<=max_events<=MAX_STEP_EVENTS
        or type(max_seconds) is not int or not 1<=max_seconds<=MAX_STEP_SECONDS):
        raise ValueError("Manual chunk exceeds bounded research resource budget")
    spool,spool_receipt,receipt=spool_evidence(folder,day)
    i,prev,state,root=checkpoints(folder,day)
    if state["done"]:
        return {"day":day,"status":"ALL_FIXED_QUOTES_ALREADY_REPLAYED",
                "events":state["events_read"],"can_trade":False}
    book,heaps=v23.heaps_from_book(state)
    tgts=shifted_targets(day)
    clock=time.monotonic()
    count=0
    with spool.open("rb") as stream:
        stream.seek(state["offset_bytes"])
        while count<max_events and time.monotonic()-clock<max_seconds:
            line=stream.readline(MAX_LINE_BYTES+1)
            if not line:
                state["source_eof"]=True;break
            if len(line)>MAX_LINE_BYTES or not line.strip():
                raise ValueError("Malformed historical book JSON line")
            ts=unpack_event(line)[0]
            if not day_ms(day)<=ts<day_ms(day)+86400000:
                raise ValueError("Original daily archive contains an event from wrong UTC day")
            v23.apply_one(state,book,heaps,line,tgts)
            state["offset_bytes"]=stream.tell()
            count+=1
            if state["done"]:break
    if state["source_eof"] and not state["done"]:
        for t in tgts[state["next_target_index"]:]:
            state["quotes"][str(t)]={"status":"UNAVAILABLE_NO_FUTURE_BRACKET"}
        state["next_target_index"]=len(tgts)
        state["done"]=True
    state["book"]={side:{str(p):str(q) for p,q in book[side].items()}
                   for side in ("bids","asks")}
    core={
        "schema":CHECKPOINT_SCHEMA,"day_utc":day,"index":i+1,
        "previous_sha256":prev,"configuration_sha256":config_sha(day),
        "state":state
    }
    digest=sha256(canonical(core))
    data={**core,"checkpoint_sha256":digest}
    with (root/f"checkpoint-{i+1:06d}.json").open("xb") as out:
        out.write(canonical(data)+b"\n")
    return {
        "day":day,
        "status":"ALL_PREDECLARED_QUOTE_TARGETS_REPLAYED" if state["done"] else
                 "FIXED_DAY_REPLAY_IN_PROGRESS",
        "processed_this_call":count,"events_processed":state["events_read"],
        "targets_completed":state["next_target_index"],
        "targets_total":len(tgts),
        "checkpoint":i+1,"latest_checkpoint_sha256":digest,
        "can_trade":False,
    }


def finalize(folder,day,output):
    out=Path(output)
    if out.exists():raise FileExistsError("Immutable v24 result already exists")
    spool,spool_receipt,receipt=spool_evidence(folder,day,rehash=True)
    i,digest,state,root=checkpoints(folder,day)
    anchors=shifted_anchors(day)
    tgts=shifted_targets(day)
    if not state["done"] or state["next_target_index"]!=len(tgts) or set(state["quotes"])!={str(t) for t in tgts}:
        raise ValueError("Historical source has not covered all preregistered quote targets")
    quotes=state["quotes"]
    results=[]
    for t in anchors:
        q_before=quotes[str(t-30000)]
        q_at=quotes[str(t)]
        for candidate in CANDIDATES:
            signal=v23.signal_at(q_before,q_at,candidate)
            for horizon in v23.HORIZONS:
                outcome=(
                    v23.observation(signal["direction"],q_at,quotes[str(t+horizon*1000)])
                    if signal["status"]=="ELIGIBLE" else
                    {"status":"NOT_EVALUATED_SOURCE_ABSTAIN"})
                results.append({
                    "anchor_exchange_utc_ms":t,
                    "candidate":candidate,
                    "horizon_s":horizon,
                    "signal":signal,
                    "outcome":outcome,
                })
    summaries=[v23.summarize(results,c,h)
               for c in CANDIDATES for h in v23.HORIZONS]
    record={
        "schema":SCHEMA,"status":"FROZEN_V23_FORMULA_REPLICATION_HISTORICAL_NOT_VALIDATED_ALPHA",
        "day_utc":day,"symbol":"NEAR-USDT-SWAP",
        "configuration":config(day),"configuration_sha256":config_sha(day),
        "original_archive_sha256":receipt["original_sha256"],
        "uncompressed_sha256":spool_receipt["uncompressed_sha256"],
        "archive_event_sequence_gaplessness_proven":state["seq_ids_available"] is True,
        "no_seq_ids_in_official_archive":state["seq_ids_available"] is not True,
        "events_replayed":state["events_read"],
        "snapshots_seen":state["full_snapshots"],
        "checkpoints":i,"last_checkpoint_sha256":digest,
        "targets_required":len(tgts),
        "targets_available":sum(q.get("status")=="AVAILABLE" for q in quotes.values()),
        "all_quotes_at_predeclared_targets":quotes,
        "anchor_candidate_horizon_rows":results,
        "candidate_horizon_summary":summaries,
        "same_v23_feature_and_scenario_functions":True,
        "all_horizons_registered_before_source_price_read":True,
        "is_independent_archive_day_from_v23":True,
        "days_are_adjacent_not_statistically_independent_market_regimes":True,
        "true_prospective_signal_prediction":False,
        "economic_costs_are_hypothetical_not_actual":True,
        "actual_fills_or_funding_verified":False,
        "realized_pnl":None,"counts_toward_validated_alpha":False,
        "can_trade":False,"can_start_paper":False,
    }
    with out.open("xb") as f:
        f.write(canonical(record)+b"\n")
    return {
        "day":day,"status":record["status"],
        "original_archive_sha256":receipt["original_sha256"],
        "events_replayed":state["events_read"],
        "targets_available":record["targets_available"],
        "eligible":{c:summaries[8*j]["signal_eligible_anchor_count"]
                    for j,c in enumerate(CANDIDATES)},
        "summary":[{
             "candidate":s["candidate"],"horizon_s":s["horizon_s"],
             "eligible":s["signal_eligible_anchor_count"],
             "evaluated":s["scored_with_archived_bid_ask"],
             "net_fee5_mean_bps":s["fee5_scenario"]["mean_bps"],
             "net_fee7_mean_bps":s["fee7_scenario"]["mean_bps"]
            } for s in summaries],
        "result_sha256":sha256(out.read_bytes()),
        "counts_toward_validated_alpha":False,"can_trade":False,
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day",required=True,choices=list(DAYS))
    parser.add_argument("--source-dir",required=True,type=Path)
    commands=parser.add_subparsers(dest="action",required=True)
    commands.add_parser("download")
    commands.add_parser("unpack")
    a=commands.add_parser("advance")
    a.add_argument("--max-events",type=int,default=MAX_STEP_EVENTS)
    a.add_argument("--max-seconds",type=int,default=MAX_STEP_SECONDS)
    f=commands.add_parser("finalize")
    f.add_argument("--out",required=True,type=Path)
    commands.add_parser("status")
    args=parser.parse_args()
    if args.action=="download":
        data=download(args.source_dir,args.day)
    elif args.action=="unpack":
        data=unpack(args.source_dir,args.day)
    elif args.action=="advance":
        data=advance(args.source_dir,args.day,max_events=args.max_events,
                     max_seconds=args.max_seconds)
    elif args.action=="finalize":
        data=finalize(args.source_dir,args.day,args.out)
    else:
        i,digest,state,root=checkpoints(args.source_dir,args.day)
        data={"day":args.day,"status":"ALL_PREDECLARED_QUOTE_TARGETS_REPLAYED"
              if state["done"] else "FIXED_DAY_REPLAY_IN_PROGRESS",
              "events_replayed":state["events_read"],
              "targets_completed":state["next_target_index"],
              "targets_total":len(shifted_targets(args.day)),
              "checkpoint_count":i,"can_trade":False}
    print(json.dumps(data,ensure_ascii=False,sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
