#!/usr/bin/env python3
"""v8 one-second time bins from already hash/sequence-verified fixed-window WS.

All features are descriptive only; a change in displayed depth need not be
an execution or a cancel. Cross-connection event pairing is by LOCAL COMPLETE
receipt time, never an exchange-certified global matching-engine sequence.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from algorithm_ws_audit_v8 import (
    verify_and_audit, strict_load, level_update, dec,
)
from algorithm_ws_capture_v8 import parse_event

SCHEMA="algorithm_ws_microstructure_seconds_v8"
STEP=1000
N=8


def build_buckets(folder):
    folder=Path(folder)
    verified=verify_and_audit(folder)
    if verified["status"]!="VERIFIED_FIXED_WINDOW":
        raise ValueError("Reject unverified source before computing time buckets")
    mb=(folder/"manifest.json").read_bytes()
    manifest=strict_load(mb)
    start,end=manifest["start_utc_ms"],manifest["end_utc_ms"]
    if not 7990<=end-start<=8100:
        raise ValueError("Expected roughly eight seconds of observation")
    bins=[{"index":i,"start_utc_ms":start+i*STEP,
           "end_utc_ms":start+(i+1)*STEP,
           "buy_taker_contracts":Decimal(0),
           "sell_taker_contracts":Decimal(0),
           "fill_count":0,
           "book_update_count":0,
           "book_bid_added_contracts":Decimal(0),
           "book_bid_reduced_contracts":Decimal(0),
           "book_ask_added_contracts":Decimal(0),
           "book_ask_reduced_contracts":Decimal(0),
           "quote_readd_events":0,
           "book_bid_quote_readd_events":0,
           "book_ask_quote_readd_events":0,
           "book_end_asof_ms":None,
           "best_bid":None,"best_ask":None,
           "top5_bid_contracts":None,"top5_ask_contracts":None,
          } for i in range(N)]
    book={"bids":{},"asks":{}}
    last_book_ms=None
    prev_reduced={"bids":set(),"asks":set()}
    stream_acked={"book":False,"trade":False}
    for line in (folder/"messages.jsonl").read_bytes().splitlines():
        x=strict_load(line)
        ms=x["received_complete_utc_ms"]
        source=x["source"]
        obj,kind=parse_event(source,manifest["symbol"],x["raw"])
        if kind=="ack":
            stream_acked[source]=True
            continue
        if kind=="notice":
            continue
        if not stream_acked[source]:
            # A pre-ACK trade can have the SAME UTC millisecond as the
            # synchronized start; its source ordinal proves it was earlier.
            if ms<=start:
                continue
            raise ValueError("In-window frame before its subscription ACK")
        # The exact within-millisecond start order is unknowable. Include
        # the initial book snapshot for reconstruction, but not boundary
        # data in the measured source-second or trade-flow totals.
        in_range=start<ms<start+N*STEP
        b=(ms-start)//STEP if in_range else None
        if source=="book":
            data=obj["data"][0]
            if kind=="snapshot":
                book={"bids":{},"asks":{}}
            for side in ("bids","asks"):
                a,r,add_prices,reduced_prices=level_update(
                    book[side],data[side],side,snapshot=kind=="snapshot")
                if b is not None and kind=="update":
                    bins[b]["book_update_count"]+=int(side=="bids")
                    bins[b][f"book_{'bid' if side=='bids' else 'ask'}_added_contracts"]+=a
                    bins[b][f"book_{'bid' if side=='bids' else 'ask'}_reduced_contracts"]+=r
                    count_readded=len(add_prices&prev_reduced[side])
                    bins[b]["quote_readd_events"]+=count_readded
                    bins[b][f"book_{'bid' if side=='bids' else 'ask'}_quote_readd_events"]+=count_readded
                    prev_reduced[side].update(reduced_prices)
            if book["bids"] and book["asks"]:
                last_book_ms=ms
                if b is not None:
                    bids=sorted(book["bids"],reverse=True)
                    asks=sorted(book["asks"])
                    bins[b]["book_end_asof_ms"]=ms
                    bins[b]["best_bid"]=str(bids[0])
                    bins[b]["best_ask"]=str(asks[0])
                    bins[b]["top5_bid_contracts"]=str(sum((book["bids"][p] for p in bids[:5]),Decimal(0)))
                    bins[b]["top5_ask_contracts"]=str(sum((book["asks"][p] for p in asks[:5]),Decimal(0)))
        else:
            if b is None:
                continue
            row=obj["data"][0]
            exchange_ms=int(row["ts"])
            if exchange_ms<start or exchange_ms>=start+N*STEP:
                continue
            amount=dec(row["sz"],positive=True)
            bins[b][row["side"]+"_taker_contracts"]+=amount
            bins[b]["fill_count"]+=1
    for b in bins:
        if b["best_bid"] is not None:
            bid,ask=Decimal(b["best_bid"]),Decimal(b["best_ask"])
            b["last_book_imbalance"] = str(
                (Decimal(b["top5_bid_contracts"])-Decimal(b["top5_ask_contracts"]))/
                (Decimal(b["top5_bid_contracts"])+Decimal(b["top5_ask_contracts"])))
            b["last_spread_bps"]=str((ask-bid)/((ask+bid)/2)*10000)
        else:
            b["last_book_imbalance"]=None
            b["last_spread_bps"]=None
        buy,sell=b["buy_taker_contracts"],b["sell_taker_contracts"]
        b["taker_imbalance"]=str((buy-sell)/(buy+sell)) if buy+sell>0 else None
        b["status"]=("OBSERVED_BOTH" if b["book_update_count"]>0 and b["fill_count"]>0
                     else "ABSTAIN_INCOMPLETE_SECOND")
        for k,v in tuple(b.items()):
            if isinstance(v,Decimal):
                b[k]=str(v)
    return {
        "schema":SCHEMA,"symbol":manifest["symbol"],
        "source_manifest_sha256":verified["capture_manifest_sha256"],
        "source_messages_sha256":verified["source_bytes_sha256"],
        "window_start_utc_ms":start,"window_end_utc_ms":end,
        "one_second_bins":bins,
        "bins_with_both_streams":sum(x["status"]=="OBSERVED_BOTH" for x in bins),
        "quote_readd_is_proxy_not_proven_absorption":True,
        "trade_stream_gapless_not_certified":True,
        "no_execution_or_future_returns":True,
        "can_trade":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--capture",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("Do not overwrite a source-derived artifact")
    result=build_buckets(args.capture)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as f:
        json.dump(result,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    print(json.dumps({"symbol":result["symbol"],"bins_with_both":result["bins_with_both_streams"],
                      "bins_total":8,"can_trade":False}))


if __name__=="__main__":
    main()
