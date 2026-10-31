#!/usr/bin/env python3
"""v22 one exact official published HTTPS historical archive download, no live quote API.

A successful TLS download + SHA does NOT prove a venue cryptographic data
signature. This command cannot place orders, fetch current bid/ask, or run
automatically. No repeat-on-failure or market/date fallback.
"""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import urllib.request
from urllib.parse import urlsplit

URL="https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/20260902/NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.tar.gz"
ARCHIVE_NAME="NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.tar.gz"
CAP=250*1024*1024
TIME_CAP_SECONDS=30
CHUNK=1024*1024
SCHEMA="algorithm_official_history_download_receipt_v22"


def fixed_url(url):
    if url!=URL:
        raise ValueError("Only precommitted official archive URL permitted")
    p=urlsplit(url)
    if p.scheme!="https" or p.netloc!="static.okx.com" or p.query or p.fragment:
        raise ValueError("Unexpected source URL")


def retrieve(folder,*,url=URL):
    fixed_url(url)
    folder=Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    dest=folder/ARCHIVE_NAME
    tmp=folder/(ARCHIVE_NAME+".part")
    receipt=folder/(ARCHIVE_NAME+".receipt.json")
    if any(p.exists() for p in (dest,tmp,receipt)):
        raise FileExistsError("Pre-existing successful/failed attempt; no overwrite/retry")
    if shutil.disk_usage(folder).free<CAP+100*1024*1024:
        raise OSError("Insufficient disk space to preserve original archive safely")
    start=time.monotonic()
    count=0
    sha=hashlib.sha256()
    req=urllib.request.Request(url,headers={"User-Agent":"AlgorithmDiscovery-v22-official-historical-L2/1.0",
                                            "Accept":"application/octet-stream"})
    # Do not remove a failed .part file; its existence prevents retries or
    # an incomplete transfer from being labelled an actual exchange archive.
    with urllib.request.urlopen(req,timeout=20) as response:
        if response.status!=200 or response.geturl()!=url:
            raise ValueError("Historical archive request redirected/unexpected status")
        length=response.headers.get("Content-Length")
        if length is not None and int(length)>CAP:
            raise ValueError("Published original file exceeds frozen download cap")
        meta={
            "url":url,"response_status":response.status,
            "response_content_length":length,
            "response_etag":response.headers.get("ETag"),
            "response_last_modified":response.headers.get("Last-Modified"),
            "response_content_type":response.headers.get("Content-Type"),
        }
        with tmp.open("xb") as out:
            while True:
                if time.monotonic()-start>TIME_CAP_SECONDS:
                    raise TimeoutError("Predeclared one-attempt 30s transfer limit")
                block=response.read(CHUNK)
                if not block:
                    break
                count+=len(block)
                if count>CAP:
                    raise ValueError("Archive exceeds resource budget")
                sha.update(block)
                out.write(block)
    if count<=0 or (length is not None and count!=int(length)):
        raise ValueError("Incomplete historical archive")
    data={
        "schema":SCHEMA,
        "source_kind":"OKX_PUBLIC_OFFICIAL_HISTORICAL_ARCHIVE_NOT_REALTIME_MARKET_BOOK",
        "symbol":"NEAR-USDT-SWAP",
        "archive_date_utc":"2026-09-02",
        "archive_name":ARCHIVE_NAME,
        "original_archive_sha256":sha.hexdigest(),
        "original_bytes":count,
        "download_completed_utc":datetime.now(timezone.utc).isoformat(),
        "http_evidence":meta,
        "independently_cryptographically_venue_signed":False,
        "no_pricing_values_read":True,
        "no_orders_or_live_book_calls":True,
    }
    with receipt.open("xb") as f:
        f.write(json.dumps(data,ensure_ascii=False,sort_keys=True).encode()+b"\n")
    os.replace(tmp,dest)
    return data


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out-dir",required=True,type=Path)
    args=p.parse_args()
    r=retrieve(args.out_dir)
    print(json.dumps(r,ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
