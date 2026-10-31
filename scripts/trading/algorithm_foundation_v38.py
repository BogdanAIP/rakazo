#!/usr/bin/env python3
"""Frozen July DEVELOPMENT foundation; original free sources, no order API."""
import argparse
from collections import Counter
from datetime import datetime,timezone
from decimal import Decimal as D
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

import algorithm_memory_v37 as memory
from algorithm_cohort_audit_v37 import audit,archive_span
import algorithm_independent_v34 as pilot
import algorithm_path_v35 as path_features

archives=pilot.archives
DAYS=tuple(f"2026-07-{d:02d}" for d in range(1,21))
SYMBOLS=pilot.SYMBOLS
MANIFEST_SHA={
 "BTC-USDT-SWAP":"9790814104f6f167c8f0648528963fc2c7fcf92cd158ab2f1b0331731d3f11c9",
 "ETH-USDT-SWAP":"f6eafc4f753bb5d336031f4316d01ff809c86d7a98cdcdf89d52f64d4ffef603",
 "SOL-USDT-SWAP":"d8c905a712b7584036fe23ec752bc2e47f41f6453d9f360dca6843420f36d7d8",
 "DOGE-USDT-SWAP":"cd011cdfc8aa7bac7b7e53e05e13691e93cb074c15decea881ad11e505b66124",
 "XRP-USDT-SWAP":"347a0a6e58826b37c6f5061ffc350e6edd8e04ec17c57d2d2f27088174e4ccea"}


def frozen_spec():
    return {"schema":"july_foundation_v38","mode":"DEVELOPMENT_ONLY",
        "days":list(DAYS),"primaries":list(SYMBOLS),"controls":list(archives.CONTROLS),
        "raw_archive_clock":"UTC+8 day, full half-open UTC span",
        "source_bytes_cap":archives.MAX_SOURCE_BYTES,"spool_bytes_cap":pilot.MAX_UNCOMPRESSED,
        "minimum_free_bytes":pilot.MIN_FREE,"batch_timeout_seconds":3600,
        "stage_timeouts":{"acquire":900,"unpack":180,"extract":300,"evaluate":900,"retire":90},
        "spool_retirement":"Only this batch, after successful evaluation and verified archive/cache/index/spool hashes",
        "memory_minimum_prior_days":20,"maturity_minutes":17,"programs":6,
        "execution":"UNCERTIFIED_QUOTED_SCENARIO_ONLY","independent_validation":False}


def registered(day,symbol,kind):
    # This is an explicit adapter, never a mutation of the v30/v34 allowlist.
    return archives.registered(day,symbol,kind,days=DAYS)


def context_sha(day,symbol):
    registered(day,symbol,"L2")
    return pilot.lab.digest({"spec":frozen_spec(),"day":day,"symbol":symbol})


def file_paths(root,day,symbol):
    name,url=registered(day,symbol,"L2")
    return (Path(root)/"source"/day/symbol/"L2"/name,
            Path(root)/"spool"/day/symbol/name.replace(".tar.gz",".data"),url)


def index_name(day,symbol):return f"{symbol}-{day}-snapshot-index-v38.json"


def manifest(root,day,symbol):
    original,spool,url=file_paths(root,day,symbol)
    receipt=json.loads(Path(str(original)+".receipt.json").read_bytes())
    info=json.loads(Path(str(spool)+".receipt.json").read_bytes())
    if (receipt.get("source_url")!=url or receipt.get("original_sha256")!=archives.digest(original)
            or receipt.get("original_bytes")!=original.stat().st_size
            or info.get("source_archive_sha")!=receipt["original_sha256"]
            or info.get("spool_bytes")!=spool.stat().st_size):
        raise ValueError("New foundation source chain mismatch")
    return original,spool,None,receipt,context_sha(day,symbol),[],[]


