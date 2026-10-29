#!/usr/bin/env python3
"""Offline official monthly OKX funding archives; preserve observed event dates.

Funding-rate archive is not a user's account ledger. Never assume an absent
event means zero settlement, or a fixed 8h rate for other instruments.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import io
import json
import math
import re
import zipfile
from datetime import datetime,timezone
from pathlib import Path

from okx_dataset import SYMBOL

def import_archives(paths,symbol,output):
    if not SYMBOL.fullmatch(symbol):
        raise ValueError("Invalid perpetual instrument")
    if not 1 <= len(paths) <= 24:
        raise ValueError("Expect 1..24 monthly ZIP files")
    records=[]
    provenance=[]
    previous=None
    for raw_path in paths:
        path=Path(raw_path)
        receipt=json.loads(Path(str(path)+".receipt.json").read_text(encoding="utf-8"))
        month=receipt.get("month","")
        if (receipt.get("protocol")!="okx_official_archive_v5" or
            receipt.get("module")!="3" or receipt.get("symbol")!=symbol or
            not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])",month) or
            path.name!=f"{symbol}-fundingrates-{month}.zip"):
            raise ValueError("Unexpected funding archive metadata")
        if not receipt.get("archive_url","").startswith("https://static.okx.com/cdn/okex/traderecords/"):
            raise ValueError("Unapproved archive source")
        if path.stat().st_size > 10_000_000:
            raise ValueError("Oversized funding ZIP")
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        if digest!=receipt.get("sha256") or receipt.get("size_bytes")!=path.stat().st_size:
            raise ValueError("Funding archive checksum mismatch")
        if previous is not None and month<=previous:
            raise ValueError("Funding months not chronological")
        previous=month
        with zipfile.ZipFile(path) as archive:
            files=archive.infolist()
            expected=f"{symbol}-fundingrates-{month}.csv"
            if len(files)!=1 or files[0].filename!=expected or files[0].file_size>10_000_000:
                raise ValueError("Unexpected funding ZIP member")
            with archive.open(files[0]) as f:
                rows=csv.DictReader(io.TextIOWrapper(f,encoding="utf-8-sig",newline=""))
                if rows.fieldnames!=["instrument_name","funding_rate","funding_time"]:
                    raise ValueError("Unknown official funding schema")
                for row in rows:
                    if row["instrument_name"]!=symbol or not re.fullmatch(r"\d{13}",row["funding_time"]):
                        raise ValueError("Invalid instrument/time")
                    timestamp=int(row["funding_time"])
                    rate=float(row["funding_rate"])
                    if not math.isfinite(rate) or abs(rate)>0.1:
                        raise ValueError("Invalid funding rate")
                    if records and timestamp<=records[-1]["time_ms"]:
                        raise ValueError("Duplicate/out-of-order funding")
                    records.append({"time_ms":timestamp,"archive_funding_rate":rate})
        provenance.append({"month":month,"archive_path":str(path.resolve()),
                           "archive_sha256":digest})
    if not records:
        raise ValueError("No funding observations")
    intervals=[b["time_ms"]-a["time_ms"] for a,b in zip(records,records[1:])]
    report={
        "format":"okx_archive_funding_v5",
        "symbol":symbol,
        "source":"OKX_OFFICIAL_MONTHLY_ARCHIVE",
        "downloaded_zip_sha256":[x["archive_sha256"] for x in provenance],
        "source_archives":provenance,
        "events":records,
        "events_count":len(records),
        "observed_intervals_hours":sorted(set(x/3600000 for x in intervals)),
        "calendar_completeness_certified":False,
        "account_realized_funding_verified":False,
        "allow_trading":False,
    }
    output=Path(output)
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open("x",encoding="utf-8") as f:
        json.dump(report,f,indent=2,sort_keys=True)
        f.write("\n")
    return {"symbol":symbol,"events":len(records),
            "observed_intervals_hours":report["observed_intervals_hours"],
            "output":str(output),"account_funding_verified":False}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--symbol",required=True)
    p.add_argument("--zip",required=True,nargs="+",type=Path)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    print(json.dumps(import_archives(args.zip,args.symbol,args.out)))

if __name__=="__main__":
    main()
