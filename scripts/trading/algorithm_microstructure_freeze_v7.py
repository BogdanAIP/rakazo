#!/usr/bin/env python3
"""Freeze v7 antagonistic book/taker evidence before seeing future prices.

All 50 source rows are independently reconstructed from raw OKX responses.
Not a buy/sell order, not a historical backtest or an independent alpha claim.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import time

from algorithm_microstructure_audit_v7 import assemble
from algorithm_pit_capture_v5 import strict_json

SCHEMA="algorithm_microstructure_forward_lock_v7"
BAR=900_000
GUARD=300_000
MAX_FREEZE_LAG_MS=900_000


def freeze(root,universe,audit_file,now):
    if type(now) is not int or now<=0:
        raise ValueError("Explicit UTC millisecond freeze time")
    audit_bytes=Path(audit_file).read_bytes()
    saved=strict_json(audit_bytes)
    rebuilt=assemble(root,universe)
    if saved!=rebuilt:
        raise ValueError("Audit differs from raw source reconstruction")
    last=saved["last_capture_receipt_ms"]
    if not 0<=now-last<=MAX_FREEZE_LAG_MS:
        raise ValueError("Freeze must follow verified source capture promptly")
    entries=[]
    for index,row in enumerate(saved["symbols"]):
        if row["rank"]!=index+1:
            raise ValueError("Out of order rank")
        side=None
        if row["source_quality"]=="DESCRIPTIVE_ONLY" and row["signed_relation_descriptive_only"]=="opposite_sign":
            depth=Decimal(row["book"]["top5_depth_imbalance"])
            flow=Decimal(row["recent_taker_trades"]["last100_taker_imbalance"])
            if not depth.is_finite() or not flow.is_finite() or depth*flow>=0:
                raise ValueError("Expected nonzero opposite signs")
            side=1 if depth>0 else -1
        entries.append({
            "rank":row["rank"],"symbol":row["symbol"],
            "source_quality":row["source_quality"],
            "observed_relation":row["signed_relation_descriptive_only"],
            "primary_hypothetical_direction":side,
            "include_in_primary":side is not None,
            "future_return_seen":False,
            "origin_received_not_before_ms":row["joint_ready_ms"],
        })
    n=sum(r["include_in_primary"] for r in entries)
    if n!=saved["counts"]["opposite_sign"] or n<1:
        raise ValueError("Empty or mismatched primary hypothesis")
    future_after=max(now+GUARD,last)
    entry=(future_after//BAR+1)*BAR
    per_position=Decimal("0.5")/Decimal(n)
    return {
        "schema":SCHEMA,
        "protocol":"docs/trading/ALGORITHM-MICROSTRUCTURE-PROTOCOL-v7-20261030.md",
        "source_audit_sha256":hashlib.sha256(audit_bytes).hexdigest(),
        "source_universe_sha256":saved["universe_sha256"],
        "freeze_utc_ms":now,
        "last_source_received_ms":last,
        "write_guard_ms":GUARD,
        "entry_open_utc_ms":entry,
        "primary_exit_open_utc_ms":entry+4*BAR,
        "diagnostic_exit_open_utc_ms":entry+BAR,
        "earliest_outcome_read_utc_ms":entry+5*BAR,
        "fixed_hypothesis":"opposite_sign_book_taker_60m_follow_book_side",
        "cost_per_side_base":"0.0007",
        "cost_per_side_stress":"0.0014",
        "total_initial_equity_notional_budget":"0.5",
        "per_included_initial_equity_notional":str(per_position),
        "qualifying_count":n,"market_count":len(entries),
        "candidates":entries,
        "trades_sample_last100_not_fixed_interval":True,
        "non_atomic_source_acquisition":True,
        "historical_universe_membership_verified":False,
        "independent_test":False,
        "can_submit_orders":False,"can_start_paper":False,
    }


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--root",type=Path,required=True)
    cli.add_argument("--universe",type=Path,required=True)
    cli.add_argument("--audit",type=Path,required=True)
    cli.add_argument("--out",type=Path,required=True)
    args=cli.parse_args()
    if args.out.exists():
        raise FileExistsError("Never change a prior research freeze")
    result=freeze(args.root,args.universe,args.audit,int(time.time_ns()//1_000_000))
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as fd:
        json.dump(result,fd,indent=2,sort_keys=True,allow_nan=False)
        fd.write("\n")
    print(json.dumps({"freeze_sha256":hashlib.sha256(args.out.read_bytes()).hexdigest(),
        "entry_open_utc_ms":result["entry_open_utc_ms"],
        "earliest_outcome_read_utc_ms":result["earliest_outcome_read_utc_ms"],
        "primary_candidates":result["qualifying_count"],
        "outcomes_downloaded":False,"can_trade":False}))


if __name__=="__main__":
    main()