def source_guard(manifest_root,workspace,runtime_root):
    import hashlib
    manifests=[]
    for symbol,sha in sorted(MANIFEST_SHA.items()):
        p=manifest_root/(symbol+".manifest.json");raw=p.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=sha:raise ValueError("Protected metadata identity changed")
        z=json.loads(raw)
        end_train=z["first_open_ms"]+int(.6*z["closed_bars"])*z["candle_interval_minutes"]*60000
        if symbol in SYMBOLS+archives.CONTROLS:
            if any(archive_span(d)[0]<z["first_open_ms"] or archive_span(d)[1]>end_train for d in DAYS):
                raise ValueError("Proposed payload extends beyond known training span")
        manifests.append((p.name,raw))
    protected=audit(manifests,list(DAYS),set(SYMBOLS+archives.CONTROLS))
    if protected["conflicts"]:raise ValueError("Closed or protected source overlap")
    text=subprocess.run(["git","worktree","list","--porcelain"],cwd=workspace,
                        capture_output=True,text=True,check=True,timeout=8).stdout
    roots=[Path(line[9:]) for line in text.splitlines() if line.startswith("worktree ")
           and Path(line[9:]).name.startswith("rakazo-alpha-")]
    if len(roots)<35:raise ValueError("Expected known research worktree inventory missing")
    inventory=[]
    for i,root in enumerate(roots+[runtime_root]):
        r=subprocess.run(["rg","--files","--hidden","--no-ignore","--iglob","*.claim.json",
            "--iglob","*registry*.json","--iglob","*holdout*.json","-g","!node_modules/**","-g","!.git/**"],
            cwd=root,capture_output=True,text=True,timeout=5)
        if r.returncode not in (0,1):raise ValueError("Claim metadata search incomplete")
        matches=r.stdout.splitlines()
        inventory.append({"scope_index":i,"matching_metadata_files":len(matches)})
        if matches:raise ValueError("Claim/registry metadata found; review before source access")
    reports=[]
    for p in sorted(runtime_root.glob("algorithm-*.json")):
        z=json.loads(p.read_bytes())
        flags={k:z[k] for k in ("schema","mode","holdout_used","holdout_reexamined") if k in z}
        if z.get("holdout_used") is True or z.get("holdout_reexamined") is True:
            raise ValueError("Older claimed result needs source review")
        reports.append({"name":p.name,"sha":archives.digest(p),"metadata":flags})
    return {"status":"PROJECT_SCOPED_DEVELOPMENT_ADMISSION","protected_audit":protected,
        "research_worktrees":len(roots),"inventory":inventory,"old_report_metadata":reports,
        "new_payloads_within_known_train60_spans":True,"claim_files_found_in_scope":0,
        "global_registry_completeness_certified":False,"independent_cohort_certified":False,
        "basis":"Known manifests, all registered research worktrees and research archive; no global filesystem claim"}


def acquire_day(root,day):
    if day not in DAYS:raise ValueError("Unregistered batch day")
    requests=[(s,k) for s in SYMBOLS for k in ("trades","L2")]
    requests += [(s,"candlesticks") for s in SYMBOLS+archives.CONTROLS]
    completed=[];deadline=time.monotonic()+850
    for symbol,kind in requests:
        for attempt in range(12):
            if time.monotonic()>deadline or shutil.disk_usage(root).free<pilot.MIN_FREE:
                raise RuntimeError("Finite source time/disk budget exhausted")
            try:r=archives.acquire(root/"source",day,symbol,kind,seconds=8,locator=registered)
            except (TimeoutError,ConnectionError,pilot.URLError) as error:
                if isinstance(error,pilot.HTTPError) and error.code not in (408,429,500,502,503,504):raise
                if attempt>=2:raise
                continue
            print(json.dumps(r),flush=True)
            if r["status"].startswith("COMPLETE"):completed.append(r);break
        else:raise RuntimeError("Bounded per-file acquisition exhausted")
    if len(completed)!=8:raise ValueError("Incomplete original-source batch")
    return {"schema":"v38_original_acquisition","day":day,"sources":completed}


