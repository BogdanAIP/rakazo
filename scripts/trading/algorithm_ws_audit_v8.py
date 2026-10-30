#!/usr/bin/env python3
"""Offline independent v8 WS source audit; fail closed on sequence or timing gaps.

Replays raw, hash-verified incrementally changed visible depth and public
single-fill taker trade stream. Quantities in CONTRACTS, not USDT; depth
reductions are NOT identified as executions vs cancellations; recovery is
only a quote-readdition proxy and not proven liquidity absorption.
"""
from __future__ import annotations
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import statistics

from algorithm_ws_capture_v8 import (
    SCHEMA as CAPTURE_SCHEMA, MAX_EVENTS, MAX_BYTES, MAX_PAYLOAD,
    OBSERVATION_SECONDS, parse_event, safe_symbol, BOOK_URL, TRADE_URL,
    CHANNELS,
)
SCHEMA="algorithm_ws_microstructure_audit_v8"


def strict_load(raw):
    def unique(pairs):
        d={}
        for k,v in pairs:
            if k in d:
                raise ValueError("Duplicate JSON key: "+k)
            d[k]=v
        return d
    def invalid(s):
        raise ValueError("Nonfinite JSON token "+s)
    return json.loads(raw,object_pairs_hook=unique,parse_constant=invalid)


def dec(x,positive=False,zero_allowed=False):
    if not isinstance(x,str) or not x:
        raise ValueError("Numeric source string required")
    try:
        y=Decimal(x)
    except InvalidOperation as exc:
        raise ValueError("Invalid decimal") from exc
    if not y.is_finite() or (y<0 if zero_allowed else y<=0 if positive else False):
        raise ValueError("Nonfinite or negative quantity")
    return y


def level_update(book_levels, payload, side, *, snapshot):
    if not isinstance(payload,list) or len(payload)>400:
        raise ValueError("Unbounded level payload")
    prev=None
    removed=added=Decimal(0)
    reductions=set()
    additions=set()
    for row in payload:
        if (not isinstance(row,list) or len(row)!=4 or
                not isinstance(row[3],str) or not row[3].isdigit()):
            raise ValueError("Malformed depth row")
        price=dec(row[0],positive=True)
        size=dec(row[1],zero_allowed=True)
        if prev is not None:
            if (side=="bids" and price>=prev) or (side=="asks" and price<=prev):
                raise ValueError("Wrong price order or duplicated depth level")
        prev=price
        old=book_levels.get(price,Decimal(0))
        if size==0:
            book_levels.pop(price,None)
        else:
            book_levels[price]=size
        if not snapshot:
            delta=size-old
            if delta>0:
                added+=delta
                additions.add(price)
            elif delta<0:
                removed-=delta
                reductions.add(price)
    return added,removed,additions,reductions


