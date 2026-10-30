#!/usr/bin/env python3
"""v11 bounded 60-90sec future public best-quote outcome on NEW 8sec flow captures.

Explicit CLI freeze -> exit (only after 60sec) -> score; no orders, accounts,
background jobs, schedulers, private endpoints, or automated retry.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import time

from algorithm_ws_buckets_v8 import build_buckets
from algorithm_ws_audit_v8 import strict_load
from algorithm_microstructure_capture_v7 import book_url,read_public,analyze_book

SCHEMA="algorithm_minute_marketable_v11"
FREEZE="algorithm_minute_signal_lock_v11"
EXIT="algorithm_minute_exit_quote_v11"
CAPTURES=(("btc",1),("sol",1),("btc",2),("sol",2))
MIN_WAIT_MS=60_000
MAX_WAIT_MS=90_000
BASE=Decimal(".0005")
STRESS=Decimal(".0007")
BPS=Decimal(10000)


def exact_bytes(path, limit=2_000_000):
    raw=Path(path).read_bytes()
    if not 0<len(raw)<=limit:
        raise ValueError("Empty or too-large research file")
    return raw,hashlib.sha256(raw).hexdigest()


def source_folder(root,symbol,run):
    if (symbol,run) not in CAPTURES:
        raise ValueError("Only registered NEW sources accepted")
    return Path(root)/f"ws-v11-{symbol}-20261030-run{run:02d}"


def lock_path(root,symbol,run):
    return Path(root)/f"ws-v11-{symbol}-20261030-run{run:02d}-freeze.json"


def outcome_folder(root,symbol,run):
    return Path(root)/f"ws-v11-{symbol}-20261030-run{run:02d}-exit"


def utc_now():
    return time.time_ns()//1_000_000


def freeze(source, symbol, run, when_ms):
    if type(when_ms) is not int or when_ms<=0:
        raise ValueError("Invalid lock clock")
    x=build_buckets(source)
    if x["symbol"]!=symbol.upper()+"-USDT-SWAP":
        raise ValueError("Wrong instrument")
    end=x["window_end_utc_ms"]
    if not end<=when_ms<end+MIN_WAIT_MS:
        raise ValueError("Freeze must precede earliest exit inquiry")
    bins=x["one_second_bins"]
    def half(rows):
        return (
            sum(Decimal(b["buy_taker_contracts"]) for b in rows),
            sum(Decimal(b["sell_taker_contracts"]) for b in rows),
            sum(b["fill_count"] for b in rows))
    eb,es,ec=half(bins[:4]);lb,ls,lc=half(bins[4:])
    f_early=eb-es
    f_late=lb-ls
    current=bins[7]
    complete=x["bins_with_both_streams"]
    qtime=current["book_end_asof_ms"]
    quote_ok=(type(qtime) is int and 0<=end-qtime<=500
              and current["book_update_count"]>=1
              and current["best_bid"] is not None
              and current["best_ask"] is not None)
    source_quality=bool(ec>=5 and lc>=5 and complete>=6 and quote_ok)
    side=None
    if source_quality and f_early*f_late>0:
        side=1 if f_early>0 else -1
    flow_side=1 if eb+lb>es+ls else -1 if eb+lb<es+ls else None
    price_side=None
    if quote_ok and bins[0]["best_bid"] and bins[0]["best_ask"]:
        oldmid=(Decimal(bins[0]["best_bid"])+Decimal(bins[0]["best_ask"]))/2
        newmid=(Decimal(current["best_bid"])+Decimal(current["best_ask"]))/2
        price_side=1 if newmid>oldmid else -1 if newmid<oldmid else None
    mb,manifest_sha=exact_bytes(Path(source)/"manifest.json",100_000)
    raw_manifest=strict_load(mb)
    if raw_manifest["symbol"]!=x["symbol"] or raw_manifest["end_utc_ms"]!=end:
        raise ValueError("Source mismatch in exact manifest")
    return {
        "schema":FREEZE,"protocol":"docs/trading/ALGORITHM-MINUTE-QUOTE-PROTOCOL-v11-20261030.md",
        "symbol":x["symbol"],"run":run,
        "source_manifest_sha256":manifest_sha,
        "source_messages_sha256":x["source_messages_sha256"],
        "source_end_utc_ms":end,
        "freeze_created_utc_ms":when_ms,
        "earliest_exit_request_utc_ms":end+MIN_WAIT_MS,
        "latest_exit_complete_utc_ms":end+MAX_WAIT_MS,
        "entry_quote_from_last_full_second":quote_ok,
        "entry_best_bid":current["best_bid"] if quote_ok else None,
        "entry_best_ask":current["best_ask"] if quote_ok else None,
        "entry_quote_received_utc_ms":qtime if quote_ok else None,
        "full_joint_seconds":complete,
        "early_fills":ec,"late_fills":lc,
        "early_buy_contracts":str(eb),"early_sell_contracts":str(es),
        "late_buy_contracts":str(lb),"late_sell_contracts":str(ls),
        "primary_direction":side,
        "primary_eligible":side is not None,
        "flow_only_direction":flow_side if source_quality else None,
        "price_only_direction":price_side if source_quality else None,
        "quality_gate_passed":source_quality,
        "source_only_no_future_quote_seen":True,
        "can_trade":False,"can_start_paper":False,
    }


def save_new_json(path,data):
    p=Path(path)
    if p.exists():
        raise FileExistsError("Never overwrite an evidence file")
    p.parent.mkdir(parents=True,exist_ok=True)
    with p.open("x",encoding="utf8") as f:
        json.dump(data,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    return hashlib.sha256(p.read_bytes()).hexdigest()


def validate_lock(raw,source,expected_symbol,run):
    lock=strict_load(raw)
    if (lock.get("schema")!=FREEZE
        or lock.get("symbol")!=expected_symbol
        or lock.get("run")!=run
        or lock.get("can_trade") is not False
        or lock.get("can_start_paper") is not False
        or lock.get("source_only_no_future_quote_seen") is not True):
        raise ValueError("Invalid locked source metadata")
    mb,sha=exact_bytes(Path(source)/"manifest.json",100_000)
    msg,ms=exact_bytes(Path(source)/"messages.jsonl",36_000_000)
    if sha!=lock["source_manifest_sha256"] or ms!=lock["source_messages_sha256"]:
        raise ValueError("Source changed since hypothesis freeze")
    if strict_load(mb)["end_utc_ms"]!=lock["source_end_utc_ms"]:
        raise ValueError("Wrong source UTC")
    if (lock["earliest_exit_request_utc_ms"]!=lock["source_end_utc_ms"]+MIN_WAIT_MS
        or lock["latest_exit_complete_utc_ms"]!=lock["source_end_utc_ms"]+MAX_WAIT_MS):
        raise ValueError("Changed forward outcome rule")
    return lock


def collect_exit(lock,lock_sha,*,read=read_public,clock=utc_now):
    earliest=lock["earliest_exit_request_utc_ms"]
    latest=lock["latest_exit_complete_utc_ms"]
    sent=clock()
    if type(sent) is not int or not earliest<=sent<=latest:
        raise ValueError("Exit quote cannot be requested outside frozen 60-90s window")
    url=book_url(lock["symbol"])
    raw=read(url)
    received=clock()
    if type(received) is not int or not sent<=received<=latest:
        raise ValueError("Incomplete or late public source outcome")
    book=analyze_book(raw,received)
    timestamp=book["exchange_generation_ms"]
    if not earliest<=timestamp<=received+1000 or received-timestamp>5000:
        raise ValueError("Exit book generation is outside forward window")
    return {
        "schema":EXIT,"symbol":lock["symbol"],"run":lock["run"],
        "freeze_sha256":lock_sha,"url":url,
        "request_sent_utc_ms":sent,"response_received_complete_utc_ms":received,
        "exchange_book_generation_utc_ms":timestamp,
        "elapsed_since_source_end_ms":received-lock["source_end_utc_ms"],
        "book":book,"raw_sha256":hashlib.sha256(raw).hexdigest(),
        "can_trade":False,"can_start_paper":False,
    },raw


def save_exit(path,meta,raw):
    p=Path(path)
    if p.exists():
        raise FileExistsError("No overwrite of source outcome")
    if not p.parent.is_dir():
        raise FileNotFoundError("Existing output parent needed")
    p.mkdir()
    (p/"raw.json").write_bytes(raw)
    (p/"manifest.json").write_bytes(
        (json.dumps(meta,indent=2,sort_keys=True,allow_nan=False)+"\n").encode("utf8"))
    return hashlib.sha256((p/"manifest.json").read_bytes()).hexdigest()


def read_exit(path,freeze_sha,lock):
    p=Path(path)
    mb,msha=exact_bytes(p/"manifest.json",100_000)
    meta=strict_load(mb)
    raw,rsha=exact_bytes(p/"raw.json",100_000)
    if (meta.get("schema")!=EXIT
        or meta.get("symbol")!=lock["symbol"]
        or meta.get("run")!=lock["run"]
        or meta.get("freeze_sha256")!=freeze_sha
        or meta.get("url")!=book_url(lock["symbol"])
        or meta.get("raw_sha256")!=rsha
        or meta.get("can_trade") is not False
        or meta.get("can_start_paper") is not False):
        raise ValueError("Invalid or modified outcome provenance")
    sent,received=meta["request_sent_utc_ms"],meta["response_received_complete_utc_ms"]
    if not(lock["earliest_exit_request_utc_ms"]<=sent<=received<=lock["latest_exit_complete_utc_ms"]):
        raise ValueError("Exit source violates frozen time gate")
    check=analyze_book(raw,received)
    if (check!=meta["book"] or
        not lock["earliest_exit_request_utc_ms"]<=check["exchange_generation_ms"]<=received+1000
        or received-check["exchange_generation_ms"]>5000):
        raise ValueError("Exit book does not match source or clock")
    return meta,msha


def marketable(direction,lock,book):
    if type(direction) is not int or direction not in (-1,1):
        raise ValueError("Only declared hypothetical direction")
    entry_bid=Decimal(lock["entry_best_bid"])
    entry_ask=Decimal(lock["entry_best_ask"])
    exit_bid=Decimal(book["best_bid"])
    exit_ask=Decimal(book["best_ask"])
    if not (0<entry_bid<entry_ask and 0<exit_bid<exit_ask):
        raise ValueError("Crossed market")
    ratio=exit_bid/entry_ask if direction==1 else exit_ask/entry_bid
    gross=BPS*((ratio-1) if direction==1 else (1-ratio))
    def net(fee):
        return gross-BPS*fee*(1+ratio)
    return {"direction":direction,"gross_cross_quote_bps":str(gross),
            "base_5bps_side_net_bps":str(net(BASE)),
            "stress_7bps_side_net_bps":str(net(STRESS)),
            "fees_are_scenarios_not_account_verified":True,
            "guaranteed_executed":False}


def score_all(root):
    attempts=[]
    base=[]
    flow=[]
    price=[]
    complete=0
    for symbol,run in CAPTURES:
        source=source_folder(root,symbol,run)
        locked=lock_path(root,symbol,run)
        record={"symbol":symbol.upper()+"-USDT-SWAP","run":run,
                "source_folder":source.name,"source_freeze":locked.name,
                "exit_folder":outcome_folder(root,symbol,run).name}
        try:
            fb,sha=exact_bytes(locked,100_000)
            lock=validate_lock(fb,source,record["symbol"],run)
            meta,exit_sha=read_exit(outcome_folder(root,symbol,run),sha,lock)
            record.update({"status":"VERIFIED","freeze_sha256":sha,
                           "exit_manifest_sha256":exit_sha,
                           "entry_quote_utc_ms":lock["entry_quote_received_utc_ms"],
                           "exit_book_source_utc_ms":meta["exchange_book_generation_utc_ms"],
                           "horizon_observed_ms":meta["elapsed_since_source_end_ms"],
                           "quality_gate":lock["quality_gate_passed"],
                           "primary_eligible":lock["primary_eligible"],
                           "primary_direction":lock["primary_direction"],
                           "entry_bid":lock["entry_best_bid"],
                           "entry_ask":lock["entry_best_ask"],
                           "exit_bid":meta["book"]["best_bid"],
                           "exit_ask":meta["book"]["best_ask"]})
            complete+=1
            for key,dest in (("primary_direction",base),
                             ("flow_only_direction",flow),
                             ("price_only_direction",price)):
                if lock["quality_gate_passed"] and lock[key] is not None:
                    proxy=marketable(lock[key],lock,meta["book"])
                    record[key+"_score"]=proxy
                    dest.append(proxy)
            if record["primary_eligible"]:
                record["opposite_on_identical_primary"]=marketable(
                    -lock["primary_direction"],lock,meta["book"])
        except (FileNotFoundError,ValueError,KeyError,TypeError,UnicodeError) as e:
            record["status"]="INCOMPLETE_OR_REJECTED"
            record["rejection"]=f"{type(e).__name__}: {str(e)[:180]}"
        attempts.append(record)
    def means(rows):
        if not rows:
            return None
        out={}
        for k in ("gross_cross_quote_bps","base_5bps_side_net_bps","stress_7bps_side_net_bps"):
            out[k]=str(sum((Decimal(x[k]) for x in rows),Decimal(0))/len(rows))
        return out
    verdict=("INCOMPLETE_VALIDATION" if complete!=len(CAPTURES)
             else "INSUFFICIENT_PRIMARY_EVENTS" if not base
             else "DESCRIPTIVELY_POSITIVE_NOT_VALIDATED" if
                Decimal(means(base)["base_5bps_side_net_bps"])>0
             else "NEGATIVE_PILOT_NOT_VALIDATED")
    return {"schema":SCHEMA,"attempts":attempts,
            "planned_captures":4,"verified_outcomes":complete,
            "primary_events":len(base),"flow_only_control_events":len(flow),
            "price_only_control_events":len(price),
            "primary_quote_crossing":means(base),
            "flow_only_control":means(flow),
            "price_only_control":means(price),
            "zero_position_cash_bps":"0",
            "verdict":verdict,"independent_statistical_validation":False,
            "fees_account_verified":False,"actual_fills_verified":False,
            "can_start_paper":False,"can_trade":False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    sub=p.add_subparsers(dest="action",required=True)
    f=sub.add_parser("freeze")
    f.add_argument("--root",type=Path,required=True)
    f.add_argument("--symbol",required=True,choices=["btc","sol"])
    f.add_argument("--run",type=int,required=True)
    x=sub.add_parser("exit")
    x.add_argument("--root",type=Path,required=True)
    x.add_argument("--symbol",required=True,choices=["btc","sol"])
    x.add_argument("--run",type=int,required=True)
    s=sub.add_parser("score")
    s.add_argument("--root",type=Path,required=True)
    s.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.action=="score":
        if a.out.exists():
            raise FileExistsError("Previous outcome score must not be overwritten")
        report=score_all(a.root)
        digest=save_new_json(a.out,report)
        print(json.dumps({"sha256":digest,"verdict":report["verdict"],
                          "outcomes":report["verified_outcomes"],
                          "primary":report["primary_quote_crossing"],"can_trade":False}))
        return
    source=source_folder(a.root,a.symbol,a.run)
    path=lock_path(a.root,a.symbol,a.run)
    if a.action=="freeze":
        if path.exists():
            raise FileExistsError("Never change a frozen hypothesis")
        result=freeze(source,a.symbol,a.run,utc_now())
        sha=save_new_json(path,result)
        print(json.dumps({"lock_sha256":sha,"symbol":result["symbol"],
                          "run":a.run,"primary_direction":result["primary_direction"],
                          "quality_gate":result["quality_gate_passed"],
                          "earliest_ms":result["earliest_exit_request_utc_ms"],
                          "latest_ms":result["latest_exit_complete_utc_ms"]}))
    else:
        out=outcome_folder(a.root,a.symbol,a.run)
        if out.exists():
            raise FileExistsError("No overwriting source quote evidence")
        fb,sha=exact_bytes(path,100_000)
        lock=validate_lock(fb,source,a.symbol.upper()+"-USDT-SWAP",a.run)
        meta,raw=collect_exit(lock,sha)
        digest=save_exit(out,meta,raw)
        read_exit(out,sha,lock)
        print(json.dumps({"exit_manifest_sha256":digest,
                          "run":a.run,"symbol":lock["symbol"],
                          "elapsed_ms":meta["elapsed_since_source_end_ms"],
                          "can_trade":False}))


if __name__=="__main__":
    main()
