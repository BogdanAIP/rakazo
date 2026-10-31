#!/usr/bin/env python3
"""Immutable genuine OKX module2 UTC+8 daily minute candle ZIP archives for v27.

Exactly 2026-09-03/04 UTC+8, three pre-frozen perpetual symbols. Does NOT
access UTC+8 Sep05 (overlaps reserved Sep05 UTC holdout). No live/order APIs.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import time
import urllib.request
import zipfile

from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

ALLOWED_DAYS=("2026-09-03","2026-09-04")
SYMBOLS=("BTC-USDT-SWAP","ETH-USDT-SWAP","NEAR-USDT-SWAP")
BASE="https://static.okx.com/cdn/okex/traderecords/candlesticks/daily/"
MAX_COMPRESSED=10*1024*1024
MAX_UNCOMPRESSED=20*1024*1024
MAX_DOWNLOAD_SECONDS=20
RECEIPT_SCHEMA="algorithm_module2_daily_candle_original_v27"


def original_filename(day,symbol):
    if day not in ALLOWED_DAYS or symbol not in SYMBOLS:
        raise ValueError("Archive is not among v27 registered module2 sources")
    return f"{symbol}-candlesticks-{day}.zip"


def url_for(day,symbol):
    return BASE+day.replace("-","")+"/"+original_filename(day,symbol)+"?v=1001"


def paths(root,day,symbol):
    path=Path(root)
    name=original_filename(day,symbol)
    return path/name,path/(name+".receipt.json")


def download(root,day,symbol):
    url=url_for(day,symbol)
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    archive,receipt=paths(root,day,symbol)
    part=Path(str(archive)+".part")
    if any(f.exists() for f in (archive,receipt,part)):
        raise FileExistsError("Original module2 archive already attempted/preserved")
    req=urllib.request.Request(url,headers={"User-Agent":"AlgorithmDiscovery-v27-original-historical-module2/1.0"})
    sha=hashlib.sha256()
    clock=time.monotonic()
    count=0
    with urllib.request.urlopen(req,timeout=12) as response:
        if response.status!=200 or response.geturl()!=url:
            raise ValueError("Wrong official module2 source/HTTP response")
        length=response.headers.get("Content-Length")
        if length and int(length)>MAX_COMPRESSED:
            raise ValueError("Compressed module2 source exceeds frozen 10MiB cap")
        headers={"url":response.geturl(),"status":response.status,
                 "content_length":length,
                 "etag":response.headers.get("ETag"),
                 "last_modified":response.headers.get("Last-Modified")}
        with part.open("xb") as f:
            while True:
                if time.monotonic()-clock>MAX_DOWNLOAD_SECONDS:
                    raise TimeoutError("Original module2 transfer budget exceeded")
                buf=response.read(1<<16)
                if not buf:break
                count+=len(buf)
                if count>MAX_COMPRESSED:
                    raise ValueError("Original compressed module2 source over cap")
                sha.update(buf);f.write(buf)
    if count==0 or (length and count!=int(length)):
        raise ValueError("Incomplete original module2 source")
    record={
        "schema":RECEIPT_SCHEMA,
        "utc_plus_8_label":day,"instrument":symbol,
        "source_url":url,"original_filename":original_filename(day,symbol),
        "original_sha256":sha.hexdigest(),"original_bytes":count,
        "http":headers,
        "no_holdout_utc_sept05_source_access":True,
        "not_an_original_book_bid_ask_quote":True,
    }
    with receipt.open("xb") as f:f.write(canonical(record)+b"\n")
    os.replace(part,archive)
    return {"status":"ORIGINAL_OKX_MODULE2_ZIP_DOWNLOADED",
            "day":day,"symbol":symbol,"bytes":count,"sha256":sha.hexdigest()}


def open_verified(root,day,symbol):
    original,receipt_path=paths(root,day,symbol)
    r=strictly_decode(receipt_path.read_bytes())
    raw=original.read_bytes()
    if (r.get("schema")!=RECEIPT_SCHEMA
        or r.get("instrument")!=symbol
        or r.get("utc_plus_8_label")!=day
        or r.get("source_url")!=url_for(day,symbol)
        or r.get("original_sha256")!=sha256(raw)
        or r.get("original_bytes")!=len(raw)
        or r.get("no_holdout_utc_sept05_source_access") is not True):
        raise ValueError("Original archived minute source/receipt mismatch")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        members=z.infolist()
        if len(members)!=1 or members[0].is_dir() or not 0<members[0].file_size<=MAX_UNCOMPRESSED:
            raise ValueError("Historical ZIP member format unsupported")
        contents=z.read(members[0])
    return contents,members[0].filename,r


def inspect(root,day,symbol):
    data,member,receipt=open_verified(root,day,symbol)
    lines=data.decode("utf-8-sig").splitlines()
    return {"day":day,"symbol":symbol,"member":member,
            "member_bytes":len(data),"line_count":len(lines),
            "header_and_first_three_rows":lines[:4],
            "original_zip_sha256":receipt["original_sha256"]}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir",required=True,type=Path)
    ap.add_argument("--day",required=True,choices=ALLOWED_DAYS)
    ap.add_argument("--symbol",required=True,choices=SYMBOLS)
    ap.add_argument("--action",required=True,choices=("download","inspect"))
    a=ap.parse_args()
    result=download(a.dir,a.day,a.symbol) if a.action=="download" else inspect(a.dir,a.day,a.symbol)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
