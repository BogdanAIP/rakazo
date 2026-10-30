#!/usr/bin/env python3
"""v20 deterministic event-exchange-ts vs local-receipt-ts latency diagnostic.

Exactly one independent original 12s WS capture each for frozen BTC/SOL.
No market outcomes, signal selection, network access or trading.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

from algorithm_ws_12s_coverage_v18 import analyze as audit_original
from algorithm_ws_capture_v8 import parse_event
from algorithm_ws_audit_v8 import strict_load
from algorithm_multiday_registry_v12 import canonical, sha256

SCHEMA="algorithm_event_latency_v20"
DAY="2026-10-30"
LENGTH_MS=12_000
TAIL_MS=4_000
MARKETS={
    "BTC-USDT-SWAP":"ws-v20-oct30-btc-01",
    "SOL-USDT-SWAP":"ws-v20-oct30-sol-01",
}
PERCENTILES=(0,10,50,90,99,100)
BUCKET_KEYS=(
    "negative","zero","1_to_250","251_to_500",
    "501_to_1000","1001_to_2000","2001_to_5000","above_5000"
)


def nearest_rank(xs,p):
    if not xs:
        return None
    if p==0:
        return xs[0]
    if p==100:
        return xs[-1]
    return xs[((len(xs)*p+99)//100)-1]


def delay_bucket(d):
    if d<0:
        return "negative"
    if d==0:
        return "zero"
    if d<=250:
        return "1_to_250"
    if d<=500:
        return "251_to_500"
    if d<=1000:
        return "501_to_1000"
    if d<=2000:
        return "1001_to_2000"
    if d<=5000:
        return "2001_to_5000"
    return "above_5000"


def summary(delays):
    s=sorted(delays)
    return {
        "samples":len(s),
        "p0_min_ms":nearest_rank(s,0),
        "p10_ms":nearest_rank(s,10),
        "p50_median_ms":nearest_rank(s,50),
        "p90_ms":nearest_rank(s,90),
        "p99_ms":nearest_rank(s,99),
        "p100_max_ms":nearest_rank(s,100),
        "buckets":{name:sum(delay_bucket(d)==name for d in s)
                   for name in BUCKET_KEYS},
        "negative_apparent_delay_is_possible_due_to_clock_skew":True,
    }


def analyze(source,symbol):
    path=Path(source)
    if symbol not in MARKETS or path.name!=MARKETS[symbol]:
        raise ValueError("Unregistered v20 source or instrument")
    base=audit_original(path)
    manifest=strict_load((path/"manifest.json").read_bytes())
    start=manifest["start_utc_ms"]
    end=manifest["end_utc_ms"]
    if (datetime.fromtimestamp(start/1000,timezone.utc).date().isoformat()!=DAY
        or datetime.fromtimestamp(end/1000,timezone.utc).date().isoformat()!=DAY
        or not 11900<=end-start<=12200):
        raise ValueError("Wrong UTC source day or duration")
    tail=start+TAIL_MS
    feature_end=tail+8_000
    bins=[{"index":i,"book_updates":0,
           "received_trades_original_window":0,
           "trades_strict_exchange_time_tail":0,
           "pre_tail_exchange_time_received_trades":0,
           "negative_delta_trade_frames":0} for i in range(12)]
    delays={"book":[],"trade":[]}
    last_book_seq=None
    previous_receipt=None
    previous_mono=None
    out_of_capture_exchange_trades=0
    delayed_pre_tail=0
    trade_deltas_received_tail=[]
    for line in (path/"messages.jsonl").read_bytes().splitlines():
        e=strict_load(line)
        recv=e["received_complete_utc_ms"]
        mono=e["received_monotonic_ns"]
        if previous_mono is not None and mono<previous_mono:
            raise ValueError("Original global monotonic receipt out of order")
        previous_mono=mono
        src=e["source"]
        obj,kind=parse_event(src,symbol,e["raw"])
        if src=="book" and kind in ("snapshot","update"):
            payload=obj["data"][0]
            seq=payload["seqId"]
            seq_advanced=(last_book_seq is not None and seq>last_book_seq)
            last_book_seq=seq
            exchange=int(payload["ts"])
        elif src=="trade" and kind=="trade":
            exchange=int(obj["data"][0]["ts"])
            seq_advanced=False
        else:
            continue
        if not start<recv<start+LENGTH_MS:
            continue
        i=(recv-start)//1000
        if not 0<=i<12:
            raise ValueError("Invalid second window assignment")
        delta=recv-exchange
        # Audit independently confirmed receipt/exchange timestamps within a
        # broad plausible interval. Never clamp negatives or pretend a
        # synchronized client/exchange clock.
        delays[src].append(delta)
        if src=="book":
            if kind=="update" and seq_advanced:
                bins[i]["book_updates"]+=1
        else:
            if delta<0:
                bins[i]["negative_delta_trade_frames"]+=1
            if start<=exchange<end:
                bins[i]["received_trades_original_window"]+=1
            else:
                out_of_capture_exchange_trades+=1
            if 4<=i<=11:
                trade_deltas_received_tail.append(delta)
                if exchange<tail:
                    bins[i]["pre_tail_exchange_time_received_trades"]+=1
                    delayed_pre_tail+=1
                if tail<=exchange<feature_end:
                    bins[i]["trades_strict_exchange_time_tail"]+=1
    if not delays["book"] or not delays["trade"]:
        raise ValueError("Insufficient book and trade source frames for diagnostic")
    observed_audit_book=sum(x["book_updates"] for x in bins)
    original_audit_book=base["book_updates_total"]
    observed_audit_trades=sum(x["received_trades_original_window"] for x in bins)
    if (observed_audit_book!=original_audit_book or
        observed_audit_trades!=base["received_valid_taker_fills_total"]):
        raise ValueError("v20 source count disagrees with independently audited v18 source")
    receipt_joint=sum(b["book_updates"]>0 and b["received_trades_original_window"]>0
                      for b in bins[4:])
    strict_joint=sum(b["book_updates"]>0 and b["trades_strict_exchange_time_tail"]>0
                     for b in bins[4:])
    expected=base["predeclared_overlapping_eight_second_windows"][4]["joint_seconds"]
    if receipt_joint!=expected or strict_joint>receipt_joint:
        raise ValueError("Tail joint-second integrity mismatch")
    return {
        "schema":SCHEMA,"date_utc":DAY,"symbol":symbol,
        "original_source_manifest_sha256":base["source_manifest_sha256"],
        "original_source_messages_sha256":base["source_messages_sha256"],
        "original_original_messages":base["recorded_original_messages"],
        "source_start_utc_ms":start,"source_end_utc_ms":end,
        "fixed_tail_start_utc_ms":tail,
        "fixed_tail_end_feature_utc_ms":feature_end,
        "book_exchange_ts_to_local_receipt_delta_ms":summary(delays["book"]),
        "trade_exchange_ts_to_local_receipt_delta_ms":summary(delays["trade"]),
        "tail_received_trade_delta_ms":summary(trade_deltas_received_tail),
        "each_source_second":bins,
        "received_book_updates_total":observed_audit_book,
        "received_valid_taker_fills_original_window_total":observed_audit_trades,
        "received_trade_frames_with_exchange_ts_outside_source":out_of_capture_exchange_trades,
        "pre_tail_exchange_time_trades_received_in_tail":delayed_pre_tail,
        "receipt_only_tail_joint_seconds":receipt_joint,
        "strict_exchange_time_tail_joint_seconds":strict_joint,
        "strict_joint_second_gap":receipt_joint-strict_joint,
        "cross_stream_exchange_order_proven":False,
        "client_exchange_clock_skew_independently_established":False,
        "trade_feed_completeness_independently_verified":False,
        "delay_is_network_only_latency":False,
        "no_candidate_strategy_signals_generated":True,
        "market_outcomes_or_pnl_scored":False,
        "future_price_label":None,"realized_pnl":None,
        "status":"SOURCE_EVENT_TIME_LATENCY_DIAGNOSTIC_ONLY",
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--symbol",required=True,choices=list(MARKETS))
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():
        raise FileExistsError("Never overwrite an original source diagnostic")
    r=analyze(a.source,a.symbol)
    with a.out.open("xb") as f:
        f.write(canonical(r)+b"\n")
    print(json.dumps({
        "symbol":r["symbol"],
        "messages":r["original_original_messages"],
        "trade_deltas":r["trade_exchange_ts_to_local_receipt_delta_ms"],
        "book_deltas":r["book_exchange_ts_to_local_receipt_delta_ms"],
        "pre_tail_delayed_trades":r["pre_tail_exchange_time_trades_received_in_tail"],
        "receipt_only_tail_joint":r["receipt_only_tail_joint_seconds"],
        "strict_exchange_time_tail_joint":r["strict_exchange_time_tail_joint_seconds"],
        "report_sha256":sha256(a.out.read_bytes()),
        "status":r["status"],"can_trade":False,
    },sort_keys=True))


if __name__=="__main__":
    main()
