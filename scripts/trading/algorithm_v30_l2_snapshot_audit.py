#!/usr/bin/env python3
"""v30 original OKX book asof from nearest prior full snapshot. Research only."""
from __future__ import annotations
import argparse,bisect,json,mmap
from decimal import Decimal as D
from pathlib import Path
from algorithm_v30_l2_replay import manifest,asof_original
from algorithm_v30_archive_acquire import digest
from algorithm_multiday_registry_v12 import canonical,sha256
from algorithm_historical_l2_v16 import unpack_event
from algorithm_l2_checkpoint_v22 import apply_levels,current_best,heaps_from_book

IDX_SCHEMA="v30_original_book_snapshot_index"
ROW_SCHEMA="v30_original_snapshot_pair_replay"
MAX_LINE_BYTES=5_000_000
MAX_ROWS_PER_EVENT=300000

def paths(root,day,sym):
    folder=Path(root)/"l2"
    return folder/f"{sym}-{day}-snapshot-index-v30.json",folder/f"{sym}-{day}"

def build_index(root,day,sym):
    original,spool,onset,receipt,onset_sha,events,targets=manifest(root,day,sym)
    output,folder=paths(root,day,sym)
    if output.exists():raise FileExistsError("Original source snapshot index immutable")
    snapshots=[]
    with spool.open("rb") as f:
        with mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as mm:
            needle=b'"action":"snapshot"'
            pos=0
            while True:
                hit=mm.find(needle,pos)
                if hit<0:break
                beg=mm.rfind(b"\n",0,hit)+1
                end=mm.find(b"\n",hit)
                if end<0 or end-beg+1>MAX_LINE_BYTES:
                    raise ValueError("Truncated original snapshot row")
                line=mm[beg:end+1]
                ts,act,seq,prev,sides,inst=unpack_event(line)
                if act!="snapshot" or inst!=sym or (snapshots and ts<snapshots[-1]["ts"]):
                    raise ValueError("Wrong original snapshot time or instrument")
                snapshots.append({"ts":ts,"offset":beg,"line_sha256":sha256(line)})
                pos=end+1
    if not snapshots:raise ValueError("No source snapshots")
    obj={"schema":IDX_SCHEMA,"day":day,"symbol":sym,
         "original_sha256":receipt["original_sha256"],"spool_sha256":digest(spool),
         "spool_bytes":spool.stat().st_size,"tape_sha256":onset_sha,
         "snapshot_entries":snapshots,"not_exchange_signed":True}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open("xb") as f:f.write(canonical(obj)+b"\n")
    return {"status":"INDEXED","day":day,"symbol":sym,"snapshots":len(snapshots),
            "index_sha256":digest(output)}

def event_one(root,day,sym,i):
    original,spool,onset,receipt,onset_sha,events,targets=manifest(root,day,sym)
    if i is None or i<0 or i>=len(events):raise ValueError("Unregistered event index")
    idxpath,folder=paths(root,day,sym)
    idx=json.loads(idxpath.read_bytes())
    if (idx["schema"]!=IDX_SCHEMA or idx["day"]!=day or idx["symbol"]!=sym
        or idx["original_sha256"]!=receipt["original_sha256"]
        or idx["tape_sha256"]!=onset_sha
        or idx["spool_bytes"]!=spool.stat().st_size):
        raise ValueError("Source data, original index and signals are not SHA-bound")
    event=events[i]
    targets=[event["decision_ms"]-60000,event["decision_ms"]]
    arr=idx["snapshot_entries"]
    nearest=bisect.bisect_right([a["ts"] for a in arr],targets[0])-1
    if nearest<0:raise ValueError("No full snapshot before the signal")
    snap=arr[nearest]
    book,heaps=heaps_from_book({"book":{"bids":{},"asks":{}}})
    last_ts=None
    last_asof=None
    last_seq=None
    seq_available=None
    snapshots=0
    quotes={}
    rows=0
    with spool.open("rb") as f:
        f.seek(snap["offset"])
        if sha256(f.readline(MAX_LINE_BYTES+1))!=snap["line_sha256"]:
            raise ValueError("Original source snapshot corrupted")
        f.seek(snap["offset"])
        while len(quotes)<2:
            line=f.readline(MAX_LINE_BYTES+1)
            if not line or len(line)>MAX_LINE_BYTES:raise ValueError("Original source truncated or row too large")
            ts,action,seq,prev,sides,inst=unpack_event(line)
            if inst!=sym or (last_ts is not None and ts<last_ts):
                raise ValueError("Original event-time/instrument discontinuity")
            for target in targets:
                if target not in quotes and ts>target:
                    quotes[target]=asof_original(book,heaps,last_asof,target,ts)
            if len(quotes)==2:break
            if action=="snapshot":
                snapshots+=1
                seq_available=seq is not None
                last_seq=seq
            elif snapshots==0:
                raise ValueError("Replay not anchored to full snapshot")
            elif seq_available:
                if seq is None or prev!=last_seq or seq<last_seq:
                    raise ValueError("Orderbook sequence gap")
                last_seq=seq
            elif seq is not None:
                raise ValueError("Unexpected sequence ID introduction")
            apply_levels(book,heaps,sides,action)
            current_best(book,heaps)
            last_asof=ts
            last_ts=ts
            rows+=1
            if rows>MAX_ROWS_PER_EVENT:
                raise ValueError("Unbounded L2 original source replay")
    p,q=(quotes[t] for t in targets)
    covered=p.get("status")=="AVAILABLE" and q.get("status")=="AVAILABLE"
    a=(D(event["direction"])*(D(q["original_top5_imbalance"])-D(p["original_top5_imbalance"]))
       if covered else None)
    mid=(D(10000)*(D(q["midquote"])/D(p["midquote"])-1) if covered else None)
    result={"schema":ROW_SCHEMA,"day":day,"symbol":sym,
            "event_index":i,"event_id":event["id"],"event_utc":event["utc"],
            "direction":event["direction"],"tape_sha256":onset_sha,
            "source_sha256":receipt["original_sha256"],
            "spool_sha256":idx["spool_sha256"],
            "snapshot_index_sha256":digest(idxpath),"preceding_source_snapshot":snap,
            "source_rows_replayed":rows,"seq_ids_observed":seq_available,
            "continuity_fully_certified":bool(seq_available),
            "original_tminus60_book":p,"original_t_book":q,
            "both_asof_available":covered,
            "signed_depth_alignment":str(a) if a is not None else None,
            "group":("ALIGNED" if a>0 else "UNALIGNED") if a is not None else "L2_UNAVAILABLE",
            "midquote_change_bps":str(mid) if mid is not None else None,
            "historical_event_time_is_not_network_arrival":True}
    target=folder/f"event-{i:02d}.json"
    if target.exists():raise FileExistsError("Immutable source-onset replay already exists")
    target.parent.mkdir(parents=True,exist_ok=True)
    with target.open("xb") as f:f.write(canonical(result)+b"\n")
    return {"day":day,"symbol":sym,"index":i,"utc":event["utc"],"rows":rows,
            "group":result["group"],"available":covered,"mid_bps":result["midquote_change_bps"],
            "seq":seq_available,"sha256":digest(target)}

