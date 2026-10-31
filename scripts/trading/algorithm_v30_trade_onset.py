#!/usr/bin/env python3
"""v30 frozen source-only NEAR/SOL detector on independent OKX archive day labels.

Historical execution prints and confirmed minute closes ONLY. No L2 alignment
selection until independently replayed original book, no news used as feature.
Never orders, PAPER, live trading or an alpha-ready strategy.
"""
from __future__ import annotations
import argparse
import csv
from datetime import datetime,timezone
from decimal import Decimal as D
import hashlib
import io
import json
from pathlib import Path
import zipfile

import algorithm_onset_v29 as v29
from algorithm_v30_archive_acquire import DAYS,PRIMARIES,registered,digest
from algorithm_multiday_registry_v12 import canonical,sha256

SCHEMA="algorithm_independent_v30_tape_onset_case"
SYMS=("BTC-USDT-SWAP","ETH-USDT-SWAP")
CANDLE_FIELDS=["instrument_name","open","high","low","close","vol","vol_ccy","vol_quote","open_time","confirm"]
TRADE_FIELDS=["instrument_name","trade_id","side","price","size","created_time","source"]
CTRL_TIMES=((2,15),(3,15),(4,15),(5,15),(6,15),(7,15),(8,15),(14,15))
MAX_ZIP_MEMBER=128*1024*1024

def path(root,day,symbol,kind,*,locator=None):
    name,_=(locator or registered)(day,symbol,kind)
    return Path(root)/day/symbol/kind/name

def source_zip(root,day,symbol,kind,*,locator=None):
    p=path(root,day,symbol,kind,locator=locator)
    r=json.loads(Path(str(p)+".receipt.json").read_text(encoding="utf-8"))
    if (r.get("schema")!="algorithm_v30_original_source_receipt"
       or r.get("day_utc_plus8_label")!=day or r.get("symbol")!=symbol
       or r.get("kind")!=kind or r.get("original_bytes")!=p.stat().st_size
       or r.get("original_sha256")!=digest(p)):
        raise ValueError("Historical source/receipt mismatch")
    z=zipfile.ZipFile(p)
    expected=f"{symbol}-{kind}-{day}.csv"
    if z.namelist()!=[expected] or z.getinfo(expected).file_size>MAX_ZIP_MEMBER:
        raise ValueError("Historical original ZIP structure or bound invalid")
    return z,expected,r["original_sha256"]

def load_bars(root,day,symbol,*,locator=None):
    z,name,sha=source_zip(root,day,symbol,"candlesticks",locator=locator)
    bars={}
    with z.open(name) as binary:
        rd=csv.DictReader(io.TextIOWrapper(binary,encoding="utf-8-sig"))
        if rd.fieldnames!=CANDLE_FIELDS:raise ValueError("Official minute CSV columns invalid")
        prior=None
        for x in rd:
            stamp=int(x["open_time"])
            local=datetime.fromtimestamp((stamp+8*3600000)/1000,timezone.utc).date().isoformat()
            if (x["instrument_name"]!=symbol or x["confirm"]!="1" or local!=day
                or stamp%60000 or (prior is not None and stamp-prior!=60000)):
                raise ValueError("Official one-minute continuity/instrument invalid")
            op,hi,lo,cl=[D(x[key]) for key in ("open","high","low","close")]
            if not 0<lo<=min(op,cl)<=max(op,cl)<=hi:
                raise ValueError("Nonpositive or invalid minute OHLC")
            bars[stamp]=cl
            prior=stamp
    z.close()
    if len(bars)!=1440:raise ValueError("Daily official 1440 one-minute bars incomplete")
    return bars,sha

def load_trades(root,day,symbol,*,locator=None):
    z,name,sha=source_zip(root,day,symbol,"trades",locator=locator)
    data=[]
    prior=None
    seen=set()
    with z.open(name) as binary:
        rd=csv.DictReader(io.TextIOWrapper(binary,encoding="utf-8-sig"))
        if rd.fieldnames!=TRADE_FIELDS:raise ValueError("Official executed-taker CSV columns invalid")
        for x in rd:
            ms=int(x["created_time"])
            local=datetime.fromtimestamp((ms+8*3600000)/1000,timezone.utc).date().isoformat()
            if (x["instrument_name"]!=symbol or x["side"] not in ("buy","sell")
                or local!=day or (prior is not None and ms<prior)
                or x["trade_id"] in seen or D(x["price"])<=0):
                raise ValueError("Official taker trade source invalid")
            qty=D(x["size"])
            if qty<=0:raise ValueError("Zero/negative original execution contracts")
            prior=ms
            seen.add(x["trade_id"])
            data.append((ms,x["side"],qty))
    z.close()
    return data,sha

def cohort(day):
    return [v29.time_ms(day,2,0)+k*60000 for k in range(421)]+[
        v29.time_ms(day,14,0)+k*60000 for k in range(46)]

def signed_bps(a,b):
    return v29.bps(a,b)