def verify_and_audit(folder):
    folder=Path(folder)
    mb=(folder/"manifest.json").read_bytes()
    if not 0<len(mb)<=100_000:
        raise ValueError("Missing/oversize manifest")
    manifest=strict_load(mb)
    if (manifest.get("schema")!=CAPTURE_SCHEMA
        or manifest.get("can_trade") is not False
        or manifest.get("can_start_paper") is not False
        or manifest.get("no_price_outcomes_queried") is not True
        or manifest.get("cross_stream_total_order_proven") is not False
        or manifest.get("stream_trade_exchange_gapless_proven") is not False
        or manifest.get("observation_seconds")!=OBSERVATION_SECONDS
        or manifest.get("source_urls")!={"book":BOOK_URL,"trade":TRADE_URL}
        or manifest.get("source_channels")!=CHANNELS
        or manifest.get("book_checksum_deprecated") is not True):
        raise ValueError("Unsupported source manifest")
    symbol=manifest["symbol"]
    safe_symbol(symbol)
    start,end=manifest["start_utc_ms"],manifest["end_utc_ms"]
    if type(start) is not int or type(end) is not int or not 7_000<=end-start<=10_000:
        raise ValueError("Invalid bounded observation time")
    payload=(folder/"messages.jsonl").read_bytes()
    if (not payload or len(payload)>MAX_BYTES*3
            or len(payload)!=manifest.get("messages_bytes")
            or hashlib.sha256(payload).hexdigest()!=manifest.get("messages_sha256")):
        raise ValueError("Raw WebSocket bytes corrupted")
    lines=payload.splitlines()
    if (len(lines)!=manifest.get("event_count")
            or not 1<=len(lines)<=MAX_EVENTS
            or sum(manifest.get("event_count_by_stream",{}).values())!=len(lines)):
        raise ValueError("WS frame count mismatch")
    levels={"bids":{},"asks":{}}
    sequence=None
    book_snapshot_seen=False
    source_count={"book":0,"trade":0}
    ack={"book":False,"trade":False}
    received_monotonic=None
    last_trade_ms=None
    ids=set()
    quote_added=quote_reduced=Decimal(0)
    quote_readd_events=0
    depleted={"bids":set(),"asks":set()}
    updates=keepalives=trades_count=0
    buys=sells=Decimal(0)
    book_spread=[]
    book_top_bid=[]
    book_top_ask=[]
    rejected=None
    for line in lines:
        if len(line)>MAX_PAYLOAD*2:
            raise ValueError("Oversized individual stored frame")
        event=strict_load(line)
        raw=event.get("raw")
        stream=event.get("source")
        if stream not in source_count or type(raw) is not str:
            raise ValueError("Invalid recorded source or text payload")
        if type(event.get("ordinal_source")) is not int or event["ordinal_source"]!=source_count[stream]:
            raise ValueError("Reordered source stream")
        source_count[stream]+=1
        blob=raw.encode("utf-8")
        if hashlib.sha256(blob).hexdigest()!=event.get("raw_sha256"):
            raise ValueError("WebSocket logical-message SHA mismatch")
        ms=event.get("received_complete_utc_ms")
        mono=event.get("received_monotonic_ns")
        if type(ms) is not int or type(mono) is not int or ms<=0 or mono<=0:
            raise ValueError("Bad receipt timestamps")
        if received_monotonic is not None and mono<received_monotonic:
            raise ValueError("Global append order not monotone")
        received_monotonic=mono
        parsed,kind=parse_event(stream,symbol,raw)
        if kind!=event.get("kind"):
            raise ValueError("Misclassified event")
        if kind=="ack":
            ack[stream]=True
            continue
        if kind=="notice":
            continue
        if not ack[stream]:
            # OKX can push trades before the subscribe ACK. Preserve them
            # in raw evidence, but never count them in the later synchronized
            # window. Data after window start without ACK remains invalid.
            if ms<start:
                continue
            rejected="UNACKNOWLEDGED_SOURCE"
            break
        if stream=="book":
            obj=parsed["data"][0]
            ts=int(obj.get("ts"))
            seq=obj.get("seqId");prev=obj.get("prevSeqId")
            if type(seq) is not int or type(prev) is not int:
                raise ValueError("Missing integer sequence fields")
            if ts>ms+1000 or ts<ms-120_000:
                rejected="STALE_OR_FUTURE_BOOK"
                break
            if kind=="snapshot":
                if book_snapshot_seen:
                    rejected="UNEXPECTED_SECOND_SNAPSHOT"
                    break
                if prev!=-1:
                    rejected="INVALID_SNAPSHOT_PREVSEQ"
                    break
                book_snapshot_seen=True
                levels={"bids":{},"asks":{}}
                for side in ("bids","asks"):
                    level_update(levels[side],obj.get(side),side,snapshot=True)
                sequence=seq
            else:
                if not book_snapshot_seen or prev!=sequence:
                    rejected="ORDERBOOK_SEQUENCE_GAP"
                    break
                if seq==sequence and (obj.get("asks") or obj.get("bids")):
                    rejected="NONEMPTY_REPEATED_SEQUENCE"
                    break
                if seq<sequence:
                    rejected="ORDERBOOK_SEQUENCE_RESET_WITHOUT_SNAPSHOT"
                    break
                if seq==sequence and not obj.get("asks") and not obj.get("bids"):
                    keepalives+=1
                else:
                    sequence=seq
                    for side in ("bids","asks"):
                        a,b,add_prices,reduce_prices=level_update(
                            levels[side],obj.get(side),side,snapshot=False)
                        if start<=ms<=end:
                            quote_added+=a
                            quote_reduced+=b
                            quote_readd_events+=len(add_prices&depleted[side])
                            depleted[side].update(reduce_prices)
                    if start<=ms<=end:
                        updates+=1
            if not levels["bids"] or not levels["asks"]:
                rejected="EMPTY_BOOK_SIDE"
                break
            best_bid=max(levels["bids"]);best_ask=min(levels["asks"])
            if best_bid>=best_ask:
                rejected="CROSSED_OR_LOCKED_BOOK"
                break
            if start<=ms<=end:
                book_spread.append((best_ask-best_bid)/((best_ask+best_bid)/2)*Decimal(10000))
                book_top_bid.append(sum((levels["bids"][p] for p in sorted(levels["bids"],reverse=True)[:5]),Decimal(0)))
                book_top_ask.append(sum((levels["asks"][p] for p in sorted(levels["asks"])[:5]),Decimal(0)))
        else:
            t=parsed["data"][0]
            if t.get("instId")!=symbol or t.get("side") not in ("buy","sell"):
                rejected="BAD_TRADE_IDENTITY"
                break
            tradeid=t.get("tradeId")
            if not isinstance(tradeid,str) or not tradeid.isdigit() or tradeid in ids:
                rejected="DUPLICATE_OR_MALFORMED_TRADE_ID"
                break
            ids.add(tradeid)
            trade_ms=int(t.get("ts"))
            if trade_ms>ms+1000 or trade_ms<ms-120_000:
                rejected="STALE_OR_FUTURE_TRADE"
                break
            if last_trade_ms is not None and trade_ms<last_trade_ms:
                rejected="TRADE_TIMESTAMP_REORDERED"
                break
            last_trade_ms=trade_ms
            volume=dec(t.get("sz"),positive=True)
            dec(t.get("px"),positive=True)
            if start<=ms<=end and start<=trade_ms<=end:
                trades_count+=1
                if t["side"]=="buy":
                    buys+=volume
                else:
                    sells+=volume
    if not all(ack.values()) or not book_snapshot_seen:
        rejected=rejected or "MISSING_ACK_OR_SNAPSHOT"
    if source_count!=manifest.get("event_count_by_stream"):
        if not rejected:
            raise ValueError("Source stream count missing")
    if not book_spread or updates<1 or trades_count<1:
        rejected=rejected or "INSUFFICIENT_FIXED_WINDOW_DATA"
    status="VERIFIED_FIXED_WINDOW" if rejected is None else rejected
    return {
        "schema":SCHEMA,
        "symbol":symbol,
        "capture_manifest_sha256":hashlib.sha256(mb).hexdigest(),
        "source_bytes_sha256":hashlib.sha256(payload).hexdigest(),
        "window_start_utc_ms":start,"window_end_utc_ms":end,
        "source_messages":len(lines),
        "validated_message_count":sum(source_count.values()),
        "book_updates_in_window":updates,
        "book_keepalives":keepalives,
        "book_sequence_continuous":rejected not in (
            "ORDERBOOK_SEQUENCE_GAP","ORDERBOOK_SEQUENCE_RESET_WITHOUT_SNAPSHOT",
            "NONEMPTY_REPEATED_SEQUENCE","INVALID_SNAPSHOT_PREVSEQ"),
        "taker_fills_in_fixed_window":trades_count,
        "taker_buy_contracts_in_window":str(buys),
        "taker_sell_contracts_in_window":str(sells),
        "taker_imbalance_fixed_window":str((buys-sells)/(buys+sells)) if buys+sells>0 else None,
        "displayed_quote_add_contracts":str(quote_added),
        "displayed_quote_reduction_contracts":str(quote_reduced),
        "readd_to_earlier_reduced_price_level_count":quote_readd_events,
        "spread_bps_last":str(book_spread[-1]) if book_spread else None,
        "top5_bid_contracts_last":str(book_top_bid[-1]) if book_top_bid else None,
        "top5_ask_contracts_last":str(book_top_ask[-1]) if book_top_ask else None,
        "status":status,
        "no_trading_action":True,
        "future_prices_seen":False,
        "contract_multiplier_not_applied":True,
        "book_reductions_cannot_be_attributed_to_fills_or_cancels":True,
        "trade_message_loss_detection_proven":False,
        "cross_stream_event_order_proven":False,
        "predictive_alpha_proven":False,
    }


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--capture",required=True,type=Path)
    cli.add_argument("--out",required=True,type=Path)
    args=cli.parse_args()
    if args.out.exists():
        raise FileExistsError("Never overwrite audited capture")
    report=verify_and_audit(args.capture)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf-8") as f:
        json.dump(report,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    print(json.dumps({"symbol":report["symbol"],"status":report["status"],
                      "messages":report["source_messages"],
                      "book_updates":report["book_updates_in_window"],
                      "taker_fills":report["taker_fills_in_fixed_window"],
                      "can_trade":False}))


if __name__=="__main__":
    main()
