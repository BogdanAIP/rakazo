#!/usr/bin/env python3
"""v18 source-only independently verified 12s bid/trade coverage diagnostic."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from decimal import Decimal

from algorithm_ws_capture_v8 import (
    CHANNELS, BOOK_URL, TRADE_URL, SCHEMA as ORIGINAL_SCHEMA,
    parse_event, safe_symbol, MAX_BYTES, MAX_EVENTS, MAX_PAYLOAD
)
from algorithm_ws_audit_v8 import strict_load, level_update, dec
from algorithm_multiday_registry_v12 import canonical, sha256

SCHEMA="algorithm_ws_12s_source_coverage_v18"
N=12
STEP=1000


def analyze(folder, *, expected_seconds=N):
    # v21 adds a bounded 15-second diagnostic without changing the original
    # default 12-second auditor used by v18-v20 or its independent raw hashes.
    if type(expected_seconds) is not int or expected_seconds not in (12,15):
        raise ValueError("Unregistered source duration")
    folder=Path(folder)
    manifest_raw=(folder/"manifest.json").read_bytes()
    if not 0<len(manifest_raw)<=100_000:
        raise ValueError("Invalid manifest size")
    m=strict_load(manifest_raw)
    if (m.get("schema")!=ORIGINAL_SCHEMA or
        m.get("observation_seconds")!=expected_seconds or
        m.get("source_urls")!={"book":BOOK_URL,"trade":TRADE_URL}
        or m.get("source_channels")!=CHANNELS
        or m.get("can_trade") is not False
        or m.get("can_start_paper") is not False
        or m.get("no_price_outcomes_queried") is not True
        or m.get("stream_trade_exchange_gapless_proven") is not False
        or m.get("cross_stream_total_order_proven") is not False):
        raise ValueError("Wrong source protocol")
    symbol=m["symbol"]
    safe_symbol(symbol)
    start,end=m["start_utc_ms"],m["end_utc_ms"]
    if type(start) is not int or type(end) is not int or not expected_seconds*1000-100<=end-start<=expected_seconds*1000+200:
        raise ValueError("Capture duration outside prereg 12s range")
    raw=(folder/"messages.jsonl").read_bytes()
    if (not 0<len(raw)<=MAX_BYTES*3
        or len(raw)!=m.get("messages_bytes")
        or sha256(raw)!=m.get("messages_sha256")):
        raise ValueError("Original source bytes/sha mismatch")
    lines=raw.splitlines()
    if not 1<=len(lines)<=MAX_EVENTS or len(lines)!=m.get("event_count"):
        raise ValueError("Original source frame count mismatch")
    bins=[{"second":i,"book_updates":0,"taker_fills":0,
           "taker_buy_contracts":Decimal(0),
           "taker_sell_contracts":Decimal(0)} for i in range(expected_seconds)]
    levels={"bids":{},"asks":{}}
    stream_count={"book":0,"trade":0}
    stream_ack={"book":False,"trade":False}
    snapshot=False
    last_mono=None
    seq=None
    trades=set()
    prev_trade_exchange_ms=None
    for line in lines:
        if len(line)>MAX_PAYLOAD*2:
            raise ValueError("Source logical frame oversized")
        e=strict_load(line)
        src=e.get("source")
        if src not in stream_count or type(e.get("ordinal_source")) is not int or e["ordinal_source"]!=stream_count[src]:
            raise ValueError("Source ordinal mismatch")
        stream_count[src]+=1
        frame=e.get("raw")
        if type(frame) is not str or sha256(frame.encode("utf8"))!=e.get("raw_sha256"):
            raise ValueError("Source message SHA mismatch")
        mono=e.get("received_monotonic_ns")
        ms=e.get("received_complete_utc_ms")
        if type(mono) is not int or type(ms) is not int or mono<=0 or ms<=0:
            raise ValueError("Invalid source time")
        if last_mono is not None and mono<last_mono:
            raise ValueError("Source arrival chronology changed")
        last_mono=mono
        obj,kind=parse_event(src,symbol,frame)
        if kind!=e.get("kind"):
            raise ValueError("Wrong source event classification")
        if kind=="ack":
            stream_ack[src]=True
            continue
        if kind=="notice":
            continue
        if not stream_ack[src]:
            if ms<=start:
                continue
            raise ValueError("In-window data before ACK")
        b=(ms-start)//STEP if start<ms<start+expected_seconds*STEP else None
        if src=="book":
            data=obj["data"][0]
            timestamp=int(data["ts"])
            newseq=data["seqId"];prev=data["prevSeqId"]
            if type(newseq) is not int or type(prev) is not int or timestamp>ms+1000 or timestamp<ms-120000:
                raise ValueError("Invalid exchange book clock/sequence")
            if kind=="snapshot":
                if snapshot or prev!=-1:
                    raise ValueError("Second snapshot or bad initial sequence")
                snapshot=True
                levels={"bids":{},"asks":{}}
                for side in ("bids","asks"):
                    level_update(levels[side],data[side],side,snapshot=True)
                seq=newseq
            else:
                if not snapshot or prev!=seq or newseq<seq:
                    raise ValueError("Incremental orderbook sequence gap/reset")
                if newseq==seq and (data["bids"] or data["asks"]):
                    raise ValueError("Repeated nonempty sequence")
                if newseq>seq:
                    seq=newseq
                    for side in ("bids","asks"):
                        level_update(levels[side],data[side],side,snapshot=False)
                    if b is not None:
                        bins[b]["book_updates"]+=1
            if not levels["bids"] or not levels["asks"] or max(levels["bids"])>=min(levels["asks"]):
                raise ValueError("Malformed best quote")
        else:
            trade=obj["data"][0]
            if trade.get("instId")!=symbol or trade.get("side") not in ("buy","sell"):
                raise ValueError("Wrong individual trade identity")
            trade_id=trade.get("tradeId")
            if type(trade_id) is not str or not trade_id.isdigit() or trade_id in trades:
                raise ValueError("Duplicated or invalid tradeId")
            trades.add(trade_id)
            exchange_ms=int(trade["ts"])
            if exchange_ms>ms+1000 or exchange_ms<ms-120000:
                raise ValueError("Bad trade event clock")
            if prev_trade_exchange_ms is not None and exchange_ms<prev_trade_exchange_ms:
                raise ValueError("Reordered trades")
            prev_trade_exchange_ms=exchange_ms
            quantity=dec(trade["sz"],positive=True)
            dec(trade["px"],positive=True)
            if b is not None and start<=exchange_ms<end:
                bins[b]["taker_fills"]+=1
                bins[b]["taker_"+trade["side"]+"_contracts"]+=quantity
    if stream_count!=m.get("event_count_by_stream") or not all(stream_ack.values()) or not snapshot:
        raise ValueError("Missing source/subscriptions")
    for row in bins:
        book=row["book_updates"]>0
        trade=row["taker_fills"]>0
        row["availability"]=("BOTH" if book and trade else
                             "BOOK_ONLY" if book else
                             "TRADES_ONLY" if trade else "NEITHER")
        for key,val in tuple(row.items()):
            if isinstance(val,Decimal):
                row[key]=str(val)
    both=sum(b["availability"]=="BOTH" for b in bins)
    coverage=[{"eight_second_window_start":i,
               "joint_seconds":sum(b["availability"]=="BOTH" for b in bins[i:i+8]),
               "eligible_for_existing_6_of_8_quality_only":
                   sum(b["availability"]=="BOTH" for b in bins[i:i+8])>=6}
              for i in range(expected_seconds-7)]
    return {
        "schema":SCHEMA,"symbol":symbol,
        "source_folder":folder.name,
        "source_manifest_sha256":sha256(manifest_raw),
        "source_messages_sha256":sha256(raw),
        "capture_start_utc_ms":start,"capture_end_utc_ms":end,
        "recorded_original_messages":len(lines),
        "verified_incremental_books":True,
        "taker_gapless_stream_proven":False,
        "cross_feed_matching_engine_order_proven":False,
        "each_one_second":bins,
        "joint_seconds":both,"total_seconds":expected_seconds,
        "coverage_fraction":str(Decimal(both)/Decimal(expected_seconds)),
        "book_only_seconds":sum(b["availability"]=="BOOK_ONLY" for b in bins),
        "trades_only_seconds":sum(b["availability"]=="TRADES_ONLY" for b in bins),
        "neither_seconds":sum(b["availability"]=="NEITHER" for b in bins),
        "book_updates_total":sum(b["book_updates"] for b in bins),
        "received_valid_taker_fills_total":sum(b["taker_fills"] for b in bins),
        "predeclared_overlapping_eight_second_windows":coverage,
        "overlapping_windows_are_independent":False,
        "this_is_not_an_eight_second_prediction":True,
        "future_price_labels":None,"pnl":None,
        "scientific_verdict":"DATA_COVERAGE_ONLY_NOT_ALPHA",
        "can_trade":False,"can_start_paper":False
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():
        raise FileExistsError("Cannot overwrite source diagnostic")
    r=analyze(a.source)
    with a.out.open("xb") as f:
        f.write(canonical(r)+b"\n")
    print(json.dumps({"symbol":r["symbol"],
        "source_manifest_sha256":r["source_manifest_sha256"],
        "source_messages_sha256":r["source_messages_sha256"],
        "report_sha256":sha256(a.out.read_bytes()),
        "joint_seconds":r["joint_seconds"],
        "coverage_fraction":r["coverage_fraction"],
        "book_only_seconds":r["book_only_seconds"],
        "trades_only_seconds":r["trades_only_seconds"],
        "neither_seconds":r["neither_seconds"],
        "book_updates_total":r["book_updates_total"],
        "received_valid_taker_fills_total":r["received_valid_taker_fills_total"],
        "all_overlapping_window_joint_seconds":[x["joint_seconds"] for x in r["predeclared_overlapping_eight_second_windows"]],
        "scientific_verdict":r["scientific_verdict"],
        "can_trade":False},sort_keys=True))


if __name__=="__main__":
    main()
