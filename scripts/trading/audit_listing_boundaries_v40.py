"""Audit first observations and reported prelaunch volume; no strategy evaluation."""
from __future__ import annotations
import argparse
import datetime as dt
from decimal import Decimal
import json
from pathlib import Path
import okx_bench_archive_v40 as a

ANNOUNCED = {
    "WSM-USDT-SWAP": "2023-10-06T04:00:00+00:00",
    "BIGTIME-USDT-SWAP": "2023-10-12T13:00:00+00:00",
    "TIA-USDT-SWAP": "2023-10-31T18:30:00+00:00",
}

def milliseconds(iso):
    return int(dt.datetime.fromisoformat(iso).timestamp()*1000)

def summarize_rows(rows, cases, announced):
    by_symbol = {case["symbol"]: case for case in cases}
    first = {}
    seen_prelaunch = {}
    volumes = {symbol: Decimal(0) for symbol in announced}
    positive = {symbol: 0 for symbol in announced}
    for row in rows:
        symbol = row["instrument_name"]
        if symbol not in by_symbol:
            continue
        minute = int(row["open_time"])
        first[symbol] = min(first.get(symbol, minute), minute)
        if symbol not in announced or minute >= milliseconds(announced[symbol]):
            continue
        key = symbol, minute
        fingerprint = tuple(sorted(row.items()))
        if key in seen_prelaunch:
            if seen_prelaunch[key] != fingerprint:
                raise ValueError("Conflicting prelaunch minute")
            continue
        seen_prelaunch[key] = fingerprint
        quote = Decimal(row["vol_quote"])
        if not quote.is_finite() or quote < 0:
            raise ValueError("Invalid reported quote volume")
        volumes[symbol] += quote
        positive[symbol] += int(quote > 0)
    result = []
    for symbol, case in sorted(by_symbol.items()):
        if symbol not in first:
            raise ValueError("Case symbol absent from inspected archive interval")
        expected = milliseconds(case["hour_utc"])+case["first_minute"]*60000
        item = {"symbol":symbol, "first_archived_minute_utc":dt.datetime.fromtimestamp(
            first[symbol]/1000,tz=dt.timezone.utc).isoformat(),
            "case_is_first_archived_minute":first[symbol] == expected,
            "cause":"UNKNOWN"}
        if symbol in announced:
            item.update(announced_enablement_utc=announced[symbol],
                first_observation_same_utc_day_as_announcement=
                    first[symbol]//a.DAY == milliseconds(announced[symbol])//a.DAY,
                preannouncement_distinct_minutes=sum(1 for sym,_ in seen_prelaunch if sym == symbol),
                preannouncement_positive_volume_minutes=positive[symbol],
                preannouncement_sum_vol_quote=str(volumes[symbol]))
        result.append(item)
    return result

def inspect(root, start, end, cases):
    def rows():
        for day in a.days(start, end):
            receipt = json.loads((root/"receipts"/(str(day)+".json")).read_text())
            path = a.file_at(root, "candles", day)
            if a.sha_file(path) != receipt["candles"]["sha256"]:
                raise ValueError("Original candle SHA differs from private receipt")
            yield from a.read_zip_rows(path)
    return {"schema":"listing_boundary_observation_v1", "mode":"DATA_QUALITY_DEVELOPMENT",
            "archive_start":str(start),"archive_end":str(end),
            "cases":summarize_rows(rows(),cases,ANNOUNCED),
            "volume_unit":"source vol_quote reported USDT; exact decimal sum, duplicate minute fields counted once",
            "execution_provenance_certified":False,
            "interpretation":"Positive reported candle volume is not independently verified first execution; zero does not identify indicative/auction causes. First observation is within inspected sources, not an all-history listing certificate.",
            "source_changes":False,"real_strategy_evaluations":0,"freeze_approved":False}

if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--cases",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--start",type=a.DATE,required=True)
    p.add_argument("--end",type=a.DATE,required=True)
    args=p.parse_args()
    if args.out.exists():raise FileExistsError(args.out)
    cases=json.loads(args.cases.read_text())["cases"]
    result=inspect(args.root,args.start,args.end,cases)
    result["cases_input_sha256"]=a.sha_file(args.cases)
    a.atomic_bytes(args.out,(json.dumps(result,indent=2)+"\n").encode())
