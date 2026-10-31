#!/usr/bin/env python3
"""v27 historical BTC/ETH/NEAR minute returns and NEAR hourly OI, post hoc.

Public read-only historical market endpoints. Every URL and anchor is frozen
in docs/trading/ALGORITHM-CROSSMARKET-CAUSES-PROTOCOL-v27-20261031.md.
NO market/books live query, live orders, PAPER or use of Sept05 holdout.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode
import urllib.request

from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_crossmarket_context_v27"
SAMPLES={
    "sep03_loss":"2026-09-03T08:45:00Z",
    "sep03_win":"2026-09-03T14:45:00Z",
    "sep04_loss":"2026-09-04T07:30:00Z",
    "sep04_win":"2026-09-04T19:15:00Z",
}
SYMBOLS=("NEAR-USDT-SWAP","BTC-USDT-SWAP","ETH-USDT-SWAP")
OFFSETS=(-30,-5,0,5,15,30,60)
FUTURE_HORIZONS=(5,15,30,60)
Oi_SYM="NEAR-USDT-SWAP"
MAX_BYTES=100_000
MAX_RESPONSE_SECONDS=12
DATE_LIMIT_MS=int(datetime(2026,9,5,tzinfo=timezone.utc).timestamp()*1000)
BASE="https://www.okx.com"
CANDLES="/api/v5/market/history-candles"
OI="/api/v5/rubik/stat/contracts/open-interest-history"
RAW_SCHEMA="algorithm_historical_rest_source_receipt_v27"


def ms(value):
    return int(datetime.fromisoformat(value.replace("Z","+00:00")).timestamp()*1000)


def expected_url(case,sym,kind):
    if case not in SAMPLES:
        raise ValueError("Unregistered event")
    t=ms(SAMPLES[case])
    if kind=="candles":
        if sym not in SYMBOLS:
            raise ValueError("Unregistered instrument")
        query=urlencode({
            "instId":sym,"bar":"1m",
            "after":str(t+65*60_000),"limit":"100",
        })
        return BASE+CANDLES+"?"+query
    if kind=="oi":
        if sym!=Oi_SYM:
            raise ValueError("Only NEAR history OI precommitted")
        query=urlencode({
            "instId":sym,"period":"1H",
            "end":str(t+120*60_000),"limit":"100",
        })
        return BASE+OI+"?"+query
    raise ValueError("Unregistered source kind")


def filenames(root,case,sym,kind):
    k=sym.replace("-","_")
    stem=f"{case}_{kind}_{k}"
    return Path(root)/(stem+".raw.json"),Path(root)/(stem+".receipt.json")


def validate_payload(data,case,sym,kind):
    if type(data) is not dict or data.get("code")!="0" or not isinstance(data.get("data"),list):
        raise ValueError("Historical REST source did not return valid data")
    rows=data["data"]
    if not rows:
        raise ValueError("No historical records from source")
    t=ms(SAMPLES[case])
    seen=set()
    for x in rows:
        if not isinstance(x,list) or len(x)<(9 if kind=="candles" else 4):
            raise ValueError("Unknown historical schema")
        stamp=int(x[0])
        if stamp in seen:
            raise ValueError("Duplicate time bucket")
        seen.add(stamp)
        if stamp>=DATE_LIMIT_MS or stamp>t+120*60_000 or stamp<ms("2026-08-30T00:00:00Z"):
            raise ValueError("History source outside authorised date/time scope")
        if kind=="candles":
            if datetime.fromtimestamp(stamp/1000,timezone.utc).date()!=datetime.fromtimestamp(t/1000,timezone.utc).date():
                raise ValueError("Candle archive crosses another calendar date")
            if stamp%60_000:
                raise ValueError("Invalid one-minute UTC candle")
            op,hi,lo,cl=(Decimal(z) for z in x[1:5])
            if not 0<lo<=min(op,cl)<=max(op,cl)<=hi:
                raise ValueError("Corrupt original OHLC")
            if str(x[8])!="1":
                raise ValueError("Historical 1minute candle not complete")
        elif stamp%3_600_000:
            raise ValueError("Hourly OI unexpectedly not at full UTC hour")
    return rows


def collect(root,case,sym,kind):
    url=expected_url(case,sym,kind)
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    rawpath,receiptpath=filenames(root,case,sym,kind)
    if rawpath.exists() or receiptpath.exists():
        raise FileExistsError("Original HTTP evidence already saved: do not retry/overwrite")
    req=urllib.request.Request(url,headers={
        "Accept":"application/json",
        "User-Agent":"AlgorithmDiscovery-v27-historical-public-evidence/1.0",
    })
    with urllib.request.urlopen(req,timeout=MAX_RESPONSE_SECONDS) as res:
        if res.status!=200 or res.geturl()!=url:
            raise ValueError("Unexpected redirect/status from official historical source")
        raw=res.read(MAX_BYTES+1)
        if not raw or len(raw)>MAX_BYTES:
            raise ValueError("Unexpected response length")
        headers={
            "status":res.status,"url":res.geturl(),
            "content_type":res.headers.get("Content-Type"),
            "content_length":res.headers.get("Content-Length"),
            "etag":res.headers.get("ETag"),
            "date":res.headers.get("Date"),
        }
    data=json.loads(raw)
    rows=validate_payload(data,case,sym,kind)
    record={
        "schema":RAW_SCHEMA,
        "case":case,"symbol":sym,"kind":kind,
        "source_url":url,
        "raw_response_sha256":hashlib.sha256(raw).hexdigest(),
        "raw_bytes":len(raw),
        "row_count":len(rows),
        "http_headers":headers,
        "original_response_is_exchange_signed":False,
        "original_signal_was_outcome_selected_before_this_study":True,
        "not_a_trading_signal":True,
    }
    # Avoid a partially written body being mistaken for fully verified source.
    with rawpath.open("xb") as f:f.write(raw)
    with receiptpath.open("xb") as f:f.write(canonical(record)+b"\n")
    return {
        "status":"HISTORICAL_SOURCE_CAPTURED",
        "case":case,"symbol":sym,"kind":kind,"rows":len(rows),
        "source_sha256":record["raw_response_sha256"],"url":url,
    }


def load_one(root,case,sym,kind):
    rawpath,receiptpath=filenames(root,case,sym,kind)
    if not rawpath.exists() or not receiptpath.exists():
        return None
    raw=rawpath.read_bytes()
    receipt=strictly_decode(receiptpath.read_bytes())
    if (receipt.get("schema")!=RAW_SCHEMA
        or receipt.get("case")!=case
        or receipt.get("symbol")!=sym
        or receipt.get("kind")!=kind
        or receipt.get("source_url")!=expected_url(case,sym,kind)
        or receipt.get("raw_response_sha256")!=sha256(raw)
        or receipt.get("row_count") is None
        or receipt.get("not_a_trading_signal") is not True):
        raise ValueError("Source provenance modified or wrong file")
    data=json.loads(raw)
    rows=validate_payload(data,case,sym,kind)
    if receipt["row_count"]!=len(rows):
        raise ValueError("Raw row count inconsistent with source receipt")
    return rows,receipt


def compute_returns(bars,case):
    t=ms(SAMPLES[case])
    m={int(x[0]):Decimal(x[4]) for x in bars}
    sampled={}
    for offset in OFFSETS:
        # Target is minute END, so use bar starting exactly one minute prior.
        # Future bar starting at target is strictly prohibited.
        expected=t+(offset-1)*60_000
        v=m.get(expected)
        sampled[str(offset)]=(
            {"completed_bar_start_utc_ms":expected,
             "close":str(v),"target_end_utc_ms":t+offset*60_000}
            if v is not None else None
        )
    if sampled["0"] is None:
        raise ValueError("Source does not cover original signal decision minute")
    pivot=Decimal(sampled["0"]["close"])
    ret={}
    for offset in OFFSETS:
        q=sampled[str(offset)]
        ret[str(offset)]=(
            str(Decimal(10000)*(Decimal(q["close"])/pivot-Decimal(1)))
            if q is not None else None
        )
    return {"sampled_exact_completed_minute_bars":sampled,"close_return_bps_vs_signal":ret}


def oi_diagnostic(rows,case):
    t=ms(SAMPLES[case])
    byhour={int(x[0]):{
        "snapshot_utc_ms":int(x[0]),
        "open_interest_contracts":str(Decimal(x[1])),
        "open_interest_coin":str(Decimal(x[2])),
        "open_interest_usd":str(Decimal(x[3])),
        "availability_at_exact_hour_unverified":True,
    } for x in rows}
    # Display hour BEFORE event, hour OF event, next two following hours.
    hour=(t//3600000)*3600000
    points=[hour-3600000,hour,hour+3600000,hour+7200000]
    frame=[byhour.get(x) for x in points]
    change={}
    for j in range(1,len(frame)):
        a=frame[j-1];b=frame[j]
        change[f"{j-1}_to_{j}"]=(
            str(Decimal(100)*(Decimal(b["open_interest_contracts"])/Decimal(a["open_interest_contracts"])-Decimal(1)))
            if a is not None and b is not None and Decimal(a["open_interest_contracts"])>0
            else None
        )
    return {
        "hourly_oi_points":frame,
        "adjacent_oi_changes_percent":change,
        "source_times_not_certified_publicly_available_at_signal":True,
        "cannot_disaggregate_new_positions_vs_short_liquidations":True,
    }


def summarize(root):
    root=Path(root)
    events=[]
    for case,when in SAMPLES.items():
        candle={}
        sourcehashes={}
        for sym in SYMBOLS:
            loaded=load_one(root,case,sym,"candles")
            if loaded is None:
                candle[sym]=None
            else:
                bars,rec=loaded
                candle[sym]=compute_returns(bars,case)
                sourcehashes[f"candles:{sym}"]=rec["raw_response_sha256"]
        oi=load_one(root,case,Oi_SYM,"oi")
        oi_data=None if oi is None else oi_diagnostic(oi[0],case)
        if oi is not None:
            sourcehashes["oi:NEAR-USDT-SWAP"]=oi[1]["raw_response_sha256"]
        comparison={}
        for offset in FUTURE_HORIZONS:
            a=candle.get("NEAR-USDT-SWAP")
            b=candle.get("BTC-USDT-SWAP")
            e=candle.get("ETH-USDT-SWAP")
            if a is None or b is None or e is None or any(
                x["close_return_bps_vs_signal"].get(str(offset)) is None for x in (a,b,e)
            ):
                comparison[str(offset)]={"status":"UNAVAILABLE_INCOMPLETE_EXACT_HISTORICAL_CANDLES"}
                continue
            near=Decimal(a["close_return_bps_vs_signal"][str(offset)])
            btc=Decimal(b["close_return_bps_vs_signal"][str(offset)])
            eth=Decimal(e["close_return_bps_vs_signal"][str(offset)])
            ctrl=(btc+eth)/Decimal(2)
            comparison[str(offset)]={
                "status":"HISTORICAL_CLOSE_TO_CLOSE_COMPARISON_ONLY",
                "near_return_bps":str(near),
                "btc_return_bps":str(btc),
                "eth_return_bps":str(eth),
                "equal_weight_btc_eth_control_bps":str(ctrl),
                "near_minus_equal_weight_control_bps":str(near-ctrl),
                "no_tradable_bid_ask_or_beta_regression_claim":True,
            }
        events.append({
            "case":case,"time_utc":when,
            "historical_same_venue_1m_candles":candle,
            "oi_data_or_unavailable":oi_data,
            "future_horizon_cross_market":comparison,
            "original_source_sha256":sourcehashes,
            "post_hoc_case_selection":True,
        })
    return {
        "schema":SCHEMA,
        "scope":"POST_HOC_SAME_MINUTE_CROSSMARKET_AND_HOURLY_OI_NO_CAUSAL_PROOF",
        "events":events,
        "source_candles_are_NOT_tradable_bid_ask_or_executed_fills":True,
        "hourly_OI_is_NOT_a_liquidation_feed":True,
        "historic_liquidation_report":"NO_AUTHENTICATED_COMPLETE_2026_SEPT03_SEPT04_NEAR_OKX_HISTORICAL_LIQUIDATIONS",
        "all_liquidation_causes_unverified":True,
        "sep05_original_holdout_not_read":True,
        "one_unretained_connectivity_probe_reissued_according_to_transparent_addendum":True,
        "independent_signal_validation":False,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir",type=Path,required=True)
    command=parser.add_subparsers(dest="action",required=True)
    cap=command.add_parser("collect")
    cap.add_argument("--case",choices=list(SAMPLES),required=True)
    cap.add_argument("--sym",choices=list(SYMBOLS),required=True)
    cap.add_argument("--kind",choices=("candles","oi"),required=True)
    analysis=command.add_parser("summarize")
    analysis.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    if args.action=="collect":
        r=collect(args.dir,args.case,args.sym,args.kind)
    else:
        if args.out.exists():
            raise FileExistsError("Immutable v27 full result already exists")
        r=summarize(args.dir)
        with args.out.open("xb") as f:
            f.write(canonical(r)+b"\n")
        r={
            "status":r["scope"],
            "result_sha256":sha256(args.out.read_bytes()),
            "compared_cases":[{
                "case":e["case"],
                "horizons":e["future_horizon_cross_market"],
                "hourly_oi_available":e["oi_data_or_unavailable"] is not None,
            } for e in r["events"]],
            "can_trade":False,
        }
    print(json.dumps(r,ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
