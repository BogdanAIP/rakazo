#!/usr/bin/env python3
"""Source-verified descriptive panel of exactly 50 microstructure observations.

One synchronized (but staggered in HTTP receipts) collection. No trading
signals or future-price outcome. Last-100 trade samples have INCOMPARABLE
durations; a depth snapshot alone does not show order replenishment.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from algorithm_microstructure_capture_v7 import (
    frozen_universe,verify,joint_asof,SCHEMA as SOURCE_SCHEMA,
)

SCHEMA="algorithm_microstructure_audit_v7"


def assemble(root,universe_path):
    root=Path(root)
    universe,universe_sha=frozen_universe(universe_path)
    receipts=[];rows=[];last=None;start=None
    stats={"eligible":0,"abstain":0,"aligned_sign":0,"opposite_sign":0,"zero_sign":0,
           "stale_book":0,"stale_taker":0,"reported_trade_events":0}
    for batch in range(1,11):
        folder=root/f"micro-v7-20261030-batch{batch:02d}"
        manifest,manifest_sha=verify(folder,universe,universe_sha,batch)
        sent=manifest["records"][0]["sent_ms"]
        end=manifest["records"][-1]["received_ms"]
        if last is not None and sent<last:
            raise ValueError("Overlapping or out-of-order source batches")
        start=sent if start is None else start
        last=end
        receipts.append({"batch":batch,"sha256":manifest_sha,
                         "first_sent_ms":sent,"last_received_ms":end,
                         "symbols":manifest["symbols"]})
        for sym in manifest["symbols"]:
            b=next(x for x in manifest["records"] if x["kind"]=="book" and x["symbol"]==sym)
            t=next(x for x in manifest["records"] if x["kind"]=="trades" and x["symbol"]==sym)
            ready=max(b["received_ms"],t["received_ms"])
            earlier=min(b["received_ms"],t["received_ms"])
            if joint_asof(manifest,sym,ready-1)["status"]!="ABSTAIN_UNRECEIVED":
                raise AssertionError("Source features leak into past")
            asof=joint_asof(manifest,sym,ready)
            stats["reported_trade_events"]+=t["observed"]["trade_count"]
            stats["stale_book"]+=int(b["observed"]["stale"])
            stats["stale_taker"]+=int(t["observed"]["newest_trade_stale"])
            if asof["status"]=="DESCRIPTIVE_ONLY":
                stats["eligible"]+=1
                obs=asof["observation"]
                book=Decimal(obs["book_imbalance"])
                taker=Decimal(obs["taker_last100_imbalance"])
                product=book*taker
                label="aligned_sign" if product>0 else "opposite_sign" if product<0 else "zero_sign"
                stats[label]+=1
            else:
                stats["abstain"]+=1
                obs=None
                label=None
            rows.append({
                "rank":len(rows)+1, "symbol":sym,
                "book_asof_complete_receive_ms":b["received_ms"],
                "trades_asof_complete_receive_ms":t["received_ms"],
                "joint_ready_ms":ready,
                "request_gap_ms":ready-earlier,
                "source_quality":asof["status"],
                "book":b["observed"],
                "recent_taker_trades":t["observed"],
                "signed_relation_descriptive_only":label,
                "no_forward_price_seen":True,"proposed_trade":None,
                "independent_observation_window":False,
            })
    symbols=[r["symbol"] for r in universe["members"]]
    if (len(rows)!=50 or [r["symbol"] for r in rows]!=symbols
            or stats["eligible"]+stats["abstain"]!=50 or
            stats["aligned_sign"]+stats["opposite_sign"]+stats["zero_sign"]!=stats["eligible"]):
        raise ValueError("Incomplete or inconsistent 50-market audit")
    if last-start>900_000:
        raise ValueError("Not a bounded one-time collection")
    spans=[x["recent_taker_trades"]["sample_span_ms"] for x in rows]
    sorted_spans=sorted(spans)
    return {
        "schema":SCHEMA,
        "universe_sha256":universe_sha,
        "raw_source_schema":SOURCE_SCHEMA,
        "source_manifest_hashes":receipts,
        "first_capture_request_ms":start,
        "last_capture_receipt_ms":last,
        "counts":stats,
        "trade_sample_span_min_ms":sorted_spans[0],
        "trade_sample_span_median_ms":(sorted_spans[24]+sorted_spans[25])/2,
        "trade_sample_span_max_ms":sorted_spans[-1],
        "symbols":rows,
        "one_staggered_market_time_block":True,
        "trades_latest100_not_complete_fixed_time":True,
        "orderbook_is_snapshot_not_replenishment":True,
        "book_rpi_depth_not_included":True,
        "no_historical_membership_proof":True,
        "source_flow_direction_only_taker_perspective":True,
        "independent_performance_validated":False,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--universe",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("No replacing a prior descriptive panel")
    result=assemble(args.root,args.universe)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as f:
        json.dump(result,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    print(json.dumps({"counts":result["counts"],
                      "trade_span_min_ms":result["trade_sample_span_min_ms"],
                      "trade_span_median_ms":result["trade_sample_span_median_ms"],
                      "trade_span_max_ms":result["trade_sample_span_max_ms"],
                      "all_raw_evidence_verified":True,
                      "can_trade":False}))


if __name__=="__main__":
    main()
