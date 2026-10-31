#!/usr/bin/env python3
"""v21 single finite 15s public books/trades-all source, no trading or network time query."""
from __future__ import annotations
import argparse
import asyncio
import json
from pathlib import Path

import algorithm_ws_capture_v8 as original

CAPTURE_SECONDS=15


def capture(symbol,folder):
    folder=Path(folder)
    if folder.exists():
        raise FileExistsError("Original v21 raw source already exists; never retry or overwrite")
    original.safe_symbol(symbol)
    original.OBSERVATION_SECONDS=CAPTURE_SECONDS  # per-process only; v8 file unmodified
    manifest,events=asyncio.run(original.collect(symbol,seconds=CAPTURE_SECONDS))
    if manifest["observation_seconds"]!=CAPTURE_SECONDS:
        raise ValueError("Wrong source duration")
    digest=original.save_capture(folder,manifest,events)
    return {
        "symbol":symbol,"duration_ms":manifest["end_utc_ms"]-manifest["start_utc_ms"],
        "original_manifest_sha256":digest,
        "original_message_count":len(events),
        "source_start_utc_ms":manifest["start_utc_ms"],
        "source_end_utc_ms":manifest["end_utc_ms"],
        "no_futures_outcomes_requested":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--symbol",required=True)
    p.add_argument("--out-dir",type=Path,required=True)
    args=p.parse_args()
    print(json.dumps(capture(args.symbol,args.out_dir),sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