def extract(root,day,symbol):
    band=memory.band;hook=band.BandHook()
    book=band.replay.extract(root,day,symbol,source_manifest=manifest,
        index_name=index_name(day,symbol),quote_hook=hook,transition_hook=path_features.PathHook())
    trades,sha=band.lab.source.load_trades(root/"source",day,symbol,locator=registered,include_price=True)
    stamps=[x[0] for x in trades]
    for t,record in hook.intervals.items():
        if record["status"]=="AVAILABLE":
            executions=band.trade_sum(trades,stamps,t,D(record["lower"]),D(record["upper"]))
            record["executions"]=executions
            if executions["status"]=="AVAILABLE":record["features"]=band.accounting(record,executions)
            else:record["status"]=executions["status"]
        p=book["bins"].get(t,{}).get("path")
        record["event_ofi"]=path_features.normalized(p)["event_ofi"] if p is not None else None
    book.update(schema="july_original_band_v38_development",band_intervals=hook.intervals,
        trade_price_source_sha=sha,context_sha=context_sha(day,symbol),
        conditional_accounting_identity_certified=False,first_pass_no_prior_cache=True)
    return book


def clean_head(workspace,expected_head):
    h=subprocess.run(["git","rev-parse","HEAD"],cwd=workspace,capture_output=True,text=True,check=True).stdout.strip()
    dirty=subprocess.run(["git","status","--porcelain"],cwd=workspace,capture_output=True,text=True,check=True).stdout.strip()
    if h!=expected_head or dirty:raise ValueError("Frozen clean source pipeline required")


def retire_spool(root,day,symbol):
    original,spool,url=file_paths(root,day,symbol)
    feature=root/"features"/f"{symbol}-{day}-restoration-v32.json"
    result=root/"first-development-v38.json"
    index=root/"l2"/index_name(day,symbol)
    receipt=json.loads(Path(str(original)+".receipt.json").read_bytes())
    book=json.loads(feature.read_bytes());idx=json.loads(index.read_bytes())
    if (not result.exists() or receipt.get("source_url")!=url
            or archives.digest(original)!=receipt["original_sha256"]
            or book["original_archive_sha"]!=receipt["original_sha256"]
            or archives.digest(spool)!=book["spool_sha"] or idx["spool_sha256"]!=book["spool_sha"]
            or archives.digest(index)!=book["index_sha"]):
        raise ValueError("Do not retire a spool without verified original, index, feature and result")
    c=next(c for c in json.loads(result.read_bytes())["cases"] if c["day"]==day and c["symbol"]==symbol)
    if c["feature_sha"]!=archives.digest(feature):raise ValueError("Evaluated feature identity changed")
    decision={"decision":"REMOVE_ONLY_REPRODUCIBLE_NEW_BATCH_SPOOL","day":day,"symbol":symbol,
        "original_sha":receipt["original_sha256"],"spool_sha":book["spool_sha"],"spool_bytes":spool.stat().st_size,
        "feature_sha":archives.digest(feature),"index_sha":archives.digest(index),"result_sha":archives.digest(result),
        "original_and_features_preserved":True}
    archives.jwrite_new(root/f"{symbol}-spool-retirement-decision.json",decision)
    spool.unlink()
    return {**decision,"derived_spool_removed":not spool.exists()}


