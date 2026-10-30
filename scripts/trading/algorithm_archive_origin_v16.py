#!/usr/bin/env python3
"""Prepare a USER-ASSERTED local archive manifest for v16, offline only.

The reference URL and current wall clock are provenance CLAIMS, not an OKX
signature. User must know where the file came from. Never marks it trusted.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlparse

from algorithm_historical_l2_v16 import ORIGIN_SCHEMA,sha_file,SYMBOL_PATTERN
from algorithm_multiday_registry_v12 import canonical


def make_origin(archive,symbol,url,now_ms):
    archive=Path(archive)
    if not archive.is_file():
        raise FileNotFoundError("Downloaded historical archive not present")
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise ValueError("Unknown instrument")
    parsed=urlparse(url)
    if (not isinstance(url,str) or parsed.scheme!="https" or not parsed.netloc
            or parsed.username or parsed.password):
        raise ValueError("Use the actual HTTPS page/archive address observed by the user")
    if type(now_ms) is not int or now_ms<=0:
        raise ValueError("Invalid UTC epoch milliseconds")
    return {
        "schema":ORIGIN_SCHEMA,
        "symbol":symbol,
        "archive_sha256":sha_file(archive),
        "download_source_url":url,
        "claimed_download_complete_utc_ms":now_ms,
        "exchange_origin_independently_verified":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive",type=Path,required=True)
    p.add_argument("--symbol",required=True)
    p.add_argument("--source-url",required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.out.exists():
        raise FileExistsError("Do not overwrite the initial provenance record")
    result=make_origin(a.archive,a.symbol,a.source_url,time.time_ns()//1_000_000)
    with a.out.open("xb") as f:
        f.write(canonical(result)+b"\n")
    print(json.dumps({
        "status":"USER_DECLARED_NOT_AUTHENTICATED",
        "sha256":result["archive_sha256"],
        "archive":str(a.archive),
        "proven_exchange_origin":False,
        "network_access_performed":False,
    },sort_keys=True))


if __name__=="__main__":
    main()
