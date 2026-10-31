#!/usr/bin/env python3
"""v21 OFFLINE book-watermark 3s settling audit over one ORIGINAL 15s source.

Book and taker streams share published exchange ms timestamps but do not
have a certified common matching-engine total ordering. The Windows clock
offset remains uncalibrated. No signals, PnL, or post-outcome fitting.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

from algorithm_ws_12s_coverage_v18 import analyze as original_source_audit
from algorithm_ws_capture_v8 import parse_event
from algorithm_ws_audit_v8 import strict_load
from algorithm_multiday_registry_v12 import canonical,sha256

SCHEMA="algorithm_book_watermark_settling_v21"
DAY="2026-10-31"
WARMUP=4_000
FEATURE=8_000
SETTLE=3_000
SECONDS=15
MARKETS={
    "BTC-USDT-SWAP":"ws-v21-oct31-btc-01",
    "SOL-USDT-SWAP":"ws-v21-oct31-sol-01",
}


def audit(source,symbol):
    folder=Path(source)
    if symbol not in MARKETS or folder.name!=MARKETS[symbol]:
        raise ValueError("Nonpreregistered market or original source directory")
    original=original_source_audit(folder,expected_seconds=SECONDS)
    m=strict_load((folder/"manifest.json").read_bytes())
    start,end=m["start_utc_ms"],m["end_utc_ms"]
    if (original["symbol"]!=symbol
        or datetime.fromtimestamp(start/1000,timezone.utc).date().isoformat()!=DAY
        or datetime.fromtimestamp(end/1000,timezone.utc).date().isoformat()!=DAY
        or not 14900<=end-start<=15200):
        raise ValueError("Invalid original 15s Oct31 source")
    t4=start+WARMUP
    t12=t4+FEATURE
    t15=t12+SETTLE
    book_updates=[]
    received_trades=[]
    settle_book=0
    settle_trades=0
    last_exchange_book_ts=None
    for line in (folder/"messages.jsonl").read_bytes().splitlines():
        record=strict_load(line)
        recv=record["received_complete_utc_ms"]
        source_kind=record["source"]
        obj,kind=parse_event(source_kind,symbol,record["raw"])
        if source_kind=="book" and kind=="update":
            item=obj["data"][0]
            exchange=int(item["ts"])
            advanced=item["seqId"]>item["prevSeqId"]
            # The independent full audit already checks the entire seq chain.
            if advanced and start<recv<t15:
                if last_exchange_book_ts is not None and exchange<last_exchange_book_ts:
                    raise ValueError("Exchange book timestamp reversed in sequential updates")
                last_exchange_book_ts=exchange
                book_updates.append((recv,exchange))
                if t12<=recv<t15:
                    settle_book+=1
        elif source_kind=="trade" and kind=="trade":
            item=obj["data"][0]
            if start<recv<t15:
                exchange=int(item["ts"])
                received_trades.append((recv,exchange))
                if t12<=recv<t15:
                    settle_trades+=1
    warmup_anchor=[(recv,exchange) for recv,exchange in book_updates if recv<t4]
    feature_anchor=[(recv,exchange) for recv,exchange in book_updates if recv<t12]
    if not warmup_anchor or not feature_anchor:
        raise ValueError("No predeclared book watermark anchors")
    S=warmup_anchor[-1][1]
    E=feature_anchor[-1][1]
    if E<=S:
        raise ValueError("Book watermark did not advance across feature period")
    baseline=[(recv,ts) for recv,ts in received_trades if S<=ts<E and recv<t12]
    settled=[(recv,ts) for recv,ts in received_trades if S<=ts<E and recv<t15]
    recovered=[(recv,ts) for recv,ts in settled if t12<=recv<t15]
    if len(settled)!=len(baseline)+len(recovered):
        raise ValueError("Recovered trade count inconsistent with decision cutoff")
    if len(recovered)>settle_trades:
        raise ValueError("Recovered trades exceed total settling receipts")
    bin_rows=[]
    for i in range(8):
        left=S+i*1000
        right=left+1000
        full=right<=E
        count_before=sum(left<=ts<right for _,ts in baseline) if full else None
        count_after=sum(left<=ts<right for _,ts in settled) if full else None
        bin_rows.append({
            "index":i,
            "exchange_time_start_ms":left,
            "exchange_time_end_ms":right,
            "fully_covered_by_book_end_watermark":full,
            "received_by_feature_cutoff":count_before,
            "received_by_true_decision_time":count_after,
            "new_late_arrivals_in_3s_settle":
                (count_after-count_before) if full else None,
        })
    measurable=[row for row in bin_rows if row["fully_covered_by_book_end_watermark"]]
    present_before=sum(x["received_by_feature_cutoff"]>0 for x in measurable)
    present_after=sum(x["received_by_true_decision_time"]>0 for x in measurable)
    if present_after<present_before:
        raise ValueError("Settling cannot reduce observed historical trade coverage")
    return {
        "schema":SCHEMA,
        "source_day_utc":DAY,
        "symbol":symbol,
        "source_folder":folder.name,
        "original_manifest_sha256":original["source_manifest_sha256"],
        "original_messages_sha256":original["source_messages_sha256"],
        "original_logical_message_count":original["recorded_original_messages"],
        "source_start_utc_ms":start,
        "source_end_utc_ms":end,
        "feature_receipt_start_utc_ms":t4,
        "feature_receipt_cutoff_utc_ms":t12,
        "true_decision_cutoff_utc_ms":end,
        "fixed_nominal_settling_delay_ms":SETTLE,
        "source_settling_cutoff_utc_ms":t15,
        "book_exchange_anchor_S":S,
        "book_exchange_anchor_E":E,
        "book_exchange_anchor_span_ms":E-S,
        "all_15s_valid_book_updates_from_independent_audit":original["book_updates_total"],
        "all_15s_received_individual_taker_fills":original["received_valid_taker_fills_total"],
        "settlement_book_updates_receipt_count":settle_book,
        "settlement_individual_taker_receipt_count":settle_trades,
        "feature_exchange_interval_taker_fills_available_at_plus12s":len(baseline),
        "feature_exchange_interval_taker_fills_available_at_plus15s":len(settled),
        "feature_exchange_interval_taker_fills_recovered_by_settling":len(recovered),
        "taker_binned_exchange_time_coverage":bin_rows,
        "fully_watermark_covered_one_second_bins":len(measurable),
        "trade_containing_covered_bins_at_plus12s":present_before,
        "trade_containing_covered_bins_at_plus15s":present_after,
        "new_trade_containing_bins_due_to_settling":present_after-present_before,
        "Windows_time_service_status":"WINDOWS_TIME_SERVICE_UNVERIFIED",
        "Windows_exchange_clock_offset_calibrated":False,
        "independent_order_matching_proven":False,
        "exchange_trade_stream_gapless_proven":False,
        "book_trade_exchange_timestamp_relative_comparability_proven":False,
        "time_used_for_decision":"ACTUAL_END_OF_15_SECOND_CAPTURE_NOT_FEATURE_END",
        "past_source_only_no_prospective_trade_prediction":True,
        "future_price_labels_accessed":False,
        "realized_pnl":None,
        "status":"SOURCE_TIME_SETTLING_DIAGNOSTIC_ONLY",
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",type=Path,required=True)
    p.add_argument("--symbol",required=True,choices=list(MARKETS))
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.out.exists():
        raise FileExistsError("Cannot overwrite original source diagnostic")
    r=audit(a.source,a.symbol)
    with a.out.open("xb") as out:
        out.write(canonical(r)+b"\n")
    print(json.dumps({
        "symbol":r["symbol"],
        "original_message_count":r["original_logical_message_count"],
        "book_exchange_anchor_span_ms":r["book_exchange_anchor_span_ms"],
        "taker_feature_received_by_plus12s":
            r["feature_exchange_interval_taker_fills_available_at_plus12s"],
        "taker_feature_received_by_plus15s":
            r["feature_exchange_interval_taker_fills_available_at_plus15s"],
        "settle_recovered_taker_fills":
            r["feature_exchange_interval_taker_fills_recovered_by_settling"],
        "bin_coverage_before":r["trade_containing_covered_bins_at_plus12s"],
        "bin_coverage_after":r["trade_containing_covered_bins_at_plus15s"],
        "report_sha256":sha256(a.out.read_bytes()),
        "clock_calibrated":False,"future_price_labels_accessed":False,
        "status":r["status"],
    },sort_keys=True,ensure_ascii=False))


if __name__=="__main__":
    main()