def run_batch(root,day,manifest_root,expected_head):
    workspace=Path(__file__).resolve().parents[2]
    clean_head(workspace,expected_head)
    if json.loads((workspace/"docs/trading/ALGORITHM-FOUNDATION-COHORT-v38.json").read_bytes())!=frozen_spec():
        raise ValueError("Published source specification changed")
    runtime_root=manifest_root.parent
    guard=source_guard(manifest_root,workspace,runtime_root)
    if root.resolve()==runtime_root.resolve() or runtime_root.resolve() not in root.resolve().parents:
        raise ValueError("Require isolated research child root")
    earlier=DAYS[:DAYS.index(day)]
    for d in earlier:
        p=root/d/"run-status.json"
        if not p.exists() or json.loads(p.read_bytes())["status"]!="COMPLETE":
            raise ValueError("Acquire foundation chronologically; earlier batch incomplete")
    target=root/day;target.mkdir(parents=True,exist_ok=True)
    journal={"schema":"v38_finite_batch","status":"RUNNING","head":expected_head,"day":day,
             "started_utc":datetime.now(timezone.utc).isoformat(),"completed":[]}
    checkpoint=target/"run-status.json";archives.jwrite_new(checkpoint,journal)
    archives.jwrite_new(target/"source-admission.json",guard)
    journal["source_admission_sha"]=archives.digest(target/"source-admission.json")
    checkpoint.write_text(json.dumps(journal),encoding="utf-8")
    stages=[("acquire",[],target/"first-acquisition.json",900)]
    for symbol in SYMBOLS:
        stages += [("unpack",["--symbol",symbol],target/f"{symbol}-unpack.json",180),
                   ("extract",["--symbol",symbol],target/"features"/f"{symbol}-{day}-restoration-v32.json",300)]
    stages.append(("evaluate",[],target/"first-development-v38.json",900))
    stages.extend(("retire",["--symbol",s],target/f"{s}-retirement-receipt.json",90) for s in SYMBOLS)
    try:
        for stage,extra,out,timeout in stages:
            journal["stage"]=stage+"-"+(extra[-1] if extra else day)
            checkpoint.write_text(json.dumps(journal),encoding="utf-8")
            print(json.dumps({"stage":journal["stage"],"status":"STARTING"}),flush=True)
            subprocess.run([sys.executable,str(Path(__file__).resolve()),stage,"--root",str(root),
                "--day",day,"--out",str(out)]+extra,cwd=workspace,check=True,timeout=timeout)
            journal["completed"].append({"stage":journal["stage"],"sha":archives.digest(out)})
        journal["status"]="COMPLETE"
    except (OSError,subprocess.SubprocessError) as error:
        journal.update(status="INCOMPLETE_EXECUTION",error_type=type(error).__name__)
        raise
    finally:
        journal["finished_utc"]=datetime.now(timezone.utc).isoformat()
        checkpoint.write_text(json.dumps(journal),encoding="utf-8")
    return journal


def main():
    p=argparse.ArgumentParser()
    p.add_argument("stage",choices=("run","acquire","unpack","extract","evaluate","retire"))
    p.add_argument("--root",type=Path,required=True);p.add_argument("--day",choices=DAYS,required=True)
    p.add_argument("--out",type=Path);p.add_argument("--manifest-root",type=Path)
    p.add_argument("--expected-head");p.add_argument("--symbol",choices=SYMBOLS)
    a=p.parse_args();target=a.root/a.day
    if a.stage=="run":result=run_batch(a.root,a.day,a.manifest_root,a.expected_head)
    else:
        if a.out is None or a.out.exists():raise FileExistsError("Preserve first stage output")
        journal=json.loads((target/"run-status.json").read_bytes())
        if (journal["status"]!="RUNNING" or journal["day"]!=a.day
                or archives.digest(target/"source-admission.json")!=journal["source_admission_sha"]):
            raise ValueError("Stage requires its active audited finite batch")
        clean_head(Path(__file__).resolve().parents[2],journal["head"])
        if a.stage=="acquire":result=acquire_day(target,a.day)
        elif a.stage=="unpack":result=pilot.unpack_and_index(target,a.day,a.symbol,paths=file_paths,
            context=context_sha,index_name=index_name(a.day,a.symbol))
        elif a.stage=="extract":result=extract(target,a.day,a.symbol)
        elif a.stage=="retire":result=retire_spool(target,a.day,a.symbol)
        else:
            from algorithm_memory_economics_v38 import evaluate_foundation
            result=evaluate_foundation(a.root,a.day)
        a.out.parent.mkdir(parents=True,exist_ok=True);archives.jwrite_new(a.out,result)
        print(json.dumps({"stage":a.stage,"output_sha":archives.digest(a.out),
                          "source_rows":result.get("source_rows"),"summary":result.get("summary")}),flush=True)
        return
    print(json.dumps(result),flush=True)


if __name__=="__main__":main()
