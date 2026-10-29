#!/usr/bin/env python3
"""v7 bounded manual future-candle acquisition, derived from verified v6 primitives.

The v7 lock is a DIFFERENT hypothesis/contract; use its exact SHA only.
No price request is made before the locked +75-minute time. Pure public URLs.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import time

from algorithm_pit_capture_v5 import strict_json
from algorithm_forward_prices_v6 import (
    BAR, capture_batch, save_batch, verify_batch, public_read,
    validate_candles,
)

SCHEMA="algorithm_microstructure_forward_lock_v7"
LOCKED_ROOT="micro-v7-prices-20261030-batch"


def read_lock(path,sha):
    original=Path(path).read_bytes()
    if hashlib.sha256(original).hexdigest()!=sha:
        raise ValueError("Frozen hypothesis file bytes changed")
    f=strict_json(original)
    rows=f.get("candidates")
    if (f.get("schema")!=SCHEMA or f.get("market_count")!=50
            or not isinstance(rows,list) or len(rows)!=50
            or f.get("can_start_paper") is not False
            or f.get("can_submit_orders") is not False
            or f.get("independent_test") is not False
            or f.get("trades_sample_last100_not_fixed_interval") is not True):
        raise ValueError("Unsafe or unrecognized research lock")
    if (f["primary_exit_open_utc_ms"]-f["entry_open_utc_ms"]!=4*BAR
            or f["diagnostic_exit_open_utc_ms"]-f["entry_open_utc_ms"]!=BAR
            or f["earliest_outcome_read_utc_ms"]!=f["entry_open_utc_ms"]+5*BAR):
        raise ValueError("Hypothesis future horizon mismatch")
    n=sum(row["include_in_primary"] is True for row in rows)
    if n!=f["qualifying_count"] or n<1:
        raise ValueError("Frozen primary cohort size altered")
    weight=Decimal(f["per_included_initial_equity_notional"])
    if not weight.is_finite() or weight<=0 or abs(weight*n-Decimal("0.5"))>Decimal("1e-20"):
        raise ValueError("Unfrozen portfolio allocation")
    for i,row in enumerate(rows):
        if row["rank"]!=i+1:
            raise ValueError("Rank reorder")
        if row["include_in_primary"] is True:
            if row["observed_relation"]!="opposite_sign" or type(row["primary_hypothetical_direction"]) is not int or row["primary_hypothetical_direction"] not in (-1,1):
                raise ValueError("Invalid preregistered sign")
        elif row["primary_hypothetical_direction"] is not None:
            raise ValueError("Nonprimary market cannot trade")
    return f


def adapted(f,sha):
    """Translate field names only: all original source lock constraints persist."""
    return {
        "_verified_sha256":sha,
        "candidates":f["candidates"],
        "entry_candle_open_ms":f["entry_open_utc_ms"],
        "primary_exit_candle_open_ms":f["primary_exit_open_utc_ms"],
        "diagnostic_exit_candle_open_ms":f["diagnostic_exit_open_utc_ms"],
        "earliest_primary_outcome_collection_ms":f["earliest_outcome_read_utc_ms"],
    }


def fractional_proxy(entry,ex,side,weight,fee):
    entry,ex=Decimal(entry),Decimal(ex)
    fee=Decimal(fee)
    if entry<=0 or ex<=0 or not entry.is_finite() or not ex.is_finite():
        raise ValueError("Invalid OHLC trade price")
    if type(side) is not int or side not in (-1,1):
        raise ValueError("Not a hypothesis direction")
    ratio=ex/entry
    gross=weight*side*(ratio-1)
    drag=weight*fee*(ratio+1)
    return {"gross_fraction":str(gross),"cost_fraction":str(drag),
            "net_fraction":str(gross-drag)}


def evaluate(lock,lock_sha,root):
    adapted_lock=adapted(lock,lock_sha)
    root=Path(root)
    exposure=Decimal(lock["per_included_initial_equity_notional"])
    records=[];verified=[]
    last=None
    for k in range(1,11):
        folder=root/f"{LOCKED_ROOT}{k:02d}"
        manifest,hashval=verify_batch(folder,adapted_lock,k)
        send=manifest["records"][0]["request_sent_ms"]
        if last is not None and send<last:
            raise ValueError("Nonchronological public price captures")
        last=manifest["records"][-1]["received_complete_ms"]
        verified.append(hashval)
        for j,item in enumerate(lock["candidates"][(k-1)*5:k*5]):
            i=j+1
            rec=manifest["records"][i]
            if rec["symbol"]!=item["symbol"] or rec["kind"]!="candles":
                raise ValueError("Wrong source of price candle")
            bars=validate_candles((folder/rec["raw_file"]).read_bytes(),
                                   rec["received_complete_ms"])
            a=lock["entry_open_utc_ms"]
            b=lock["primary_exit_open_utc_ms"]
            c=lock["diagnostic_exit_open_utc_ms"]
            if any(t not in bars or bars[t]["confirm"]!="1" for t in (a,b,c)):
                raise ValueError("Missing confirmed fixed entry/exit prices")
            entry,primary,diagnostic=[bars[t]["open"] for t in (a,b,c)]
            row={
                "rank":item["rank"],"symbol":item["symbol"],
                "source_relation":item["observed_relation"],
                "primary_included":item["include_in_primary"],
                "primary_side":item["primary_hypothetical_direction"],
                "entry_open":entry,"exit_open_60m":primary,
                "exit_open_15m":diagnostic,
                "future_return_for_all_rows_fraction":str(Decimal(primary)/Decimal(entry)-1),
                "real_fills_verified":False,"real_funding_cashflow_included":False,
                "primary_position_hypothetical":None,
            }
            if item["include_in_primary"]:
                side=item["primary_hypothetical_direction"]
                row["primary_position_hypothetical"]={
                    "base_7bps_per_side":fractional_proxy(entry,primary,side,exposure,lock["cost_per_side_base"]),
                    "stress_14bps_per_side":fractional_proxy(entry,primary,side,exposure,lock["cost_per_side_stress"]),
                    "diagnostic_15min_base":fractional_proxy(entry,diagnostic,side,exposure,lock["cost_per_side_base"]),
                }
            records.append(row)
    if len(records)!=50 or len(set(x["symbol"] for x in records))!=50:
        raise ValueError("Incomplete frozen market set")
    selected=[x for x in records if x["primary_included"]]
    if len(selected)!=lock["qualifying_count"]:
        raise ValueError("Selected subset differs from preregistration")
    base=sum((Decimal(x["primary_position_hypothetical"]["base_7bps_per_side"]["net_fraction"])
              for x in selected),Decimal(0))
    stress=sum((Decimal(x["primary_position_hypothetical"]["stress_14bps_per_side"]["net_fraction"])
              for x in selected),Decimal(0))
    return {
        "schema":"algorithm_microstructure_forward_outcome_v7",
        "frozen_hypothesis_sha256":lock_sha,
        "raw_candle_batch_manifest_sha256":verified,
        "summary":{"eligible_positions":len(selected),"abstain":50-len(selected),
                   "market_count":50,
                   "one_correlated_time_block":True,
                   "net_initial_equity_fraction_base":str(base),
                   "net_initial_equity_fraction_stress":str(stress)},
        "all_markets":records,
        "real_margin_contract_and_funding_simulator":False,
        "independent_performance_validated":False,
        "decision":"INSUFFICIENT_INDEPENDENT_EVIDENCE",
        "inferential_p_value":None,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    a=argparse.ArgumentParser(description=__doc__)
    a.add_argument("--freeze",required=True,type=Path)
    a.add_argument("--expected-freeze-sha256",required=True)
    a.add_argument("--root",required=True,type=Path)
    a.add_argument("--batch",type=int)
    a.add_argument("--out",type=Path)
    args=a.parse_args()
    lock=read_lock(args.freeze,args.expected_freeze_sha256)
    if args.batch is not None:
        if args.out is None or args.out.exists():
            raise FileExistsError("A unique output directory required")
        if not 1<=args.batch<=10:
            raise ValueError("Only one of ten batches")
        if time.time_ns()//1_000_000 < lock["earliest_outcome_read_utc_ms"]:
            raise ValueError("PROHIBITED: future price read before frozen time")
        meta,records=capture_batch(adapted(lock,args.expected_freeze_sha256),
                                   args.batch,int(time.time_ns()//1_000_000),public_read)
        sha=save_batch(args.out,meta,records)
        verify_batch(args.out,adapted(lock,args.expected_freeze_sha256),args.batch)
        print(json.dumps({"batch":args.batch,"source_sha256":sha,
                          "count":5,"traded":False}))
    else:
        if args.out is None or args.out.exists():
            raise FileExistsError("A unique output file required")
        report=evaluate(lock,args.expected_freeze_sha256,args.root)
        args.out.parent.mkdir(parents=True,exist_ok=True)
        with args.out.open("x",encoding="utf8") as stream:
            json.dump(report,stream,indent=2,sort_keys=True,allow_nan=False)
            stream.write("\n")
        print(json.dumps({"summary":report["summary"],
                          "decision":report["decision"],"traded":False}))


if __name__=="__main__":
    main()
