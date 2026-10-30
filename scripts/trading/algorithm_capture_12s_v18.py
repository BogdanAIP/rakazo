#!/usr/bin/env python3
"""A one-off manually launched 12s public WebSocket capture for v18 diagnostics.

Reuses existing v8 unchanged WebSocket client/source limits and raw persistence,
temporarily selecting a distinct bounded 12-second observation duration in
this process. No daemon, private accounts, orders, alternate endpoints.
"""
from __future__ import annotations
import argparse
import asyncio
import json
from pathlib import Path

import algorithm_ws_capture_v8 as original

CAPTURE_SECONDS=12


def capture(symbol,out_dir):
    if Path(out_dir).exists():
        raise FileExistsError("Never overwrite research source or retry")
    original.safe_symbol(symbol)
    # The original collector explicitly checks its process-local frozen
    # duration constant. Only this new one-off wrapper changes its own
    # imported module setting; source file and all other studies stay intact.
    original.OBSERVATION_SECONDS=CAPTURE_SECONDS
    manifest,frames=asyncio.run(original.collect(symbol,seconds=CAPTURE_SECONDS))
    if manifest["observation_seconds"]!=CAPTURE_SECONDS:
        raise ValueError("Wrong source duration")
    digest=original.save_capture(out_dir,manifest,frames)
    return {"symbol":symbol,"duration_ms":manifest["end_utc_ms"]-manifest["start_utc_ms"],
            "manifest_sha256":digest,"messages":len(frames),
            "source_window":[manifest["start_utc_ms"],manifest["end_utc_ms"]],
            "can_trade":False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--symbol",required=True)
    p.add_argument("--out-dir",required=True,type=Path)
    x=p.parse_args()
    print(json.dumps(capture(x.symbol,x.out_dir),sort_keys=True))


if __name__=="__main__":
    main()