def consolidate(root,day,sym):
    original,spool,onset,receipt,onset_sha,events,targets=manifest(root,day,sym)
    idxpath,folder=paths(root,day,sym)
    idx=json.loads(idxpath.read_bytes())
    if idx["spool_sha256"]!=digest(spool):
        raise ValueError("Source spool SHA changed since original index")
    table=[]
    for i,e in enumerate(events):
        p=folder/f"event-{i:02d}.json"
        d=json.loads(p.read_bytes())
        if (d["schema"]!=ROW_SCHEMA or d["event_index"]!=i or d["event_id"]!=e["id"]
            or d["tape_sha256"]!=onset_sha or d["source_sha256"]!=receipt["original_sha256"]
            or d["snapshot_index_sha256"]!=digest(idxpath)):
            raise ValueError("Source case/event SHA mismatch")
        table.append({"id":e["id"],"utc":e["utc"],"group":d["group"],
                      "alignment":d["signed_depth_alignment"],
                      "mid_bps":d["midquote_change_bps"],
                      "original_book_sha256":digest(p),
                      "future_first_passage":e["outcome_HINDSIGHT_ONLY"]["outcome"],
                      "first_passage_minute":e["outcome_HINDSIGHT_ONLY"].get("minute")})
    result={"schema":"algorithm_v30_book_alignment_outcome_join",
            "day":day,"symbol":sym,"original_tape_sha256":onset_sha,
            "original_book_sha256":receipt["original_sha256"],
            "original_uncompressed_sha256":idx["spool_sha256"],
            "index_sha256":digest(idxpath),"events":table,
            "sequence_unverified_if_no_original_ids":True,"trading_ready":False}
    out=Path(root)/"l2"/f"{sym}-{day}-joined-v30.json"
    if out.exists():raise FileExistsError("Original joined output already exists")
    with out.open("xb") as f:f.write(canonical(result)+b"\n")
    return {"day":day,"symbol":sym,"total":len(table),
            "aligned":sum(r["group"]=="ALIGNED" for r in table),
            "unaligned":sum(r["group"]=="UNALIGNED" for r in table),
            "unavailable":sum(r["group"]=="L2_UNAVAILABLE" for r in table),
            "result_sha256":digest(out),"cases":table}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("operation",choices=("index","event","join"))
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--day",required=True)
    p.add_argument("--symbol",required=True)
    p.add_argument("--index",type=int)
    a=p.parse_args()
    fn={"index":lambda:build_index(a.root,a.day,a.symbol),
        "event":lambda:event_one(a.root,a.day,a.symbol,a.index),
        "join":lambda:consolidate(a.root,a.day,a.symbol)}
    print(json.dumps(fn[a.operation](),ensure_ascii=False,sort_keys=True))
if __name__=="__main__":main()
