#!/usr/bin/env python3
"""Frozen v30 official OKX archived-source acquirer (NO trading or live API).

Repeatable bounded foreground chunks with byte-range resume and source ETag
protection. Hard allowlist from docs/trading/ALGORITHM-LIQUIDITY-PREREG-v30-20261031.md.
New original datasets must be verified independently; archive receipt != exchange signature.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request
from urllib.error import HTTPError
import zipfile

DAYS=("2026-09-10","2026-09-17")
PRIMARIES=("NEAR-USDT-SWAP","SOL-USDT-SWAP")
CONTROLS=("BTC-USDT-SWAP","ETH-USDT-SWAP")
KINDS=("trades","candlesticks","L2")
MAX_SOURCE_BYTES=400*1024*1024
MAX_CHUNK_SECONDS=11

def registered(day,symbol,kind,*,days=DAYS):
    if day not in days or kind not in KINDS:
        raise ValueError("Not a v30 registered archive day or source kind")
    if kind!="candlesticks" and symbol not in PRIMARIES:
        raise ValueError("Only preregistered primary instruments have trade/L2 inputs")
    if symbol not in PRIMARIES+CONTROLS:
        raise ValueError("Unregistered symbol")
    name=(f"{symbol}-L2orderbook-400lv-{day}.tar.gz" if kind=="L2"
          else f"{symbol}-{kind}-{day}.zip")
    if kind=="L2":
        url=f"https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/{day.replace('-','')}/{name}"
    else:
        url=f"https://static.okx.com/cdn/okex/traderecords/{kind}/daily/{day.replace('-','')}/{name}?v=1001"
    return name,url

def digest(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""): h.update(block)
    return h.hexdigest()

def jwrite_new(path,data):
    with Path(path).open("x",encoding="utf-8") as f:
        json.dump(data,f,sort_keys=True,separators=(",",":"),ensure_ascii=False)
        f.write("\n")

def acquire(root,day,symbol,kind,seconds=11,*,locator=None):
    name,url=(locator or registered)(day,symbol,kind)
    if not 1<=seconds<=MAX_CHUNK_SECONDS:
        raise ValueError("Bounded foreground time budget exceeded")
    folder=Path(root)/day/symbol/kind
    folder.mkdir(parents=True,exist_ok=True)
    target=folder/name
    part=folder/(name+".part")
    metadata_path=folder/(name+".transfer.json")
    receipt_path=folder/(name+".receipt.json")
    if target.exists():
        if not receipt_path.exists():raise ValueError("Orphan original without receipt")
        receipt=json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("original_sha256")!=digest(target):
            raise ValueError("Previously saved original SHA changed")
        if receipt.get("source_url")!=url:
            raise ValueError("Unexpected origin changed")
        return {"status":"COMPLETE_REVERIFIED","day":day,"symbol":symbol,"kind":kind,"bytes":target.stat().st_size,"sha256":receipt["original_sha256"]}
    head_req=urllib.request.Request(url,method="HEAD",headers={"User-Agent":"AlgorithmDiscovery-v30-historical-source/1.0"})
    with urllib.request.urlopen(head_req,timeout=8) as response:
        if response.status!=200 or response.geturl()!=url:raise ValueError("Unexpected source redirect or HEAD response")
        size=int(response.headers.get("Content-Length","0"))
        etag=response.headers.get("ETag")
        last_modified=response.headers.get("Last-Modified")
    if size<=0 or size>MAX_SOURCE_BYTES:raise ValueError("Original source size exceeds frozen hard safety cap")
    meta={"source_url":url,"http_content_length":size,"http_etag":etag,
          "http_last_modified":last_modified,"archive_name":name,
          "day_utc_plus8_label":day,"symbol":symbol,"kind":kind,
          "not_venue_signed":True}
    if metadata_path.exists():
        prior=json.loads(metadata_path.read_text(encoding="utf-8"))
        if prior!=meta:raise ValueError("Original source headers changed during partial transfer")
    else:
        if part.exists():raise ValueError("Orphan partial download")
        jwrite_new(metadata_path,meta)
    offset=part.stat().st_size if part.exists() else 0
    if offset>size:raise ValueError("Partial bytes exceed frozen source content length")
    if offset<size:
        headers={"User-Agent":"AlgorithmDiscovery-v30-historical-source/1.0"}
        if offset:headers.update({"Range":f"bytes={offset}-","If-Range":etag})
        request=urllib.request.Request(url,headers=headers)
        start=time.monotonic()
        with urllib.request.urlopen(request,timeout=8) as response:
            expected=206 if offset else 200
            if response.status!=expected or response.geturl()!=url:
                raise ValueError("HTTP range response/redirect invalid; do not splice inconsistent source")
            if offset:
                content_range=response.headers.get("Content-Range","")
                if not content_range.startswith(f"bytes {offset}-") or not content_range.endswith(f"/{size}"):
                    raise ValueError("HTTP Content-Range mismatch; do not splice sources")
            with part.open("ab" if offset else "xb") as output:
                while time.monotonic()-start<seconds:
                    buf=response.read(1024*1024)
                    if not buf:break
                    if output.tell()+len(buf)>size:raise ValueError("Transferred more bytes than expected")
                    output.write(buf)
                output.flush()
    current=part.stat().st_size
    if current!=size:
        return {"status":"PARTIAL_RESUMABLE","day":day,"symbol":symbol,"kind":kind,
                "bytes":current,"expected_bytes":size,"percent":round(current*100/size,2)}
    sha=digest(part)
    # Verify official member schema before promoting immutable original.
    if kind!="L2":
        with zipfile.ZipFile(part) as z:
            expected=f"{symbol}-{kind}-{day}.csv"
            if z.namelist()!=[expected]:raise ValueError("Unexpected original archive ZIP member")
            if z.getinfo(expected).file_size>128*1024*1024:raise ValueError("Oversized ZIP member (>128 MiB)")
            # CRC and decompression integrity validated by zipfile.
            with z.open(expected) as f:
                while f.read(1024*1024):pass
    receipt={**meta,"schema":"algorithm_v30_original_source_receipt",
             "original_sha256":sha,"original_bytes":current,
             "http_status":200,"immutable":True,"never_paid_or_private_api":True}
    jwrite_new(receipt_path,receipt)
    os.replace(part,target)
    return {"status":"COMPLETE_ORIGINAL","day":day,"symbol":symbol,"kind":kind,
            "bytes":current,"sha256":sha}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--day",required=True)
    p.add_argument("--symbol",required=True)
    p.add_argument("--kind",required=True)
    p.add_argument("--seconds",type=int,default=11)
    a=p.parse_args()
    print(json.dumps(acquire(a.root,a.day,a.symbol,a.kind,a.seconds),ensure_ascii=False,sort_keys=True))

if __name__=="__main__":main()
