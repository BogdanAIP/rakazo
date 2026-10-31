#!/usr/bin/env python3
"""v25 POST-HOC L2 event driver diagnostics; NO causal inference or trading.

Analyses EXPLICIT outcome-selected winners AND negative contrast examples.
Uses authentic v24 one-day official OKX .data + original prior checkpoints;
replay state at every sampled as-of time is strictly before future bracket.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
from decimal import Decimal
import json
from pathlib import Path

import algorithm_independent_days_v24 as v24
import algorithm_temporal_response_v23 as v23
from algorithm_historical_l2_v16 import unpack_event
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_event_drivers_diagnostic_v25"
ROOT="event-drivers-v25"
SAMPLES=(
 ("2026-09-03","08:45","LOSS_CONTRAST"),
 ("2026-09-03","14:45","LARGEST_LONG_WIN"),
 ("2026-09-04","07:30","LOSS_CONTRAST"),
 ("2026-09-04","19:15","LARGEST_LONG_WIN"),
)
OFFSETS_S=(-300,-60,-30,-10,0,10,30,60,300,900,1800,3600)
UPDATE_WINDOWS=((-300,-30),(-30,0),(0,300),(300,3600))
MAX_AGE_MS=5000
MAX_EVENTS=400000
CANDIDATE="pressure_shock_without_mid_adaptation"


def signal_time(day,clock):
    hour,minute=map(int,clock.split(":"))
    return v24.day_ms(day)+(hour*60+minute)*60000


def quote(book,asof,target,bracket):
    if asof is None:
        return {"status":"NO_PRIOR_SNAPSHOT"}
    if target-asof<0:
        raise ValueError("Future exchange book state contaminates historical feature")
    if target-asof>MAX_AGE_MS:
        return {"status":"STALE_ASOF","age_ms":target-asof}
    if not 0<bracket-target<=MAX_AGE_MS:
        return {"status":"MISSING_NEAR_FUTURE_BRACKET","next_event_delay_ms":bracket-target}
    bids,asks=book["bids"],book["asks"]
    if not bids or not asks:
        return {"status":"NO_VALID_BOOK"}
    bp=max(bids);ap=min(asks)
    if not Decimal(0)<bp<ap:
        raise ValueError("Crossed original historical quote")
    mid=(bp+ap)/Decimal(2)
    b5=sum((bids[p] for p in sorted(bids,reverse=True)[:5]),Decimal(0))
    a5=sum((asks[p] for p in sorted(asks)[:5]),Decimal(0))
    return {
        "status":"AVAILABLE","target_utc_ms":target,
        "last_book_event_utc_ms":asof,"first_next_event_utc_ms":bracket,
        "quote_age_ms":target-asof,
        "bid":str(bp),"ask":str(ap),"mid":str(mid),
        "bid_top_size":str(bids[bp]),"ask_top_size":str(asks[ap]),
        "spread_bps":str((ap-bp)/mid*Decimal(10000)),
        "bid_top5_depth":str(b5),"ask_top5_depth":str(a5),
        "top5_depth_imbalance":str((b5-a5)/(b5+a5)) if b5+a5 else None,
    }


def empty_counter(first,last):
    return {
        "relative_start_s":first,"relative_end_s":last,
        "incremental_book_updates":0,"full_snapshot_resets":0,
        "bid_level_positive_size_change":Decimal(0),
        "bid_level_negative_size_change_magnitude":Decimal(0),
        "ask_level_positive_size_change":Decimal(0),
        "ask_level_negative_size_change_magnitude":Decimal(0),
        "bid_price_levels_touched":0,"ask_price_levels_touched":0
    }


def record_update(counters,ts,anchor,action,book,sides):
    idx=None
    delta=ts-anchor
    for i,(start,end) in enumerate(UPDATE_WINDOWS):
        if start*1000<=delta<end*1000:
            idx=i;break
    if idx is None:
        return
    c=counters[idx]
    if action=="snapshot":
        c["full_snapshot_resets"]+=1
        return
    c["incremental_book_updates"]+=1
    for side in ("bids","asks"):
        changed=0
        for price,qty in sides[side]:
            old=book[side].get(price,Decimal(0))
            diff=qty-old
            if diff>0:
                c[f"{'bid' if side=='bids' else 'ask'}_level_positive_size_change"]+=diff
            elif diff<0:
                c[f"{'bid' if side=='bids' else 'ask'}_level_negative_size_change_magnitude"]+=-diff
            if diff!=0:changed+=1
        c[f"{'bid' if side=='bids' else 'ask'}_price_levels_touched"]+=changed


def one_case(source_root,day,clock,kind):
    target=signal_time(day,clock)
    folder=Path(source_root)/f"NEAR-{day}"
    spool,meta,receipt=v24.spool_evidence(folder,day,rehash=True)
    # Verify the ENTIRE SHA chain before reading the prior checkpoint.
    total,last,current,cproot=v24.checkpoints(folder,day)
    baseline_cp=None
    baseline_index=0
    for n in range(1,total+1):
        r=strictly_decode((cproot/f"checkpoint-{n:06d}.json").read_bytes())
        s=r["state"];e=s["last_exchange_ts_ms"]
        if e is not None and e<target-300000:
            baseline_cp=r;baseline_index=n
        elif e is not None and e>=target-300000:
            break
    if baseline_cp is None:
        state=v23.new_state()
        anchor_digest="ORIGINAL_FILE_START"
    else:
        state=baseline_cp["state"]
        anchor_digest=baseline_cp["checkpoint_sha256"]
    books,heaps=v23.heaps_from_book(state)
    asof=state["last_book_asof_ms"]
    last_ts=state["last_exchange_ts_ms"]
    base_offset=state["offset_bytes"]
    offsets=[target+s*1000 for s in OFFSETS_S]
    snapshots=[]
    counters=[empty_counter(a,b) for a,b in UPDATE_WINDOWS]
    index=0
    processed=0
    with spool.open("rb") as file:
        file.seek(base_offset)
        while index<len(offsets):
            line=file.readline(1_000_001)
            if not line:
                raise ValueError("Original archive ended before expected event bracket")
            if len(line)>1_000_000 or not line.strip():
                raise ValueError("Malformed/oversized original exchange row")
            ts,action,seq,prev,sides,inst=unpack_event(line)
            processed+=1
            if processed>MAX_EVENTS:
                raise ValueError("Event-study source processing cap exceeded")
            if inst!="NEAR-USDT-SWAP" or (last_ts is not None and ts<last_ts):
                raise ValueError("Archive event instrument/chronology invalid")
            last_ts=ts
            while index<len(offsets) and ts>offsets[index]:
                snapshots.append({
                    "relative_seconds":OFFSETS_S[index],
                    **quote(books,asof,offsets[index],ts)
                })
                index+=1
            if index==len(offsets):
                break
            record_update(counters,ts,target,action,books,sides)
            v23.apply_levels(books,heaps,sides,action)
            v23.current_best(books,heaps)
            asof=ts
    for c in counters:
        for key in list(c):
            if isinstance(c[key],Decimal):c[key]=str(c[key])
    return {
        "date_utc":day,"signal_utc":datetime.fromtimestamp(target/1000,timezone.utc).isoformat(),
        "kind_of_posthoc_selection":kind,
        "original_archive_sha256":receipt["original_sha256"],
        "uncompressed_original_sha256":meta["uncompressed_sha256"],
        "prior_checkpoint_index":baseline_index,
        "prior_checkpoint_sha256":anchor_digest,
        "prior_checkpoint_was_earlier_than_minus5min":True,
        "original_events_examined_from_checkpoint":processed,
        "source_orderbook_snapshots_and_qty0_deletions_applied":True,
        "asof_book_quotes_at_all_fixed_relative_times":snapshots,
        "absolute_displayed_level_changes_NOT_executed_trade_volume":counters,
        "external_liquidation_or_news_cause_verified":False,
    }


def original_source_outcome(root,day,clock):
    p=v24.Path(root)/f"NEAR-{day}"/f"NEAR-{day}-frozen-v23-replication-v24.json"
    r=strictly_decode(p.read_bytes())
    anchor=signal_time(day,clock)
    row=[x for x in r["anchor_candidate_horizon_rows"]
         if x["anchor_exchange_utc_ms"]==anchor and x["candidate"]==CANDIDATE
         and x["horizon_s"]==3600]
    if len(row)!=1 or row[0]["signal"]["status"]!="ELIGIBLE":
        raise ValueError("Post-hoc selected case not genuine original v24 eligible signal")
    return {
        "direction":row[0]["signal"]["direction"],
        "net_hypothetical_60min_fee5bps_each_side":
            row[0]["outcome"]["net_fee5_each_side_bps"],
        "original_30s_imbalance_change":row[0]["signal"]["imbalance_change_in_30s"],
        "original_signal_utc_ms":anchor,
    }


def build(root):
    cases=[]
    for day,clock,kind in SAMPLES:
        data=one_case(root,day,clock,kind)
        data["original_frozen_v24_signal_and_hindsight_outcome"] = original_source_outcome(root,day,clock)
        cases.append(data)
    return {
        "schema":SCHEMA,
        "status":"POST_HOC_EVENT_ATTRIBUTION_HYPOTHESIS_GENERATION_ONLY",
        "source":"GENUINE_OFFICIAL_OKX_NEAR_400LV_L2_TWO_ALREADY_INSPECTED_DAYS",
        "cases_already_selected_using_v24_future_returns":True,
        "case_count":len(cases),
        "cases":cases,
        "all_liquidity_changes_are_DISPLAYED_ORDERBOOK_QUANTITY_not_executed_trades":True,
        "midprice_and_depth_observations_are_not_causal_explanations":True,
        "independent_news_liquidation_open_interest_trade_stream_not_in_source":True,
        "asof_quotes_never_use_future_book_values":True,
        "reserved_sep05_holdout_not_read":True,
        "proven_statistical_alpha":False,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--original-v24-root",type=Path,required=True)
    ap.add_argument("--out",type=Path,required=True)
    ar=ap.parse_args()
    if ar.out.exists():
        raise FileExistsError("v25 immutable diagnostic already exists")
    result=build(ar.original_v24_root)
    with ar.out.open("xb") as f:f.write(canonical(result)+b"\n")
    print(json.dumps({
        "status":result["status"],
        "source_cases":[{
            "signal_utc":x["signal_utc"],
            "original_60min_proxy_net_bps":x["original_frozen_v24_signal_and_hindsight_outcome"]["net_hypothetical_60min_fee5bps_each_side"],
            "snapshots":x["asof_book_quotes_at_all_fixed_relative_times"],
            "event_windows":x["absolute_displayed_level_changes_NOT_executed_trade_volume"]
        } for x in result["cases"]],
        "output_sha256":sha256(ar.out.read_bytes()),
        "can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
