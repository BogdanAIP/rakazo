#!/usr/bin/env python3
"""Algorithm Discovery v12: immutable 12-day plan + hash-chained source ledger.

Research-only. NO order placement, accounts, exchange price/outcome API,
automatic monitoring or untrusted profit scoring. Source registration invokes
the existing hash+sequence verified public OKX WS offline replay. The upcoming
holdout is sealed until a model specification is frozen beforehand.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time

from algorithm_microstructure_capture_v7 import frozen_universe
from algorithm_ws_buckets_v8 import build_buckets

SCHEMA = "algorithm_multiday_plan_v12"
ENTRY_SCHEMA = "algorithm_multiday_source_receipt_v12"
SEAL_SCHEMA = "algorithm_multiday_holdout_seal_v12"
REPORT_SCHEMA = "algorithm_multiday_readiness_v12"
FIRST_DAY = date(2026, 11, 1)
DAYS = 12
MARKETS_PER_DAY = 5
EXPECTED_UNIVERSE_SHA = "3193fcab0a38e6a881d5b26e28efb1db59e60a0e051a8084112a19f53274a9d3"
SYMBOL = re.compile(r"[A-Z0-9]{2,20}-USDT-SWAP\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MAX_JSON = 1_000_000
GENESIS = "0"*64


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",",":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def strictly_decode(raw, max_bytes=MAX_JSON):
    if not 0<len(raw)<=max_bytes:
        raise ValueError("JSON file empty or unbounded")
    def unique(pairs):
        x={}
        for k,v in pairs:
            if k in x:
                raise ValueError("Duplicate JSON key")
            x[k]=v
        return x
    def reject_constant(value):
        raise ValueError("Nonfinite JSON token")
    return json.loads(raw,object_pairs_hook=unique,parse_constant=reject_constant)


def load_json(path,max_bytes=MAX_JSON):
    return strictly_decode(Path(path).read_bytes(),max_bytes)


def utc_day(ms):
    if type(ms) is not int or ms<=0:
        raise ValueError("Invalid UTC ms")
    return datetime.fromtimestamp(ms/1000,timezone.utc).date().isoformat()


def now_ms():
    return time.time_ns()//1_000_000


def make_plan(members,universe_sha,created_ms):
    if (len(members)!=50 or len(set(members))!=50
            or not HEX64.fullmatch(universe_sha)
            or any(not SYMBOL.fullmatch(s) for s in members)
            or utc_day(created_ms)>FIRST_DAY.isoformat()):
        raise ValueError("Plan needs 50 unique future eligible symbols")
    calendar=[]
    for i in range(DAYS):
        day=(FIRST_DAY+timedelta(days=i)).isoformat()
        split="development" if i<6 else "validation" if i<9 else "holdout"
        calendar.append({"date_utc":day,"day_index":i+1,"split":split,
                         "symbols":[members[(5*i+j)%50] for j in range(5)]})
    return {"schema":SCHEMA,
            "protocol":"docs/trading/ALGORITHM-MULTIDAY-PROTOCOL-v12-20261030.md",
            "created_utc_ms":created_ms,
            "universe_sha256":universe_sha,"frozen_universe":members,
            "calendar":calendar,
            "first_day_utc":FIRST_DAY.isoformat(),
            "last_day_utc":(FIRST_DAY+timedelta(days=DAYS-1)).isoformat(),
            "holdout_first_day_utc":calendar[9]["date_utc"],
            "source_per_market_day":1,
            "source_type":"OKX_PUBLIC_WS_BOOKS_PLUS_TRADES_ALL_8SEC",
            "no_future_price_source_verified":True,
            "historical_market_membership_verified":False,
            "model_pre_registered":False,
            "training_cross_validation_by_day_only":True,
            "past_v6_to_v11_excluded_from_holdout":True,
            "no_auto_monitoring":True,"can_trade":False,"can_start_paper":False}


def check_plan(plan):
    if (plan.get("schema")!=SCHEMA
        or plan.get("universe_sha256")!=EXPECTED_UNIVERSE_SHA
        or plan.get("source_per_market_day")!=1
        or plan.get("can_trade") is not False
        or plan.get("can_start_paper") is not False
        or plan.get("no_future_price_source_verified") is not True
        or plan.get("model_pre_registered") is not False):
        raise ValueError("Unrecognized / altered study plan")
    expected=make_plan(plan["frozen_universe"],
                       plan["universe_sha256"],plan["created_utc_ms"])
    if expected!=plan:
        raise ValueError("Immutable scheduled roster or splits changed")
    return plan


def study_plan(study):
    study=Path(study)
    raw=(study/"plan.json").read_bytes()
    x=check_plan(strictly_decode(raw))
    return x,sha256(raw)


def initialize(universe_path,study,now=None):
    now=now_ms() if now is None else now
    universe,actual=frozen_universe(universe_path)
    if actual!=EXPECTED_UNIVERSE_SHA:
        raise ValueError("Original 50-market source universe SHA mismatch")
    plan=make_plan([m["symbol"] for m in universe["members"]],actual,now)
    study=Path(study)
    if study.exists():
        raise FileExistsError("This scientific study exists; do not replace")
    if not study.parent.is_dir():
        raise FileNotFoundError("Existing study parent needed")
    study.mkdir()
    (study/"entries").mkdir()
    (study/"plan.json").write_bytes(canonical(plan)+b"\n")
    return sha256((study/"plan.json").read_bytes())


def assigned(plan,day,symbol):
    if not isinstance(day,str) or not isinstance(symbol,str):
        raise ValueError("Invalid day/symbol")
    for block in plan["calendar"]:
        if block["date_utc"]==day:
            if symbol not in block["symbols"]:
                raise ValueError("Symbol was not assigned on this UTC day")
            return block
    raise ValueError("UTC date outside predeclared study")


def receipt_fingerprint(source):
    # Replaying original raw events verifies hashes and book sequence.
    source=Path(source)
    values=build_buckets(source)
    manifest=(source/"manifest.json").read_bytes()
    messages=(source/"messages.jsonl").read_bytes()
    if values["source_manifest_sha256"]!=sha256(manifest):
        raise ValueError("Source manifest mismatch")
    if values["source_messages_sha256"]!=sha256(messages):
        raise ValueError("Source original WS bytes mismatch")
    if values["no_execution_or_future_returns"] is not True:
        raise ValueError("Unrecognized source content")
    return {
        "capture_path":str(source.resolve()),
        "source_manifest_sha256":sha256(manifest),
        "source_messages_sha256":sha256(messages),
        "capture_start_utc_ms":values["window_start_utc_ms"],
        "capture_end_utc_ms":values["window_end_utc_ms"],
        "dual_stream_complete_seconds":values["bins_with_both_streams"],
        "market":values["symbol"],
        "status":"SOURCE_VERIFIED_NO_OUTCOME",
        "future_price_label":None,
    }


def read_entries(study,plan=None,*,recheck_source=False):
    study=Path(study)
    if plan is None:
        plan,_=study_plan(study)
    rows=[]
    prev=GENESIS
    seen=set()
    p=study/"entries"
    files=sorted(p.glob("*.json"))
    for i,file in enumerate(files,1):
        if file.name!=f"{i:06d}.json":
            raise ValueError("Entry numbering gap or unsupported file")
        data=load_json(file,MAX_JSON)
        head={k:data[k] for k in ("schema","sequence","previous_sha256",
                                "plan_sha256","observation")}
        digest=sha256(canonical(head))
        if (data.get("entry_sha256")!=digest
            or data.get("schema")!=ENTRY_SCHEMA
            or data["sequence"]!=i or data["previous_sha256"]!=prev
            or data["plan_sha256"]!=sha256((study/"plan.json").read_bytes())):
            raise ValueError("Broken hash-chain or plan reference")
        observation=data["observation"]
        day,sym=observation["date_utc"],observation["symbol"]
        assigned(plan,day,sym)
        if (day,sym) in seen:
            raise ValueError("Repeated market/day registration")
        seen.add((day,sym))
        if observation["status"]=="SOURCE_VERIFIED_NO_OUTCOME":
            if observation.get("future_price_label") is not None:
                raise ValueError("Outcome was smuggled into source-only registry")
            if utc_day(observation["capture_start_utc_ms"])!=day or utc_day(observation["capture_end_utc_ms"])!=day:
                raise ValueError("Registered source timestamp outside assigned day")
            if observation["market"]!=sym:
                raise ValueError("Wrong captured swap contract")
            if recheck_source:
                reconstructed=receipt_fingerprint(observation["capture_path"])
                if reconstructed!={k:v for k,v in observation.items()
                                   if k not in ("date_utc","symbol","registered_at_utc_ms")}:
                    raise ValueError("Original source was modified or moved")
        elif observation["status"]=="SOURCE_MISSING_OR_REJECTED":
            if not isinstance(observation.get("reason"),str) or not 1<=len(observation["reason"])<=240:
                raise ValueError("Missing or malformed failure reason")
        else:
            raise ValueError("Unknown evidence status")
        prev=digest
        rows.append(data)
    return rows


def register(study,day,symbol,source=None,reason=None,now=None):
    now=now_ms() if now is None else now
    if (source is None)==(reason is None):
        raise ValueError("Provide either a source path or an explicit missing reason")
    plan,plan_sha=study_plan(study)
    assigned(plan,day,symbol)
    if utc_day(now)<day:
        raise ValueError("Cannot register a future UTC day")
    old=read_entries(study,plan,recheck_source=True)
    if any(e["observation"]["date_utc"]==day and
           e["observation"]["symbol"]==symbol for e in old):
        raise FileExistsError("Market/day already registered; no retries")
    if source is not None:
        obs=receipt_fingerprint(source)
        if obs["market"]!=symbol or utc_day(obs["capture_start_utc_ms"])!=day or utc_day(obs["capture_end_utc_ms"])!=day:
            raise ValueError("Source not from assigned market and calendar UTC day")
        if obs["capture_end_utc_ms"]>now+1000:
            raise ValueError("Capture from the future")
    else:
        if not isinstance(reason,str) or not 1<=len(reason)<=240:
            raise ValueError("Explicit bounded failure reason required")
        obs={"status":"SOURCE_MISSING_OR_REJECTED","reason":reason}
    obs.update({"date_utc":day,"symbol":symbol,"registered_at_utc_ms":now})
    head={"schema":ENTRY_SCHEMA,"sequence":len(old)+1,
          "previous_sha256":old[-1]["entry_sha256"] if old else GENESIS,
          "plan_sha256":plan_sha,"observation":obs}
    entry={**head,"entry_sha256":sha256(canonical(head))}
    p=Path(study)/"entries"/f"{len(old)+1:06d}.json"
    # Atomic exclusive open; collisions must fail, not silently overwrite.
    with p.open("xb") as f:
        f.write(canonical(entry)+b"\n")
    read_entries(study,plan,recheck_source=True)
    return entry["entry_sha256"]


def make_report(study,now=None):
    now=now_ms() if now is None else now
    plan,psha=study_plan(study)
    entries=read_entries(study,plan,recheck_source=True)
    found={(e["observation"]["date_utc"],e["observation"]["symbol"]):e["observation"]
           for e in entries}
    days=[]
    for b in plan["calendar"]:
        good=bad=missing=0
        for sym in b["symbols"]:
            obs=found.get((b["date_utc"],sym))
            if obs is None:
                missing+=1
            elif obs["status"]=="SOURCE_VERIFIED_NO_OUTCOME":
                good+=1
            else:
                bad+=1
        days.append({"date_utc":b["date_utc"],"split":b["split"],
                     "verified_source":good,"explicit_failure":bad,
                     "not_yet_registered":missing,"planned":5,
                     "future_quote_labels_verified":0})
    seal=Path(study)/"model-seal.json"
    model_lock_approved=False
    if seal.exists():
        s=load_json(seal)
        spec=Path(study)/"model-spec.json"
        if (s.get("schema")!=SEAL_SCHEMA or
            s.get("plan_sha256")!=psha or
            s.get("can_trade") is not False or
            type(s.get("frozen_at_utc_ms")) is not int or
            utc_day(s["frozen_at_utc_ms"])>=plan["holdout_first_day_utc"] or
            not spec.is_file() or
            sha256(spec.read_bytes())!=s.get("spec_sha256")):
            raise ValueError("Invalid or modified pre-holdout model seal/spec")
        model_lock_approved=True
    return {"schema":REPORT_SCHEMA,"study_plan_sha256":psha,
            "asof_utc_ms":now,"registered_source_receipts":len(entries),
            "source_verified_count":sum(d["verified_source"] for d in days),
            "explicit_failed_count":sum(d["explicit_failure"] for d in days),
            "source_unregistered_count":sum(d["not_yet_registered"] for d in days),
            "future_outcome_labels_verified":0,
            "holdout_sealed_model":model_lock_approved,
            "holdout_future_outcomes_not_evaluated":True,
            "calendar":days,
            "prior_v6_to_v11_evidence_included":False,
            "independent_alpha_validated":False,
            "status":"SOURCE_ONLY_AWAITING_FUTURE_DAYS_AND_AUTHENTIC_OUTCOMES",
            "can_trade":False,"can_start_paper":False}


def seal_model(study,spec_file,now=None):
    now=now_ms() if now is None else now
    plan,psha=study_plan(study)
    if utc_day(now)>=plan["holdout_first_day_utc"]:
        raise ValueError("Cannot freeze model after holdout begins")
    if (Path(study)/"model-seal.json").exists():
        raise FileExistsError("Holdout model seal already exists")
    raw=(Path(spec_file)).read_bytes()
    spec=strictly_decode(raw)
    if (spec.get("schema")!="algorithm_multiday_model_spec_v12"
        or not isinstance(spec.get("code_git_commit"),str)
        or not HEX64.fullmatch(spec["code_git_commit"])
        or not isinstance(spec.get("feature_logic"),str)
        or len(spec["feature_logic"])<30
        or type(spec.get("forward_horizon_ms")) is not int
        or spec["forward_horizon_ms"]<60_000
        or not isinstance(spec.get("outcome_source"),str)
        or len(spec["outcome_source"])<20
        or not isinstance(spec.get("baselines"),list)
        or not {"cash","flow_only","price_only"}.issubset(set(spec["baselines"]))):
        raise ValueError("No complete, predeclared prediction/evidence specification")
    seal={"schema":SEAL_SCHEMA,"plan_sha256":psha,
          "spec_sha256":sha256(raw),"frozen_at_utc_ms":now,
          "model_code_git_commit":spec["code_git_commit"],
          "evidence_authenticity_independently_proven":False,
          "actual_execution_verified":False,
          "can_trade":False}
    # Retain the original, exact model specification bytes in the study.
    # The seal verifies them on every later report, not only at creation.
    with (Path(study)/"model-spec.json").open("xb") as file:
        file.write(raw)
    save_exclusive(Path(study)/"model-seal.json",seal)
    return sha256((Path(study)/"model-seal.json").read_bytes())


def save_exclusive(path,obj):
    with Path(path).open("xb") as file:
        file.write(canonical(obj)+b"\n")


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cmd=cli.add_subparsers(dest="action",required=True)
    a=cmd.add_parser("init")
    a.add_argument("--universe",type=Path,required=True)
    a.add_argument("--study",type=Path,required=True)
    b=cmd.add_parser("register")
    b.add_argument("--study",type=Path,required=True)
    b.add_argument("--date",required=True)
    b.add_argument("--symbol",required=True)
    group=b.add_mutually_exclusive_group(required=True)
    group.add_argument("--capture",type=Path)
    group.add_argument("--missing-reason")
    c=cmd.add_parser("report")
    c.add_argument("--study",type=Path,required=True)
    c.add_argument("--out",type=Path)
    d=cmd.add_parser("seal")
    d.add_argument("--study",type=Path,required=True)
    d.add_argument("--model-spec",type=Path,required=True)
    args=cli.parse_args()
    if args.action=="init":
        result={"plan_sha256":initialize(args.universe,args.study),
                "study":str(args.study),"can_trade":False}
    elif args.action=="register":
        result={"source_receipt_sha256":register(
            args.study,args.date,args.symbol,args.capture,args.missing_reason),
            "can_trade":False}
    elif args.action=="seal":
        result={"model_seal_sha256":seal_model(args.study,args.model_spec),
                "can_trade":False}
    else:
        result=make_report(args.study)
        if args.out:
            save_exclusive(args.out,result)
        else:
            # Human console summary; full calendar always remains in the
            # study plan and can be exported later to a unique file.
            result={"status":result["status"],
                    "source_verified":result["source_verified_count"],
                    "source_unregistered":result["source_unregistered_count"],
                    "outcome_labels_verified":0,
                    "holdout_sealed_model":result["holdout_sealed_model"],
                    "can_trade":False}
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
