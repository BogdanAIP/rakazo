#!/usr/bin/env python3
"""Manual, bounded OKX microstructure evidence. PUBLIC READ ONLY.

Fetch five-ladder-level order books + latest 100 taker-side trades, preserving
raw replies and COMPLETE response receipts. Observations are NOT atomic,
historical trade WINDOW LENGTH VARIES, book depth can be canceled, and neither
alone proves smart money/replenishment/liquidation/forecastable prices.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

from algorithm_pit_capture_v5 import strict_json, epoch_ms, finite_decimal

SCHEMA = "algorithm_microstructure_raw_v7"
UNIVERSE_SCHEMA = "algorithm_pit_universe_v5"
ROOT="https://www.okx.com/api/v5/"
BOOK=ROOT+"market/books"
TRADES=ROOT+"market/trades"
TIME=ROOT+"public/time"
SYMBOL=re.compile(r"[A-Z0-9]{2,20}-USDT-SWAP\Z")
MAX_PAYLOAD=65_536
MAX_SPAN_MS=20_000
MAX_BOOK_AGE_MS=10_000
MAX_NEWEST_TRADE_AGE_MS=30_000
MIN_TRADES_FOR_DESCRIPTIVE=10


def book_url(symbol):
    if not isinstance(symbol,str) or not SYMBOL.fullmatch(symbol):
        raise ValueError("Invalid swap symbol")
    return f"{BOOK}?instId={symbol}&sz=5"


def trade_url(symbol):
    if not isinstance(symbol,str) or not SYMBOL.fullmatch(symbol):
        raise ValueError("Invalid swap symbol")
    return f"{TRADES}?instId={symbol}&limit=100"


def read_public(url):
    if not (url==TIME or re.fullmatch(
            re.escape(BOOK)+r"\?instId=[A-Z0-9]{2,20}-USDT-SWAP&sz=5",url)
            or re.fullmatch(
            re.escape(TRADES)+r"\?instId=[A-Z0-9]{2,20}-USDT-SWAP&limit=100",url)):
        raise ValueError("Only fixed public, no account/order URLs")
    with urlopen(Request(url,headers={"Accept":"application/json",
                     "User-Agent":"Rakazo-microstructure-v7-readonly/1"}),
                 timeout=8) as reply:
        if reply.status != 200:
            raise ValueError("Non-200 OKX public reply")
        raw=reply.read(MAX_PAYLOAD+1)
    if not 0<len(raw)<=MAX_PAYLOAD:
        raise ValueError("Unbounded reply")
    return raw


def api_rows(raw, *, singleton):
    data=strict_json(raw)
    if (not isinstance(data,dict) or data.get("code")!="0"
            or not isinstance(data.get("data"),list) or
            (singleton and len(data["data"])!=1)):
        raise ValueError("Invalid public OKX response")
    return data["data"]


def analyze_book(raw, received_ms):
    rows=api_rows(raw,singleton=True)
    x=rows[0]
    if not isinstance(x,dict) or type(x.get("seqId")) is not int:
        raise ValueError("Missing book sequence ID")
    ts=epoch_ms(x.get("ts"))
    if ts > received_ms+1000:
        raise ValueError("Future order book update")
    sides={}
    for side in ("bids","asks"):
        levels=x.get(side)
        if not isinstance(levels,list) or len(levels)!=5:
            raise ValueError("Incomplete five-level order book")
        values=[];prev=None
        for level in levels:
            if not isinstance(level,list) or len(level)!=4:
                raise ValueError("Wrong book level")
            price=finite_decimal(level[0])
            qty=finite_decimal(level[1])
            if price<=0 or qty<=0:
                raise ValueError("Nonpositive price or displayed size")
            if prev is not None and (price>=prev if side=="bids" else price<=prev):
                raise ValueError("Unordered or duplicate book prices")
            prev=price
            if level[2]!="0" or not re.fullmatch(r"[1-9]\d*",level[3]):
                raise ValueError("Invalid standard book level counters")
            values.append((price,qty))
        sides[side]=values
    bid,ask=sides["bids"][0][0],sides["asks"][0][0]
    if bid>=ask:
        raise ValueError("Crossed book is not a valid ordinary-market snapshot")
    bid_depth=sum((x[1] for x in sides["bids"]),Decimal(0))
    ask_depth=sum((x[1] for x in sides["asks"]),Decimal(0))
    if bid_depth+ask_depth<=0:
        raise ValueError("No book depth")
    imbalance=(bid_depth-ask_depth)/(bid_depth+ask_depth)
    spread_bps=(ask-bid)/((ask+bid)/2)*Decimal(10000)
    return {"exchange_generation_ms":ts,"sequence_id":x["seqId"],
            "best_bid":str(bid),"best_ask":str(ask),
            "spread_bps":str(spread_bps),
            "top5_bid_contracts":str(bid_depth),
            "top5_ask_contracts":str(ask_depth),
            "top5_depth_imbalance":str(imbalance),
            "stale":received_ms-ts>MAX_BOOK_AGE_MS,
            "level_count_each_side":5,
            "rpi_depth_included":False}


def analyze_trades(raw, symbol, received_ms):
    rows=api_rows(raw,singleton=False)
    if not 1<=len(rows)<=100:
        raise ValueError("Empty or oversized recent trade sample")
    seen_ids=set();last_time=None
    buy=sell=Decimal(0)
    for x in rows:
        if not isinstance(x,dict) or x.get("instId")!=symbol:
            raise ValueError("Wrong trade instrument")
        tradeid=x.get("tradeId")
        if not isinstance(tradeid,str) or not re.fullmatch(r"\d{1,24}",tradeid):
            raise ValueError("Malformed trade ID")
        identifier=int(tradeid)
        ts=epoch_ms(x.get("ts"))
        if identifier in seen_ids:
            raise ValueError("Duplicate trade IDs")
        seen_ids.add(identifier)
        if last_time is not None and ts>last_time:
            raise ValueError("Nonchronological trade timestamps")
        if ts>received_ms+1000:
            raise ValueError("Future trade")
        last_time=ts
        side=x.get("side")
        if side not in ("buy","sell") or x.get("source") not in ("0","1"):
            raise ValueError("Unknown taker-side/source")
        qty=finite_decimal(x.get("sz"))
        price=finite_decimal(x.get("px"))
        if qty<=0 or price<=0:
            raise ValueError("Invalid trade price or contract quantity")
        if side=="buy":
            buy+=qty
        else:
            sell+=qty
    newest=epoch_ms(rows[0]["ts"])
    oldest=epoch_ms(rows[-1]["ts"])
    return {
        "trade_count":len(rows),
        "newest_trade_time_ms":newest,
        "oldest_trade_time_ms":oldest,
        "sample_span_ms":newest-oldest,
        "newest_trade_id":rows[0]["tradeId"],
        "oldest_trade_id":rows[-1]["tradeId"],
        "buy_taker_contracts":str(buy),
        "sell_taker_contracts":str(sell),
        "last100_taker_imbalance":str((buy-sell)/(buy+sell)),
        "newest_trade_stale":received_ms-newest>MAX_NEWEST_TRADE_AGE_MS,
        "only_truncated_last100_not_interval_complete":True,
        "sample_at_least_ten":len(rows)>=MIN_TRADES_FOR_DESCRIPTIVE,
    }


def frozen_universe(path):
    b=Path(path).read_bytes()
    x=strict_json(b)
    if (x.get("schema")!=UNIVERSE_SCHEMA or x.get("market_count")!=50
            or x.get("historical_point_in_time_membership_verified") is not False
            or x.get("trading_approved") is not False
            or len(x.get("members",[]))!=50):
        raise ValueError("Unknown frozen market membership")
    rows=x["members"]
    if (len({r["symbol"] for r in rows})!=50
            or any(type(r["rank"]) is not int or r["rank"]!=i+1
                   or not SYMBOL.fullmatch(r["symbol"]) for i,r in enumerate(rows))):
        raise ValueError("Invalid universe ranking")
    return x,hashlib.sha256(b).hexdigest()


def capture(universe, universe_sha, batch, *, read=read_public, clock=None):
    if type(batch) is not int or not 1<=batch<=10:
        raise ValueError("Only one five-symbol batch per invocation")
    clock=clock or (lambda: time.time_ns()//1_000_000)
    symbols=[r["symbol"] for r in universe["members"][(batch-1)*5:batch*5]]
    evidence=[]
    def take(kind,symbol,url):
        sent=clock()
        raw=read(url)
        received=clock()
        if type(sent) is not int or type(received) is not int or not 0<=received-sent<=MAX_SPAN_MS:
            raise ValueError("Invalid HTTP send/receipt times")
        if kind=="time":
            row=api_rows(raw,singleton=True)[0]
            exchange_ms=epoch_ms(row.get("ts"))
            if abs(exchange_ms-received)>60_000:
                raise ValueError("Local/exchange clock discrepancy")
            features={"exchange_time_ms":exchange_ms}
        elif kind=="book":
            features=analyze_book(raw,received)
        else:
            features=analyze_trades(raw,symbol,received)
        metadata={"kind":kind,"symbol":symbol,"url":url,
                  "sent_ms":sent,"received_ms":received,
                  "available_not_before_ms":received,
                  "raw_file":f"{len(evidence):02d}-{kind}-{symbol or 'server'}.json",
                  "sha256":hashlib.sha256(raw).hexdigest(),
                  "observed":features}
        evidence.append((metadata,raw))
    take("time",None,TIME)
    for sym in symbols:
        take("book",sym,book_url(sym))
        take("trades",sym,trade_url(sym))
    take("time",None,TIME)
    return {"schema":SCHEMA,"batch":batch,"symbols":symbols,
            "universe_sha256":universe_sha,
            "observations_are_not_atomic":True,
            "trade_sample_is_last100_not_fixed_time_window":True,
            "book_is_top5_not_orderflow_history":True,
            "trading_approved":False,"allow_paper":False,
            "records":[e for e,_ in evidence]},evidence



def joint_asof(manifest, symbol, decision_ms):
    """Descriptive non-atomic joint evidence; refuse future/stale fields.

    Never an execution direction. A last-100-trades sample is NOT a complete
    time-bucket flow and is not cross-market time-normalized.
    """
    if type(decision_ms) is not int or decision_ms<=0:
        raise ValueError("UTC decision ms required")
    if symbol not in manifest.get("symbols",[]):
        raise ValueError("Unlisted instrument")
    books=[r for r in manifest["records"] if r["kind"]=="book" and r["symbol"]==symbol]
    trades=[r for r in manifest["records"] if r["kind"]=="trades" and r["symbol"]==symbol]
    if len(books)!=1 or len(trades)!=1:
        raise ValueError("Incomplete evidence")
    b,t=books[0],trades[0]
    last=max(b["received_ms"],t["received_ms"])
    first=min(b["received_ms"],t["received_ms"])
    if decision_ms<last:
        return {"status":"ABSTAIN_UNRECEIVED","observation":None}
    if decision_ms-first>60_000:
        return {"status":"ABSTAIN_STALE","observation":None}
    if (b["observed"]["stale"] or t["observed"]["newest_trade_stale"]
            or not t["observed"]["sample_at_least_ten"]
            or last-first>10_000):
        return {"status":"ABSTAIN_SOURCE_QUALITY","observation":None}
    return {
        "status":"DESCRIPTIVE_ONLY",
        "observation":{
            "book_imbalance":b["observed"]["top5_depth_imbalance"],
            "taker_last100_imbalance":t["observed"]["last100_taker_imbalance"],
            "spread_bps":b["observed"]["spread_bps"],
            "sample_span_ms":t["observed"]["sample_span_ms"],
            "asof_not_before_ms":last,
            "taker_sample_window_is_not_fixed":True,
            "live_trade_or_paper_action":None,
        },
    }


def save(path,manifest,evidence):
    p=Path(path)
    if p.exists():
        raise FileExistsError("Evidence must not be overwritten")
    if not p.parent.is_dir():
        raise FileNotFoundError("Existing parent directory required")
    p.mkdir()
    for item,raw in evidence:
        (p/item["raw_file"]).write_bytes(raw)
    (p/"manifest.json").write_bytes(
        (json.dumps(manifest,indent=2,sort_keys=True,allow_nan=False)+"\n").encode("utf8"))
    return hashlib.sha256((p/"manifest.json").read_bytes()).hexdigest()


def verify(path,universe,universe_sha,batch):
    p=Path(path)
    raw=(p/"manifest.json").read_bytes()
    meta=strict_json(raw)
    symbols=[r["symbol"] for r in universe["members"][(batch-1)*5:batch*5]]
    expected=[("time",None)]+[(kind,sym) for sym in symbols for kind in ("book","trades")]+[("time",None)]
    if (meta.get("schema")!=SCHEMA or meta.get("batch")!=batch
            or meta.get("symbols")!=symbols or meta.get("universe_sha256")!=universe_sha
            or meta.get("trading_approved") is not False
            or meta.get("allow_paper") is not False
            or meta.get("observations_are_not_atomic") is not True
            or meta.get("trade_sample_is_last100_not_fixed_time_window") is not True
            or len(meta.get("records",[]))!=12):
        raise ValueError("Invalid source evidence manifest")
    last=None
    for i,(record,(kind,symbol)) in enumerate(zip(meta["records"],expected)):
        url=TIME if kind=="time" else book_url(symbol) if kind=="book" else trade_url(symbol)
        if (record.get("kind")!=kind or record.get("symbol")!=symbol
                or record.get("url")!=url
                or record.get("raw_file")!=f"{i:02d}-{kind}-{symbol or 'server'}.json"):
            raise ValueError("Evidence source identity mismatch")
        sent,received=record["sent_ms"],record["received_ms"]
        if (type(sent) is not int or type(received) is not int
                or not 0<=received-sent<=MAX_SPAN_MS
                or record.get("available_not_before_ms")!=received
                or last is not None and sent<last):
            raise ValueError("Nonchronological evidence")
        last=received
        payload=(p/record["raw_file"]).read_bytes()
        if hashlib.sha256(payload).hexdigest()!=record["sha256"]:
            raise ValueError("Tampered raw source payload")
        if kind=="time":
            t=epoch_ms(api_rows(payload,singleton=True)[0].get("ts"))
            if abs(t-received)>60_000:
                raise ValueError("Source clock out of sync")
            parsed={"exchange_time_ms":t}
        else:
            parsed=(analyze_book(payload,received) if kind=="book"
                    else analyze_trades(payload,symbol,received))
        if parsed != record["observed"]:
            raise ValueError("Raw features do not match manifest")
    return meta,hashlib.sha256(raw).hexdigest()


def main():
    a=argparse.ArgumentParser(description=__doc__)
    a.add_argument("--universe",required=True,type=Path)
    a.add_argument("--batch",required=True,type=int)
    a.add_argument("--out-dir",required=True,type=Path)
    args=a.parse_args()
    if args.out_dir.exists():
        raise FileExistsError("Refuse overwriting observation")
    universe,sha=frozen_universe(args.universe)
    manifest,rows=capture(universe,sha,args.batch)
    digest=save(args.out_dir,manifest,rows)
    verify(args.out_dir,universe,sha,args.batch)
    print(json.dumps({"batch":args.batch,"count":len(manifest["symbols"]),
                      "reply_count":len(rows),"manifest_sha256":digest,
                      "no_price_outcomes_scored":True,"can_trade":False}))


if __name__=="__main__":
    main()
