#!/usr/bin/env python3
"""Official monthly OKX ZIP candle import: strict 1m -> complete 15m.

No network, trading, orders or scheduler. Only explicitly downloaded OKX
archive ZIPs with adjacent SHA-256 receipts. Stops on ANY missing minute.
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
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from okx_dataset import SYMBOL, export_snapshot, INTERVAL_MS

MINUTE_MS = 60_000
MINUTES_PER_BAR = 15
MAX_ZIP_BYTES = 20_000_000
MAX_UNCOMPRESSED_BYTES = 25_000_000
HEAD = ("instrument_name","open","high","low","close",
        "vol","vol_ccy","vol_quote","open_time","confirm")


def _verify_archive(path, symbol):
    path=Path(path)
    if not path.is_file() or path.stat().st_size > MAX_ZIP_BYTES:
        raise ValueError("Archive absent or exceeds size limit")
    receipt_path=Path(str(path)+".receipt.json")
    rec=json.loads(receipt_path.read_text(encoding="utf-8"))
    if rec.get("protocol")!="okx_official_archive_v5" or rec.get("module")!="2" or rec.get("symbol")!=symbol:
        raise ValueError("Invalid official candlestick receipt")
    if rec.get("zip_file")!=path.name or not re.fullmatch(r"20\d\d-(0[1-9]|1[0-2])",rec.get("month","")):
        raise ValueError("Archive month/name mismatch")
    expected=symbol+"-candlesticks-"+rec["month"]+".zip"
    if path.name!=expected:
        raise ValueError("Unexpected archive name")
    url=rec.get("archive_url","")
    if not url.startswith("https://static.okx.com/cdn/okex/traderecords/candlesticks/") or expected not in url:
        raise ValueError("Archive URL not pinned to official source")
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if rec.get("sha256")!=digest or rec.get("size_bytes")!=path.stat().st_size:
        raise ValueError("Archive SHA-256/size mismatch")
    return rec, digest


def _decimal(value):
    if not isinstance(value,str) or not value:
        raise ValueError("Missing candle value")
    try:
        d=Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid decimal")
    if not d.is_finite():
        raise ValueError("Nonfinite decimal")
    return d


def read_month(path, symbol):
    receipt,digest=_verify_archive(path,symbol)
    with zipfile.ZipFile(path) as archive:
        files=archive.infolist()
        expected=symbol+"-candlesticks-"+receipt["month"]+".csv"
        if len(files)!=1 or files[0].filename!=expected or files[0].is_dir():
            raise ValueError("Unexpected ZIP member")
        if files[0].file_size > MAX_UNCOMPRESSED_BYTES:
            raise ValueError("Uncompressed archive exceeds safe size")
        with archive.open(files[0],"r") as raw:
            reader=csv.reader(io.TextIOWrapper(raw,encoding="utf-8-sig",newline=""))
            if tuple(next(reader,()))!=HEAD:
                raise ValueError("Unexpected OKX official archive schema")
            records=[]
            previous=None
            for row in reader:
                if len(row)!=len(HEAD) or row[0]!=symbol or row[9]!="1":
                    raise ValueError("Malformed/unconfirmed/mismatched minute")
                ts_text=row[8]
                if not re.fullmatch(r"\d{13}",ts_text):
                    raise ValueError("Invalid millisecond timestamp")
                ts=int(ts_text)
                if ts % MINUTE_MS:
                    raise ValueError("Minute not UTC aligned")
                if previous is not None and ts-previous!=MINUTE_MS:
                    raise ValueError("Missing, duplicated or out-of-order minute")
                previous=ts
                op,hi,lo,cl=[_decimal(x) for x in row[1:5]]
                quote_vol=_decimal(row[7])
                if min(op,hi,lo,cl)<=0 or quote_vol<0 or lo>min(op,cl) or hi<max(op,cl):
                    raise ValueError("Impossible OHLC or quote volume")
                records.append((ts,op,hi,lo,cl,quote_vol))
    if len(records)<MINUTES_PER_BAR:
        raise ValueError("Archive has insufficient minutes")
    year,month=map(int,receipt["month"].split("-"))
    from calendar import monthrange
    expected_count=monthrange(year,month)[1]*1440
    first_ms=int(datetime(year,month,1,tzinfo=timezone(timedelta(hours=8))).timestamp()*1000)
    if (len(records)!=expected_count or records[0][0]!=first_ms or
            records[-1][0]!=first_ms+(expected_count-1)*MINUTE_MS):
        raise ValueError("Official monthly archive has incomplete calendar coverage")
    return receipt,digest,records


def convert(paths,symbol,out,as_of=None):
    if not SYMBOL.fullmatch(symbol):
        raise ValueError("Unsupported swap symbol")
    if not 1<=len(paths)<=24:
        raise ValueError("Need 1..24 monthly archives")
    as_of=as_of or datetime.now(timezone.utc)
    if as_of.tzinfo is None or as_of.utcoffset()!=timedelta(0):
        raise ValueError("as_of must be UTC")
    archives=[read_month(p,symbol) for p in paths]
    months=[x[0]["month"] for x in archives]
    if months!=sorted(set(months)):
        raise ValueError("Monthly archive list must be sorted and unique")
    # Explicitly ensure sequential calendar months (even if no candles in a gap).
    for m1,m2 in zip(months,months[1:]):
        year,month=map(int,m1.split("-"))
        next_month=f"{year+int(month==12):04d}-{(month%12)+1:02d}"
        if m2!=next_month:
            raise ValueError("Missing archive month")
    previous=None
    bucket=[]
    candles=[]
    minute_count=0
    for receipt,digest,records in archives:
        for ts,op,hi,lo,cl,vol in records:
            if previous is not None and ts-previous!=MINUTE_MS:
                raise ValueError("Cross-month minute gap/duplicate")
            previous=ts
            if ts + MINUTE_MS>int(as_of.timestamp()*1000):
                raise ValueError("Future/unclosed archive minute")
            if not bucket:
                if ts%INTERVAL_MS:
                    raise ValueError("First minute not on a 15m boundary")
            else:
                if ts//INTERVAL_MS != bucket[0][0]//INTERVAL_MS:
                    raise ValueError("Missing source minute in 15m bucket")
            bucket.append((ts,op,hi,lo,cl,vol))
            minute_count+=1
            if len(bucket)==MINUTES_PER_BAR:
                start=bucket[0][0]
                if any(x[0]!=start+j*MINUTE_MS for j,x in enumerate(bucket)):
                    raise ValueError("Incomplete 15m bar")
                candles.append((
                    start, float(bucket[0][1]),float(max(x[2] for x in bucket)),
                    float(min(x[3] for x in bucket)),float(bucket[-1][4]),
                    float(sum((x[5] for x in bucket),Decimal(0))),symbol
                ))
                bucket=[]
    if bucket:
        raise ValueError("Final incomplete 15m bucket")
    sources=[{
        "archive_sha256":digest,"archive_path":str(Path(path).resolve()),
        "month":rec["month"],"size_bytes":rec["size_bytes"],
        "archive_url":rec["archive_url"]
    } for path,(rec,digest,_) in zip(paths,archives)]
    receipts=[{"month":x["month"],"sha256":x["archive_sha256"]} for x in sources]
    manifest=export_snapshot(candles,receipts,symbol,as_of,Path(out),
                             "official_archive",source_artifacts=sources)
    return {"symbol":symbol,"source":"official_archive","months":months,
            "minutes_verified":minute_count,"closed_15m_bars":len(candles),
            "csv_sha256":manifest["csv_sha256"],
            "output":str(out),"can_submit_orders":False}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol",required=True)
    ap.add_argument("--zip",required=True,nargs="+",type=Path)
    ap.add_argument("--out",required=True,type=Path)
    args=ap.parse_args()
    print(json.dumps(convert(args.zip,args.symbol,args.out),sort_keys=True))


if __name__=="__main__":
    main()
