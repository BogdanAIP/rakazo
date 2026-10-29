#!/usr/bin/env python3
"""Manual bounded OKX monthly archive research batch (no trading).

Archive URLs are obtained exclusively by pinned Node official OKX metadata
downloader. No silent repairs, background jobs, account access or retries.
"""
from __future__ import annotations
import argparse
import json
import subprocess
import time
from pathlib import Path

from okx_archive_import import _verify_archive,convert
from okx_dataset import SYMBOL

MONTHS=("2026-07","2026-08","2026-09")
MAX_SYMBOLS=2
MIN_SPACING=1.0


def inspect_existing(directory,symbol,month):
    archive=directory/f"{symbol}-candlesticks-{month}.zip"
    receipt=Path(str(archive)+".receipt.json")
    if archive.exists() != receipt.exists():
        raise ValueError("Partial archive/receipt must be investigated")
    if archive.exists():
        _verify_archive(archive,symbol)
        return True
    return False


def run_batch(universe_path,archive_dir,offset=0,count=1,
              downloader=None,sleeper=time.sleep):
    if offset<0 or not 1<=count<=MAX_SYMBOLS:
        raise ValueError("Bounded batch permits 1..2 instruments")
    src=json.loads(Path(universe_path).read_text(encoding="utf-8"))
    if src.get("schema")!="okx_usdt_swap_universe_v1" or src.get("source")!="official_okx_public_rest":
        raise ValueError("Unsupported instrument snapshot")
    selected=src.get("selected")
    if not isinstance(selected,list) or len(selected[offset:offset+count])!=count:
        raise ValueError("Insufficient selected candidates")
    archive_dir=Path(archive_dir)
    root=Path(__file__).parent
    output=[]
    started_download=False
    for item in selected[offset:offset+count]:
        symbol=item["symbol"]
        if not isinstance(symbol,str) or not SYMBOL.fullmatch(symbol):
            raise ValueError("Invalid market")
        paths=[]
        downloads=0
        status="READY"
        for month in MONTHS:
            path=archive_dir/f"{symbol}-candlesticks-{month}.zip"
            if inspect_existing(archive_dir,symbol,month):
                paths.append(path)
                continue
            if started_download:
                sleeper(MIN_SPACING)
            started_download=True
            command=["node",str(root/"okx_archive_download.mjs"),symbol,
                     month,"2",str(archive_dir)]
            response=(downloader(command) if downloader is not None else
                      subprocess.run(command,capture_output=True,text=True,
                                     timeout=25,check=False))
            if response.returncode:
                status=("RATE_LIMITED_STOP" if "HTTP_429" in response.stderr
                        else "ARCHIVE_FETCH_FAILED")
                break
            if not inspect_existing(archive_dir,symbol,month):
                raise ValueError("Downloader did not create a verified archive")
            paths.append(path)
            downloads+=1
        if status=="READY":
            target=archive_dir/f"{symbol}.csv"
            if target.exists():
                # Existing datasets are admitted only with verifiable provenance.
                from run_alpha_audited import verify_snapshot
                verify_snapshot(target,target.with_suffix(".manifest.json"))
                status="ALREADY_VERIFIED"
            else:
                try:
                    report=convert(paths,symbol,target)
                    status="VERIFIED_15M_HISTORY"
                except ValueError as error:
                    status="DATA_REJECTED"
                    # Preserve source archives for later independent diagnosis.
                    message=str(error)[:140]
        row={"symbol":symbol,"status":status,"downloaded_archives":downloads,
             "selected_months":list(MONTHS)}
        if status=="DATA_REJECTED":
            row["reason"]=message
        output.append(row)
        if status in ("RATE_LIMITED_STOP","ARCHIVE_FETCH_FAILED"):
            break
    return {"mode":"MANUAL_OFFLINE_RESEARCH_DATA_ONLY",
            "symbols_attempted":len(output),"results":output,
            "new_archives_downloaded":sum(x["downloaded_archives"] for x in output),
            "trade_execution_enabled":False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--universe",type=Path,required=True)
    p.add_argument("--archive-dir",type=Path,required=True)
    p.add_argument("--offset",type=int,default=0)
    p.add_argument("--count",type=int,default=1)
    args=p.parse_args()
    print(json.dumps(run_batch(args.universe,args.archive_dir,args.offset,args.count),
                     sort_keys=True))

if __name__=="__main__":
    main()
