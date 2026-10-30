#!/usr/bin/env python3
"""PRE-REGISTERED v9 next-second midpoint falsification on six NEW WS datasets.

A one-second book quote is NOT a guaranteed executable price; this returns
NO strategy, account credentials, PAPER enablement or order instruction.
Must be committed before any v9 WS source capture.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from algorithm_ws_buckets_v8 import build_buckets
from algorithm_ws_audit_v8 import strict_load

SCHEMA="algorithm_queue_readdition_next_second_v9"
PROTOCOL_COMMIT="8dc77249cd33fe25107934852112b78467cdfe56"
SAMPLES=(("btc",1),("sol",1),("btc",2),("sol",2),("btc",3),("sol",3))
BPS=Decimal("10000")
SIDE_COST_BPS=Decimal("7")


def mid(book_bin):
    bid,ask=Decimal(book_bin["best_bid"]),Decimal(book_bin["best_ask"])
    if not bid.is_finite() or not ask.is_finite() or bid<=0 or ask<=bid:
        raise ValueError("Cannot score missing, malformed, locked or crossed quote")
    return (bid+ask)/2


def score_pair(current,nxt):
    """Next 1s source price is deliberately not supplied to feature selection."""
    if current["status"]!="OBSERVED_BOTH" or nxt["status"]!="OBSERVED_BOTH":
        return {"status":"ABSTAIN_SOURCE_QUALITY","primary":False}
    if (current["book_update_count"]<1 or nxt["book_update_count"]<1
            or current["fill_count"]<1 or nxt["fill_count"]<1):
        raise ValueError("Untrustworthy supposedly complete bin")
    f=Decimal(current["taker_imbalance"])
    if not f.is_finite() or not -1<=f<=1:
        raise ValueError("Invalid source taker imbalance")
    if f==0:
        return {"status":"ABSTAIN_ZERO_FLOW","primary":False}
    side=1 if f>0 else -1
    bid_readd=current["book_bid_quote_readd_events"]
    ask_readd=current["book_ask_quote_readd_events"]
    if (type(bid_readd) is not int or type(ask_readd) is not int
            or bid_readd<0 or ask_readd<0):
        raise ValueError("Invalid historical quote readdition events")
    if (side==1 and ask_readd<=bid_readd
            or side==-1 and bid_readd<=ask_readd):
        return {"status":"CONTROL_NO_OPPOSITION","primary":False,
                "flow_sign":side,
                "bid_readd_count":bid_readd,"ask_readd_count":ask_readd}
    # Source midquote at t can be known at the END of second t.
    # The source midquote at t+1 is a strictly later OUTCOME only.
    a,b=mid(current),mid(nxt)
    actual_bps=BPS*(b/a-1)
    signed_reverse=-Decimal(side)*actual_bps
    return {
        "status":"QUALIFIED_PASSIVE_OPPOSITION","primary":True,
        "flow_sign":side,
        "frozen_predicted_direction":-side,
        "bid_readd_count":bid_readd,
        "ask_readd_count":ask_readd,
        "mid_t":str(a),"mid_t_plus_one":str(b),
        "actual_midpoint_change_bps":str(actual_bps),
        "primary_reverse_taker_signed_bps":str(signed_reverse),
        "taker_only_control_signed_bps":str(-signed_reverse),
        "zero_move_null_absolute_error_bps":str(abs(actual_bps)),
        "illustrative_14bps_roundtrip_stress_bps":str(signed_reverse-2*SIDE_COST_BPS),
        "actual_execution_prices_observed":False,
        "can_trade":False,
    }


def score_window(source):
    # Source is reconstructed directly from original raw hashes & seq-valid deltas.
    if (source.get("schema")!="algorithm_ws_microstructure_seconds_v8"
            or source.get("can_trade") is not False
            or source.get("quote_readd_is_proxy_not_proven_absorption") is not True
            or source.get("trade_stream_gapless_not_certified") is not True
            or len(source.get("one_second_bins",[]))!=8):
        raise ValueError("Unverified or incompatible v8 source schema")
    rows=source["one_second_bins"]
    if any(row["index"]!=i for i,row in enumerate(rows)):
        raise ValueError("Reordered one-second rows")
    return [
        {"second":i,"source_feature_available_at_ms":rows[i]["end_utc_ms"],
         "outcome_not_before_ms":rows[i+1]["end_utc_ms"],
         **score_pair(rows[i],rows[i+1])}
        for i in range(7)
    ]


def evaluate(root):
    root=Path(root)
    attempts=[]
    all_qualified=[]
    cohorts=0
    for sym,run in SAMPLES:
        folder=root/f"ws-v9-{sym}-20261030-run{run:02d}"
        record={"symbol":sym.upper()+"-USDT-SWAP","run":run,
                "source_folder":folder.name,"attempted":True}
        try:
            source=build_buckets(folder)
            if source["symbol"]!=record["symbol"]:
                raise ValueError("Wrong captured symbol")
            record["source_manifest_sha256"]=source["source_manifest_sha256"]
            record["raw_messages_sha256"]=source["source_messages_sha256"]
            record["start_utc_ms"]=source["window_start_utc_ms"]
            record["end_utc_ms"]=source["window_end_utc_ms"]
            record["status"]="VERIFIED"
            record["second_observations"]=score_window(source)
            cohorts+=1
            all_qualified.extend({
                "symbol":record["symbol"],"run":run,**v}
                for v in record["second_observations"] if v["primary"])
        except (FileNotFoundError,ValueError,KeyError,TypeError,UnicodeError) as exc:
            # Do not pretend that a failed or missing source is a zero return.
            record["status"]="REJECTED_SOURCE"
            record["rejection"]=f"{type(exc).__name__}: {str(exc)[:200]}"
            record["second_observations"]=[]
        attempts.append(record)
    means=None
    positive=negative=zero=0
    if all_qualified:
        n=Decimal(len(all_qualified))
        def avg(key):
            return str(sum((Decimal(x[key]) for x in all_qualified),Decimal(0))/n)
        means={
            "reverse_taker_mean_signed_mid_bps":avg("primary_reverse_taker_signed_bps"),
            "taker_only_mean_signed_mid_bps":avg("taker_only_control_signed_bps"),
            "zero_move_null_mean_absolute_error_bps":avg("zero_move_null_absolute_error_bps"),
            "illustrative_stress_after_14bps_roundtrip_mean_bps":
                avg("illustrative_14bps_roundtrip_stress_bps"),
        }
        for row in all_qualified:
            s=Decimal(row["primary_reverse_taker_signed_bps"])
            positive+=s>0
            negative+=s<0
            zero+=s==0
    # One descriptive verdict on a tiny correlated pilot. Not a deployment gate.
    verdict=("INCOMPLETE_SOURCE_COHORT" if cohorts<len(SAMPLES)
             else "INSUFFICIENT_ELIGIBLE_EVENTS" if not all_qualified
             else "DESCRIPTIVELY_POSITIVE_NOT_VALIDATED" if
                Decimal(means["reverse_taker_mean_signed_mid_bps"])>0
             else "NEGATIVE_PILOT_NOT_VALIDATED")
    return {
        "schema":SCHEMA,"protocol_git_commit":PROTOCOL_COMMIT,
        "predeclared_samples":[{"symbol":s.upper()+"-USDT-SWAP","run":r} for s,r in SAMPLES],
        "completed_source_captures":cohorts,"planned_source_captures":6,
        "qualified_source_seconds":len(all_qualified),
        "primary_success_count":int(positive),
        "primary_failure_count":int(negative),
        "primary_zero_count":int(zero),
        "primary_and_controls":means,
        "samples":attempts,
        "verdict":verdict,
        "independent_alpha_validation":False,"p_value":None,
        "future_execution_or_pnl_scored":False,
        "trade_message_gapless_certified":False,
        "model_fee_not_real_execution":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--root",type=Path,required=True)
    cli.add_argument("--out",type=Path,required=True)
    args=cli.parse_args()
    if args.out.exists():
        raise FileExistsError("Do not replace a prior outcome study")
    result=evaluate(args.root)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as f:
        json.dump(result,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    print(json.dumps({"verdict":result["verdict"],
                      "completed":result["completed_source_captures"],
                      "qualified":result["qualified_source_seconds"],
                      "primary_and_controls":result["primary_and_controls"],
                      "can_trade":False}))


if __name__=="__main__":
    main()
