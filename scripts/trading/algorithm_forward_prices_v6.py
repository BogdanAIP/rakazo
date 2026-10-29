#!/usr/bin/env python3
"""Manual read-only OKX confirmed 15m candle capture for a FROZEN forward cohort.

NEVER run this before the preregistered outcome-collection timestamp.
No order routes, no API keys, no polling, no auto retry, no scheduler.
Five instruments per one manually invoked command, ranked before outcomes.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

from algorithm_pit_capture_v5 import BASE as PUBLIC_BASE, strict_json, epoch_ms

SCHEMA = "algorithm_forward_public_candles_v6"
BAR = 900_000
URL_ROOT = "https://www.okx.com/api/v5/market/candles"
LIMIT = 30
MAX_HTTP_BYTES = 150_000
MAX_REQUEST_MS = 20_000
FROZEN_SCHEMA = "algorithm_forward_frozen_v6"


def freeze_file(path, expected_sha256):
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Freeze not equal to Git-anchored preregistration SHA")
    data = strict_json(raw)
    rows = data.get("candidates")
    if (data.get("schema") != FROZEN_SCHEMA or len(rows) != 50
            or data.get("can_submit_orders") is not False
            or data.get("can_start_paper") is not False
            or sum(r.get("primary_included") is True for r in rows) != 5):
        raise ValueError("Unexpected cohort")
    if len(set(r["symbol"] for r in rows)) != 50 or any(r["rank"] != i+1 for i,r in enumerate(rows)):
        raise ValueError("Invalid cohort ranks")
    if (data["primary_exit_candle_open_ms"] - data["entry_candle_open_ms"] != 4*BAR
            or data["earliest_primary_outcome_collection_ms"] !=
            data["primary_exit_candle_open_ms"] + BAR):
        raise ValueError("No matching preregistered execution timeline")
    return data


def candles_url(symbol):
    if not re.fullmatch(r"[A-Z0-9]{2,20}-USDT-SWAP",symbol):
        raise ValueError("Invalid public perpetual")
    return f"{URL_ROOT}?instId={symbol}&bar=15m&limit={LIMIT}"


def public_read(url):
    if not (url == PUBLIC_BASE+"time" or
            re.fullmatch(re.escape(URL_ROOT)+r"\?instId=[A-Z0-9]{2,20}-USDT-SWAP&bar=15m&limit=30", url)):
        raise ValueError("Only approved PUBLIC time/candles routes")
    with urlopen(Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "Rakazo-forward-v6-readonly/1",
    }), timeout=8) as response:
        if response.status != 200:
            raise ValueError("Public HTTP error")
        raw = response.read(MAX_HTTP_BYTES+1)
    if not raw or len(raw) > MAX_HTTP_BYTES:
        raise ValueError("Unbounded candle response")
    return raw


def validate_candles(raw, received):
    data = strict_json(raw)
    if data.get("code") != "0" or not isinstance(data.get("data"),list):
        raise ValueError("Unexpected candle response")
    rows = data["data"]
    if not 5 <= len(rows) <= LIMIT:
        raise ValueError("Insufficient candle rows")
    last = None
    result = {}
    for row in rows:
        if not isinstance(row,list) or len(row) != 9:
            raise ValueError("Expected nine OHLCV fields")
        t = epoch_ms(row[0])
        if t%BAR != 0 or last is not None and t>=last:
            raise ValueError("Time not aligned or not strictly newest first")
        last=t
        if row[8] not in ("0","1"):
            raise ValueError("Invalid candle completion flag")
        try:
            o,h,l,c = (Decimal(x) for x in row[1:5])
            vol = (Decimal(x) for x in row[5:8])
        except Exception as err:
            raise ValueError("Malformed candle decimal") from err
        if (any(not x.is_finite() for x in (o,h,l,c,*vol))
                or any(x <= 0 for x in (o,h,l,c))
                or any(x < 0 for x in vol)
                or not l <= min(o,c) <= max(o,c) <= h):
            raise ValueError("Invalid OHLCV invariants")
        if t > received + BAR:
            raise ValueError("Candle from far future")
        if row[8] == "1" and t+BAR > received+1000:
            raise ValueError("Uncompleted candle marked complete")
        result[t] = {"open":row[1],"close":row[4],
                     "confirm":row[8]}
    return result


def capture_batch(frozen, batch, now, read):
    if type(batch) is not int or not 1 <= batch <= 10:
        raise ValueError("Only one of ten five-market batches")
    start_ms = now() if callable(now) else now
    if type(start_ms) is not int or start_ms < frozen["earliest_primary_outcome_collection_ms"]:
        raise ValueError("Outcomes cannot be accessed before locked time")
    symbols = [r["symbol"] for r in frozen["candidates"][(batch-1)*5:batch*5]]
    rows = []
    def collect(kind, sym, url):
        sent = now_fn()
        if sent < frozen["earliest_primary_outcome_collection_ms"]:
            raise ValueError("Attempted early price acquisition")
        payload = read(url)
        recv = now_fn()
        if not 0<=recv-sent<=MAX_REQUEST_MS:
            raise ValueError("Invalid public receipt interval")
        d = strict_json(payload)
        if kind == "time":
            if d.get("code") != "0" or len(d.get("data", [])) != 1:
                raise ValueError("Invalid server clock response")
            remote=epoch_ms(d["data"][0].get("ts"))
            if abs(remote-recv)>60_000:
                raise ValueError("Host and OKX clocks disagree")
        else:
            candles = validate_candles(payload, recv)
            a = frozen["entry_candle_open_ms"]
            b = frozen["primary_exit_candle_open_ms"]
            if a not in candles or b not in candles:
                raise ValueError("Missing fixed entry/exit candle")
            if candles[a]["confirm"] != "1" or candles[b]["confirm"] != "1":
                raise ValueError("Required forward candles not completed")
        rows.append(({"kind":kind,"symbol":sym,"url":url,
                      "request_sent_ms":sent,"received_complete_ms":recv,
                      "raw_file":f"{len(rows):02}-{kind}-{sym or 'server'}.json",
                      "body_sha256":hashlib.sha256(payload).hexdigest()},payload))
    # now may be a constant for a precondition OR callable injected by tests.
    now_fn = now if callable(now) else lambda: int(time.time_ns()//1_000_000)
    collect("time",None,PUBLIC_BASE+"time")
    for sym in symbols:
        collect("candles",sym,candles_url(sym))
    collect("time",None,PUBLIC_BASE+"time")
    manifest={"schema":SCHEMA,"batch":batch,"symbols":symbols,
              "freeze_sha256":frozen["_verified_sha256"],
              "only_completed_confirmed_forward_prices":True,
              "account_access":False,"can_trade":False,"records":[r for r,_ in rows]}
    return manifest,rows


def save_batch(path, manifest, rows):
    path=Path(path)
    if path.exists():
        raise FileExistsError("Captured evidence cannot be overwritten")
    if not path.parent.exists():
        raise FileNotFoundError("Existing research parent required")
    path.mkdir()
    for rec,raw in rows:
        (path/rec["raw_file"]).write_bytes(raw)
    (path/"manifest.json").write_bytes(
        (json.dumps(manifest,indent=2,sort_keys=True,allow_nan=False)+"\n").encode("utf8"))
    return hashlib.sha256((path/"manifest.json").read_bytes()).hexdigest()


def verify_batch(path, frozen, batch):
    path=Path(path)
    raw=(path/"manifest.json").read_bytes()
    d=strict_json(raw)
    symbols=[r["symbol"] for r in frozen["candidates"][(batch-1)*5:batch*5]]
    expected=[("time",None)]+[("candles",s) for s in symbols]+[("time",None)]
    if (d.get("schema")!=SCHEMA or d.get("batch")!=batch
            or d.get("symbols")!=symbols or
            d.get("freeze_sha256")!=frozen["_verified_sha256"]
            or d.get("account_access") is not False
            or d.get("can_trade") is not False
            or d.get("only_completed_confirmed_forward_prices") is not True
            or len(d.get("records",[]))!=7):
        raise ValueError("Unsafe or mismatched price batch")
    previous=None
    for i,(item,(kind,sym)) in enumerate(zip(d["records"],expected)):
        expected_url=PUBLIC_BASE+"time" if kind=="time" else candles_url(sym)
        if (item["kind"]!=kind or item["symbol"]!=sym
                or item["url"]!=expected_url
                or item["raw_file"]!=f"{i:02}-{kind}-{sym or 'server'}.json"):
            raise ValueError("Mismatched market/source file")
        sent,recv=item["request_sent_ms"],item["received_complete_ms"]
        if not type(sent) is int or not type(recv) is int or not 0<=recv-sent<=MAX_REQUEST_MS:
            raise ValueError("Invalid receipt")
        if previous is not None and sent<previous:
            raise ValueError("Nonchronological HTTP receipts")
        if sent < frozen["earliest_primary_outcome_collection_ms"]:
            raise ValueError("Price endpoint accessed too early")
        previous=recv
        payload=(path/item["raw_file"]).read_bytes()
        if hashlib.sha256(payload).hexdigest()!=item["body_sha256"]:
            raise ValueError("Tampered public candles")
        if kind=="candles":
            parsed=validate_candles(payload,recv)
            for t in (frozen["entry_candle_open_ms"],frozen["primary_exit_candle_open_ms"]):
                if t not in parsed or parsed[t]["confirm"]!="1":
                    raise ValueError("Invalid frozen market entry/exit candle")
        else:
            data=strict_json(payload)
            if data.get("code")!="0" or len(data.get("data",[]))!=1 or abs(epoch_ms(data["data"][0].get("ts"))-recv)>60_000:
                raise ValueError("Invalid public clock receipt")
    return d,hashlib.sha256(raw).hexdigest()


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--freeze",required=True,type=Path)
    cli.add_argument("--expected-freeze-sha256",required=True)
    cli.add_argument("--batch",required=True,type=int)
    cli.add_argument("--out-dir",required=True,type=Path)
    args=cli.parse_args()
    if args.out_dir.exists():
        raise FileExistsError("No overwrite")
    freeze=freeze_file(args.freeze,args.expected_freeze_sha256)
    freeze["_verified_sha256"]=args.expected_freeze_sha256
    now=time.time_ns()//1_000_000
    if now<freeze["earliest_primary_outcome_collection_ms"]:
        raise ValueError("Do not acquire forward outcome before frozen earliest time")
    manifest,rows=capture_batch(freeze,args.batch,now,public_read)
    sha=save_batch(args.out_dir,manifest,rows)
    verify_batch(args.out_dir,freeze,args.batch)
    print(json.dumps({"batch":args.batch,"markets":5,"manifest_sha256":sha,
                      "prices_verified":True,"submitted_orders":False}))


if __name__=="__main__":
    main()