def score(t,d,prices,symbol):
    keys=(symbol,)+SYMS
    start={k:prices[k].get(t-60000) for k in keys}
    if any(v is None or v<=0 for v in start.values()):
        return {"outcome":"UNSCORABLE","reason":"missing start OHLC"}
    trajectory=[]
    first=None
    for h in range(1,61):
        vals={k:prices[k].get(t+(h-1)*60000) for k in keys}
        if any(v is None for v in vals.values()):
            return {"outcome":"UNSCORABLE","reason":"missing future historical OHLC","h":h}
        asset=signed_bps(vals[symbol],start[symbol])
        b=signed_bps(vals["BTC-USDT-SWAP"],start["BTC-USDT-SWAP"])
        e=signed_bps(vals["ETH-USDT-SWAP"],start["ETH-USDT-SWAP"])
        market=(b+e)/D(2)
        aligned=D(d)*asset
        row={"h":h,"instrument_return_bps":str(asset),
             "market_equal_weight_BTC_ETH_return_bps":str(market),
             "instrument_excess_bps":str(asset-market),
             "signed_directional_return_bps":str(aligned)}
        trajectory.append(row)
        if first is None:
            if aligned>=100:first={"outcome":"FAVORABLE_FIRST","minute":h}
            elif aligned<=-100:first={"outcome":"ADVERSE_FIRST","minute":h}
    if first is None:first={"outcome":"CENSORED_60","minute":None}
    return {**first,"fixed_5_15_60":[trajectory[i-1] for i in (5,15,60)],
            "actual_historical_minute_closes_only_not_executable":True}

def build(root,day,symbol):
    if day not in DAYS or symbol not in PRIMARIES:raise ValueError("Unregistered v30 case")
    prices={}
    hashes={}
    for s in (symbol,)+SYMS:
        prices[s],hashes[f"candle_{s}"]=load_bars(root,day,s)
    trades,hashes["executed_trade_"+symbol]=load_trades(root,day,symbol)
    trade_stamps=[r[0] for r in trades]
    all_decisions=[]
    selected=[]
    next_open=-1
    for t in cohort(day):
        d=v29.detector_at(t,trades,trade_stamps,prices[symbol])
        if d["trigger_qualification"]=="QUALIFIED_WITHOUT_COOLDOWN":
            if t<next_open:
                d["cooldown_suppressed"]=True
                d["trigger_qualification"]="SUPPRESSED_DUPLICATE"
            else:
                d["event_selected_after_60minute_cooldown"]=True
                next_open=t+60*60000
                selected.append({
                    "decision_ms":t,"utc":v29.time_utc(t),"id":f"{symbol}-{day}-{v29.time_utc(t)[11:16]}",
                    "direction":d["direction"],"onset_kind":d["onset_kind"],
                    "executed_flow_fraction":d["taker_signed_flow_fraction"],
                    "flow_acceleration_ratio":d["taker_flow_volume_acceleration_ratio"],
                    "L2_group":"PENDING_ORIGINAL_BOOK_REPLAY",
                    "outcome_HINDSIGHT_ONLY":score(t,d["direction"],prices,symbol)
                })
        all_decisions.append(d)
    selected_ms={x["decision_ms"] for x in selected}
    control=[]
    for hour,minute in CTRL_TIMES:
        t=v29.time_ms(day,hour,minute)
        if t in selected_ms or any(0<=t-e["decision_ms"]<3600000 for e in selected):
            control.append({"utc":v29.time_utc(t),"status":"PREDECLARED_EXCLUDED_ONSET_OR_PRIOR_COOLDOWN"})
            continue
        now=v29.summarize_takers(trades,trade_stamps,t-60000,t)
        signed=now["signed_taker_fraction"]
        if signed is None or D(signed)==0:
            control.append({"utc":v29.time_utc(t),"status":"DIRECTION_UNAVAILABLE"})
        else:
            d=1 if D(signed)>0 else -1
            control.append({"utc":v29.time_utc(t),"status":"SCORED_NO_ONSET_CONTROL",
                            "pseudo_direction":d,"outcome_HINDSIGHT_ONLY":score(t,d,prices,symbol)})
    return {"schema":SCHEMA,"day_label_utc_plus8":day,"symbol":symbol,
            "pre_registered":True,"detector_unchanged_v29":True,
            "no_L2_or_news_in_tape_detector":True,
            "source_SHA256":hashes,"actual_trade_count":len(trades),
            "all_467_decision_minutes":all_decisions,
            "selected_onsets":selected,"negative_controls":control,
            "totals":{"decisions":len(all_decisions),
             "qualified_before_cooldown":sum(x["trigger_qualification"] in ("QUALIFIED_WITHOUT_COOLDOWN","SUPPRESSED_DUPLICATE") for x in all_decisions),
             "suppressed":sum(x["cooldown_suppressed"] for x in all_decisions),
             "first_onsets":len(selected),"muted":sum(x["onset_kind"]=="MUTED_PRICE_RESPONSE" for x in selected),
             "visible":sum(x["onset_kind"]=="VISIBLE_PRICE_RESPONSE" for x in selected)},
            "trading_ready":False}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--day",required=True)
    p.add_argument("--symbol",required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Immutable first-pass v30 output exists")
    obj=build(a.root,a.day,a.symbol)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    with a.out.open("xb") as f:f.write(canonical(obj)+b"\n")
    print(json.dumps({"day":a.day,"symbol":a.symbol,"totals":obj["totals"],
                      "first_onsets":[(e["utc"],e["direction"],e["outcome_HINDSIGHT_ONLY"]["outcome"]) for e in obj["selected_onsets"]],
                      "source_output_sha256":sha256(a.out.read_bytes())},ensure_ascii=False))
if __name__=="__main__":main()
