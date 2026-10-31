#!/usr/bin/env python3
"""Frozen fresh-source NEAR-specific pilot. No orders, secrets or paid endpoints.

Adapters preserve prior default cohorts. Selection was posthoc in development;
this pilot is a fresh historical test, not live arrival or execution evidence.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import mmap
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
from urllib.error import HTTPError, URLError

import algorithm_v30_archive_acquire as archives
import algorithm_stream_v31 as lab
import algorithm_restoration_v32 as restoration
from algorithm_rank_v33 import rank_actions
from algorithm_historical_l2_v16 import unpack_event

DAYS = ("2026-10-01", "2026-10-08")
SYMBOLS = ("NEAR-USDT-SWAP", "SOL-USDT-SWAP")
CASES = tuple((day, symbol) for day in DAYS for symbol in SYMBOLS)
PROGRAM_IDS = {"restoration-flow-no-memory", "flow-baseline", "depth-baseline"}
MAX_UNCOMPRESSED = 6*1024**3
MIN_FREE = 10*1024**3
NEWS = tuple({"day": day, "scheduled_utc": day+"T12:30:00+00:00",
              "event": "US initial unemployment claims",
              "evidence": "SCHEDULE_ONLY_NOT_LIVE_AVAILABILITY",
              "url": "https://www.newyorkfed.org/research/calendars/i-oct26.html"}
             for day in DAYS) + (
    {"day": DAYS[0], "scheduled_utc": DAYS[0]+"T14:00:00+00:00",
     "event": "ISM manufacturing and construction spending",
     "evidence": "SCHEDULE_ONLY_NOT_LIVE_AVAILABILITY",
     "url": "https://www.newyorkfed.org/research/calendars/i-oct26.html"},
    {"day": DAYS[1], "scheduled_utc": DAYS[1]+"T14:00:00+00:00",
     "event": "Wholesale trade",
     "evidence": "SCHEDULE_ONLY_NOT_LIVE_AVAILABILITY",
     "url": "https://www.newyorkfed.org/research/calendars/i-oct26.html"},
)


def registered(day, symbol, kind):
    return archives.registered(day, symbol, kind, days=DAYS)


def file_paths(root, day, symbol):
    if (day, symbol) not in CASES:
        raise ValueError("Outside frozen v34 cohort")
    name, url = registered(day, symbol, "L2")
    original = Path(root)/"source"/day/symbol/"L2"/name
    spool = Path(root)/"spool"/day/symbol/name.replace(".tar.gz", ".data")
    return original, spool, url


def context_sha(day, symbol):
    return lab.digest({"schema": "v34_frozen_source_context", "days": DAYS,
                       "symbols": SYMBOLS, "day": day, "symbol": symbol,
                       "program_ids": sorted(PROGRAM_IDS)})


def manifest(root, day, symbol):
    original, spool, url = file_paths(root, day, symbol)
    receipt = json.loads(Path(str(original)+".receipt.json").read_bytes())
    info = json.loads(Path(str(spool)+".receipt.json").read_bytes())
    if (receipt.get("source_url") != url or receipt.get("original_sha256") != archives.digest(original)
            or receipt.get("original_bytes") != original.stat().st_size
            or info.get("source_archive_sha") != receipt["original_sha256"]
            or info.get("spool_bytes") != spool.stat().st_size):
        raise ValueError("Original v34 source chain mismatch")
    return original, spool, None, receipt, context_sha(day,symbol), [], []


def acquire_all(root):
    requests = [(day,symbol,kind) for day,symbol in CASES for kind in ("trades","L2")]
    requests += [(day,symbol,"candlesticks") for day in DAYS
                 for symbol in SYMBOLS+archives.CONTROLS]
    deadline = time.monotonic()+900
    completed = []
    for day,symbol,kind in requests:
        for chunk in range(12):
            if time.monotonic() > deadline or shutil.disk_usage(Path(root).parent).free < MIN_FREE:
                raise RuntimeError("Finite acquisition time/disk budget exhausted")
            try:
                row = archives.acquire(Path(root)/"source",day,symbol,kind,seconds=8,locator=registered)
            except (URLError, TimeoutError, ConnectionError) as error:
                if isinstance(error,HTTPError) and error.code not in (408,429,500,502,503,504):
                    raise
                if chunk >= 2:
                    raise
                print(json.dumps({"status":"TRANSIENT_SOURCE_RETRY","day":day,
                                  "symbol":symbol,"kind":kind,"attempt":chunk+1,
                                  "error_type":type(error).__name__}),flush=True)
                time.sleep(2**chunk)
                continue
            print(json.dumps(row),flush=True)
            if row["status"].startswith("COMPLETE"):
                completed.append(row)
                break
        else:
            raise RuntimeError("Per-source acquisition budget exhausted")
    if len(completed) != 16:
        raise ValueError("Missing required official sources")
    return {"schema": "v34_acquisition", "sources": completed}


def unpack_and_index(root, day, symbol, *, paths=None, context=None, index_name=None):
    # Reviewed adapters can add a separately frozen DEVELOPMENT cohort; defaults
    # retain v34's original strict source identity and index name.
    original, spool, url = (paths or file_paths)(root,day,symbol)
    receipt = json.loads(Path(str(original)+".receipt.json").read_bytes())
    if receipt["source_url"] != url or receipt["original_sha256"] != archives.digest(original):
        raise ValueError("Original archive identity mismatch")
    spool.parent.mkdir(parents=True,exist_ok=True)
    spool_receipt = Path(str(spool)+".receipt.json")
    part = Path(str(spool)+".part")
    if spool.exists() or spool_receipt.exists() or part.exists():
        raise FileExistsError("Inspect existing extraction; never overwrite")
    h, seen = hashlib.sha256(), 0
    with tarfile.open(original,"r|gz") as tf:
        item = tf.next()
        if (item is None or not item.isfile() or item.issym() or item.islnk()
                or item.name != spool.name or not 0 < item.size <= MAX_UNCOMPRESSED):
            raise ValueError("Unexpected or oversized original L2 member")
        src = tf.extractfile(item)
        if src is None:
            raise ValueError("Original member unavailable")
        if shutil.disk_usage(spool.parent).free < item.size+MIN_FREE:
            raise RuntimeError("Insufficient free disk reserve")
        with part.open("xb") as out:
            while True:
                block = src.read(1024*1024)
                if not block:
                    break
                seen += len(block)
                if seen > item.size:
                    raise ValueError("Uncompressed original exceeds declared length")
                h.update(block)
                out.write(block)
        if seen != item.size or tf.next() is not None:
            raise ValueError("Truncated or extra original archive member")
    part.rename(spool)
    archives.jwrite_new(spool_receipt,{"source_archive_sha":receipt["original_sha256"],
                                     "spool_sha":h.hexdigest(),"spool_bytes":seen})
    snapshots = []
    with spool.open("rb") as f:
        with mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as mm:
            pos = 0
            while True:
                hit = mm.find(b'"action":"snapshot"',pos)
                if hit < 0:
                    break
                left, right = mm.rfind(b"\n",0,hit)+1, mm.find(b"\n",hit)
                if right < 0 or right-left+1 > restoration.MAX_LINE:
                    raise ValueError("Invalid original snapshot line")
                line = mm[left:right+1]
                ts,action,seq,prev,sides,inst = unpack_event(line)
                if action != "snapshot" or inst != symbol or (snapshots and ts < snapshots[-1]["ts"]):
                    raise ValueError("Original snapshot index identity invalid")
                snapshots.append({"ts":ts,"offset":left,
                                  "line_sha256":hashlib.sha256(line).hexdigest()})
                pos = right+1
    if not snapshots:
        raise ValueError("No original snapshots")
    index = {"schema":"v34_original_snapshot_index","original_sha256":receipt["original_sha256"],
             "context_sha":(context or context_sha)(day,symbol),"spool_sha256":h.hexdigest(),
             "spool_bytes":seen,"snapshot_entries":snapshots}
    folder = Path(root)/"l2"
    folder.mkdir(exist_ok=True)
    name = index_name or f"{symbol}-{day}-snapshot-index-v34.json"
    archives.jwrite_new(folder/name,index)
    return {"snapshots":len(snapshots),"spool_bytes":seen,"spool_sha":h.hexdigest()}


def extract_case(root, day, symbol):
    # New index filename and context hash; legacy v30 source roots are never opened.
    name = f"{symbol}-{day}-snapshot-index-v34.json"
    return restoration.extract(root,day,symbol,source_manifest=manifest,index_name=name)


def evaluate(root, proposals):
    lab.FEATURES.update(restoration.EXTRA_FEATURES)
    definitions, sha = lab.proposals(proposals)
    if {p["id"] for p in definitions} != PROGRAM_IDS:
        raise ValueError("Independent test candidate set changed")
    result = restoration.evaluate(root,Path(root)/"features",definitions,sha,
                                  action_function=rank_actions,cohort=CASES,locator=registered)
    result["schema"] = "v34_frozen_fresh_historical_pilot"
    result["new_historical_source_cohort"] = True
    result["independent_validation"] = "FRESH_SOURCE_PILOT_NOT_FORWARD_OR_EXECUTION_CERTIFICATION"
    candidate = "restoration-flow-no-memory"
    primary = []
    for case in result["cases"]:
        if case["symbol"] != "NEAR-USDT-SWAP":
            continue
        scores = case["programs"]
        c = scores[candidate]
        cm = c["mean_quote_20bp"]
        baselines = [scores[k]["mean_quote_20bp"] for k in ("flow-baseline","depth-baseline")]
        passed = (c["alarms"] >= 4 and c["quote_path_unavailable"] == 0
                  and cm is not None and cm > 0
                  and all(b is not None and cm > b for b in baselines))
        primary.append({"day":case["day"],"alarms":c["alarms"],"mean_quote_20bp":cm,
                        "baseline_means":baselines,"prespecified_pilot_pass":passed})
    result["primary_NEAR"] = primary
    result["primary_both_days_pass"] = len(primary) == 2 and all(p["prespecified_pilot_pass"] for p in primary)
    result["source_scope"] = {"days":DAYS,"symbols":SYMBOLS,"prior_selection_candidates":9}
    for case in result["cases"]:
        for values in case["programs"].values():
            for alarm in values.get("records",[]):
                alarm["scheduled_context_120min"] = [e for e in NEWS
                    if 0 <= alarm["t"]-int(datetime.fromisoformat(e["scheduled_utc"]).timestamp()*1000)
                    <= 120*60000]
                alarm["actual_news_coverage"] = "UNKNOWN"
    result["news"] = {"scheduled_context":NEWS,"complete_coverage":"UNKNOWN",
                       "used_as_predictor_or_exclusion":False,
                       "actual_payload_and_first_available_clock":"NOT_CERTIFIED"}
    result["effective_algorithm_confirmed"] = False
    return result


def run_all(root, expected_head):
    """Frozen finite stage order; a source failure is INCOMPLETE, never a loss."""
    workspace = Path(__file__).resolve().parents[2]
    head = subprocess.run(["git","rev-parse","HEAD"],cwd=workspace,
                          capture_output=True,text=True,check=True).stdout.strip()
    status = subprocess.run(["git","status","--porcelain"],cwd=workspace,
                            capture_output=True,text=True,check=True).stdout.strip()
    if head != expected_head or status:
        raise ValueError("Pipeline head changed or worktree dirty before independent run")
    root = Path(root)
    root.mkdir(parents=True,exist_ok=True)
    journal_path = root/"run-status.json"
    if journal_path.exists():
        journal = json.loads(journal_path.read_bytes())
        if journal.get("frozen_code_head") != head:
            raise ValueError("Resume requires original frozen executable head")
    else:
        journal = {"schema":"v34_stage_journal","frozen_code_head":head,"completed":[],
                   "started_utc":datetime.now(timezone.utc).isoformat(),
                   "provenance_audit":"prior filename/receipt/registry/manifest search: no exact dates found",
                   "status":"RUNNING"}
    stages = [("acquire",[],root/"acquisition.json",960)]
    for day,symbol in CASES:
        stages.append(("unpack",["--day",day,"--symbol",symbol],
                       root/"indexes"/f"{symbol}-{day}.json",300))
        stages.append(("extract",["--day",day,"--symbol",symbol],
                       root/"features"/f"{symbol}-{day}-restoration-v32.json",300))
    proposal = workspace/"docs/trading/ALGORITHM-INDEPENDENT-PROPOSALS-v34.json"
    stages.append(("evaluate",["--proposals",str(proposal)],root/"first-independent-v34.json",240))
    began = time.monotonic()
    for number,(action,extras,out,timeout) in enumerate(stages):
        label = f"{number:02d}-{action}"
        if number < len(journal["completed"]):
            if journal["completed"][number]["sha256"] != archives.digest(out):
                raise ValueError("Completed stage output changed")
            continue
        if time.monotonic()-began > 2400:
            raise RuntimeError("Finite whole-run budget exceeded")
        journal.update(status="RUNNING",stage=label,updated_utc=datetime.now(timezone.utc).isoformat())
        journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
        command = [sys.executable,str(Path(__file__).resolve()),action,"--root",str(root),
                   "--out",str(out)]+extras
        print(json.dumps({"stage":label,"status":"STARTING"}),flush=True)
        try:
            subprocess.run(command,cwd=workspace,check=True,timeout=timeout)
        except (subprocess.SubprocessError, OSError) as error:
            journal.update(status="INCOMPLETE_SOURCE_OR_EXECUTION",stage=label,
                           error_type=type(error).__name__,updated_utc=datetime.now(timezone.utc).isoformat())
            journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
            raise
        journal["completed"].append({"stage":label,"file":out.name,"sha256":archives.digest(out)})
        journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
    journal.update(status="COMPLETE",updated_utc=datetime.now(timezone.utc).isoformat())
    journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
    return {"status":"COMPLETE","result_sha256":archives.digest(root/"first-independent-v34.json"),
            "frozen_code_head":head}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action",choices=("run","acquire","unpack","extract","evaluate"))
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--day",choices=DAYS)
    p.add_argument("--symbol",choices=SYMBOLS)
    p.add_argument("--proposals",type=Path)
    p.add_argument("--expected-head")
    a = p.parse_args()
    if a.out.exists():
        raise FileExistsError("Preserve the first original output")
    if a.action == "run":
        result = run_all(a.root,a.expected_head)
    elif a.action == "acquire":
        result = acquire_all(a.root)
    elif a.action == "unpack":
        result = unpack_and_index(a.root,a.day,a.symbol)
    elif a.action == "extract":
        result = extract_case(a.root,a.day,a.symbol)
    else:
        result = evaluate(a.root,a.proposals)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    archives.jwrite_new(a.out,result)
    print(json.dumps({"action":a.action,"day":a.day,"symbol":a.symbol,
                      "output_sha":archives.digest(a.out),"summary":result.get("summary"),
                      "primary_NEAR":result.get("primary_NEAR"),
                      "primary_both_days_pass":result.get("primary_both_days_pass")}),flush=True)


if __name__ == "__main__":
    main()
