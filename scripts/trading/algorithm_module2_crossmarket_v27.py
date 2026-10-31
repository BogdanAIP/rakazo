#!/usr/bin/env python3
"""v27 OFFLINE causal-diagnostic market controls via genuine OKX module2 minute CSV.

Three previously outcome-selected event windows; 4th intentionally skipped
because module2 UTC+8 Sep05 would overlap reserved Sep05 UTC holdout.
Candle CLOSE is NOT an executable bid/ask. No alpha or trading orders.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime,timezone
from decimal import Decimal
import json
from pathlib import Path
import io

from algorithm_crossmarket_v27 import (
    SAMPLES,SYMBOLS,OFFSETS,FUTURE_HORIZONS,ms,
    load_one,oi_diagnostic,compute_returns
)
from algorithm_module2_archive_v27 import open_verified
from algorithm_multiday_registry_v12 import canonical,sha256

SCHEMA="algorithm_official_module2_crossmarket_eval_v27"
COVERED={
    "sep03_loss":"2026-09-03",
    "sep03_win":"2026-09-03",
    "sep04_loss":"2026-09-04",
}
UNAVAILABLE="sep04_win"
CSV_FIELDS=[
    "instrument_name","open","high","low","close",
    "vol","vol_ccy","vol_quote","open_time","confirm"
]


def archive_bars(folder,day,symbol):
    data,member,receipt=open_verified(folder,day,symbol)
    if member!=f"{symbol}-candlesticks-{day}.csv":
        raise ValueError("Unexpected module2 ZIP CSV member")
    reader=csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    if reader.fieldnames!=CSV_FIELDS:
        raise ValueError("Incorrect original official 1m CSV schema")
    rows=[]
    prev=None
    for row in reader:
        if row["instrument_name"]!=symbol or row["confirm"]!="1":
            raise ValueError("Wrong instrument or unfinished minute bar")
        stamp=int(row["open_time"])
        d=datetime.fromtimestamp(stamp/1000,timezone.utc)
        if stamp%60_000 or stamp>=ms("2026-09-05T00:00:00Z"):
            raise ValueError("Unexpected timestamp or reserve Sep05 original holdout")
        # Module2 day label uses UTC+8, not UTC.
        local=(d.date() if d.hour>=16 else
               datetime.fromtimestamp((stamp+8*3600000)/1000,timezone.utc).date())
        label=datetime.fromtimestamp((stamp+8*3600000)/1000,timezone.utc).date().isoformat()
        if label!=day:
            raise ValueError("Source minute falls outside original UTC+8 archive day")
        if prev is not None and stamp-prev!=60_000:
            raise ValueError("Daily source is not a consecutive 1m time grid")
        prev=stamp
        op,hi,lo,cl=(Decimal(row[x]) for x in ("open","high","low","close"))
        if not 0<lo<=min(op,cl)<=max(op,cl)<=hi:
            raise ValueError("Corrupt original minute price")
        rows.append([str(stamp),str(op),str(hi),str(lo),str(cl),
                     row["vol"],row["vol_ccy"],row["vol_quote"],row["confirm"]])
    if len(rows)!=1440:
        raise ValueError("Expected complete 1440-minute UTC+8 daily file")
    return rows,{
        "date_utc_plus8":day,"symbol":symbol,
        "archive_filename":f"{symbol}-candlesticks-{day}.zip",
        "original_zip_sha256":receipt["original_sha256"],
        "original_archive_rows":len(rows),
        "all_bars_complete_and_consecutive":True,
    }


def evaluate(source_module2_root,source_rest_root):
    data=[]
    for case,archive_label in COVERED.items():
        candles={}
        provenance={}
        for sym in SYMBOLS:
            rows,meta=archive_bars(source_module2_root,archive_label,sym)
            res=compute_returns(rows,case)
            candles[sym]=res
            provenance[sym]=meta
            loaded_rest=load_one(source_rest_root,case,sym,"candles")
            if loaded_rest is not None:
                rest_rows,rest_receipt=loaded_rest
                archive_map={int(row[0]):Decimal(row[4]) for row in rows}
                same=sum(int(row[0]) in archive_map and archive_map[int(row[0])]==Decimal(row[4])
                         for row in rest_rows)
                if same!=len(rest_rows):
                    raise ValueError("Original REST historical 1m values disagree with official module2 archive")
                meta["historical_rest_crosscheck"]={
                    "source_sha256":rest_receipt["raw_response_sha256"],
                    "matching_original_minute_rows":same,
                    "total_original_rest_rows":len(rest_rows),
                    "same_exact_original_close_prices":True,
                }
        oi=load_one(source_rest_root,case,"NEAR-USDT-SWAP","oi")
        obs={}
        for minutes in FUTURE_HORIZONS:
            v={sym:Decimal(candles[sym]["close_return_bps_vs_signal"][str(minutes)])
               for sym in SYMBOLS}
            ctrl=(v["BTC-USDT-SWAP"]+v["ETH-USDT-SWAP"])/Decimal(2)
            obs[str(minutes)]={
                "horizon_minutes":minutes,
                "near_close_return_bps":str(v["NEAR-USDT-SWAP"]),
                "btc_close_return_bps":str(v["BTC-USDT-SWAP"]),
                "eth_close_return_bps":str(v["ETH-USDT-SWAP"]),
                "equal_weight_btc_eth_control_bps":str(ctrl),
                "near_excess_vs_equal_weight_control_bps":str(v["NEAR-USDT-SWAP"]-ctrl),
                "close_not_bid_ask_and_not_fill":True,
            }
        data.append({
            "case":case,"signal_utc":SAMPLES[case],
            "original_module2_provenance":provenance,
            "source_close_prices_and_relative_returns":candles,
            "fixed_comparison_horizons":obs,
            "NEAR_hourly_open_interest":None if oi is None else oi_diagnostic(oi[0],case),
            "post_hoc_not_independent_signal":True,
        })
    win_oi=load_one(source_rest_root,UNAVAILABLE,"NEAR-USDT-SWAP","oi")
    data.append({
        "case":UNAVAILABLE,"signal_utc":SAMPLES[UNAVAILABLE],
        "module2_crossmarket_status":"UNAVAILABLE_WITHOUT_READING_RESERVED_UTCplus8_SEP05_FILE",
        "fixed_comparison_horizons":{str(m):None for m in FUTURE_HORIZONS},
        "NEAR_hourly_open_interest":None if win_oi is None else oi_diagnostic(win_oi[0],UNAVAILABLE),
        "post_hoc_not_independent_signal":True,
    })
    return {
        "schema":SCHEMA,
        "scope":"POST_HOC_MACRO_BETA_AND_OPEN_INTEREST_DIAGNOSTIC_NOT_ALPHA",
        "source":"OFFICIAL_OKX_DAILY_UTC_PLUS8_MODULE2_ZIP_PLUS_PUBLIC_HOURLY_OI",
        "events":data,
        "cases_with_complete_three_asset_minute_candles":len(COVERED),
        "cases_with_reconstructed_OI":sum(e["NEAR_hourly_open_interest"] is not None for e in data),
        "fourth_crossmarket_case_unavailable_by_original_sept05_holdout_protection":True,
        "original_module2_UTCplus8_sep05_zip_not_opened":True,
        "OI_not_confirmed_liquidations":True,
        "candles_not_tradable_orderbook_quotes":True,
        "observational_only_selection_after_original_v24_price_returns":True,
        "no_causal_NEAR_news_or_manipulation_proven":True,
        "validated_alpha":False,
        "actual_PnL":None,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    a=argparse.ArgumentParser(description=__doc__)
    a.add_argument("--module2-dir",required=True,type=Path)
    a.add_argument("--rest-dir",required=True,type=Path)
    a.add_argument("--out",required=True,type=Path)
    p=a.parse_args()
    if p.out.exists():raise FileExistsError("Immutable v27 archive result exists")
    result=evaluate(p.module2_dir,p.rest_dir)
    with p.out.open("xb") as f:f.write(canonical(result)+b"\n")
    print(json.dumps({
        "status":result["scope"],
        "source_cases":len(result["events"]),
        "fully_covered":result["cases_with_complete_three_asset_minute_candles"],
        "OI_cases":result["cases_with_reconstructed_OI"],
        "crossmarket":[{"case":e["case"],"fixed_comparison_horizons":e["fixed_comparison_horizons"]}
                       for e in result["events"]],
        "result_sha256":sha256(p.out.read_bytes()),
        "can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
