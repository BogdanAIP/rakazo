#!/usr/bin/env python3
"""v17: same-day stand-alone source-only BTC/SOL exploratory pilot.

This does NOT register into the immutable Nov1-12 v12 study or request
future prices. Existing v14/v15 hypotheses must predate each raw capture.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
import json
from pathlib import Path

from algorithm_ws_buckets_v8 import build_buckets
from algorithm_ai_research_v14 import registered,source_only_signal
from algorithm_multiday_registry_v12 import canonical,sha256

SCHEMA="algorithm_oct30_source_preflight_v17"
DAY="2026-10-30"
SYMBOLS={
    "BTC-USDT-SWAP":"ws-v17-oct30-btc-01",
    "SOL-USDT-SWAP":"ws-v17-oct30-sol-01",
}
CANDIDATES=("flow-memory-flip-20261030",
            "impact-efficiency-decay-20261030")


def run(source,study,symbol):
    if symbol not in SYMBOLS or Path(source).name!=SYMBOLS[symbol]:
        raise ValueError("Only two locked preflight source folders are allowed")
    rows=build_buckets(source)
    if rows["symbol"]!=symbol:
        raise ValueError("Source symbol not preregistered")
    start=rows["window_start_utc_ms"]
    end=rows["window_end_utc_ms"]
    if (datetime.fromtimestamp(start/1000,timezone.utc).date().isoformat()!=DAY or
        datetime.fromtimestamp(end/1000,timezone.utc).date().isoformat()!=DAY or
        not 7500<=end-start<=8500):
        raise ValueError("Source does not match preregistered UTC day/duration")
    records={p["id"]:(header,p) for header,p in registered(study)}
    if set(CANDIDATES)-set(records):
        raise ValueError("A fixed AI hypothesis was not registered")
    results=[]
    for name in CANDIDATES:
        header,p=records[name]
        if header["registered_utc_ms"]>=start:
            raise ValueError("AI hypothesis would be post-source")
        signal=source_only_signal(rows,p)
        if signal["future_quote_labels_accessed"] is not False or signal["can_trade"] is not False:
            raise ValueError("Invalid source-only state")
        results.append({
            "candidate_id":name,
            "proposal_sha256":header["proposal_sha256"],
            "candidate_ledger_entry_sha256":header["entry_sha256"],
            "source_only_signal":signal,
        })
    return {
        "schema":SCHEMA,
        "scope":"EXPLORATORY_EXCLUDED_FROM_V12_CALENDAR_AND_HOLDOUT",
        "source_folder":Path(source).name,
        "symbol":symbol,
        "capture_start_utc_ms":start,"capture_end_utc_ms":end,
        "original_source_manifest_sha256":rows["source_manifest_sha256"],
        "original_source_messages_sha256":rows["source_messages_sha256"],
        "book_sequence_audited":True,
        "source_seconds_with_both_streams":rows["bins_with_both_streams"],
        "two_hypotheses_do_not_create_independent_samples":True,
        "candidate_checks":results,
        "candidate_eligible_count":sum(x["source_only_signal"]["eligible"] for x in results),
        "future_price_labels_verified":0,
        "realized_pnl":None,"alpha_validated":False,
        "no_live_or_paper_orders":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",type=Path,required=True)
    p.add_argument("--source",type=Path,required=True)
    p.add_argument("--symbol",required=True,choices=list(SYMBOLS))
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("Research result already exists, no overwrite")
    result=run(args.source,args.study,args.symbol)
    with args.out.open("xb") as f:
        f.write(canonical(result)+b"\n")
    print(json.dumps({
        "symbol":args.symbol,
        "source_seconds_with_both_streams":result["source_seconds_with_both_streams"],
        "candidate_checks":[{
            "id":x["candidate_id"],
            "eligible":x["source_only_signal"]["eligible"],
            "reason":x["source_only_signal"]["eligibility_result"],
            "hypothetical_direction":x["source_only_signal"]["hypothetical_direction"],
        } for x in result["candidate_checks"]],
        "report_sha256":sha256(args.out.read_bytes()),
        "future_price_labels_verified":0,
        "can_trade":False},sort_keys=True))
if __name__=="__main__":
    main()
