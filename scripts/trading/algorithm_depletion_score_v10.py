#!/usr/bin/env python3
"""V10 preregistered 2s visible-depth-depletion continuation falsification.

Run ONLY on new 8-second, strict SHA+sequence-verified public OKX WS data.
All output is hypothetical best-quote-crossing arithmetic (NOT real fills).
No orders, account endpoints, PAPER or future source download.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from algorithm_ws_buckets_v8 import build_buckets

SCHEMA="algorithm_depletion_cross_quote_v10"
PROTOCOL_COMMIT="14f65793c2f0e32b8135a979e4235ba0a6525d15"
SAMPLES=(
    ("btc",1),("sol",1),("btc",2),("sol",2),
    ("btc",3),("sol",3),("btc",4),("sol",4),
)
BPS=Decimal(10000)
ROUNDTRIP_FEE_BPS=Decimal(14)


def positive_decimal(v):
    if not isinstance(v,str):
        raise ValueError("Numeric source string required")
    a=Decimal(v)
    if not a.is_finite() or a<=0:
        raise ValueError("Invalid source price/depth")
    return a


def nonnegative_decimal(v):
    if not isinstance(v,str):
        raise ValueError("Numeric source string required")
    a=Decimal(v)
    if not a.is_finite() or a<0:
        raise ValueError("Invalid visible depth change")
    return a


def quotes(row):
    bid=positive_decimal(row["best_bid"])
    ask=positive_decimal(row["best_ask"])
    if bid>=ask:
        raise ValueError("Locked/crossed book")
    ms=row["book_end_asof_ms"]
    if (type(ms) is not int or
            not row["start_utc_ms"]<=ms<row["end_utc_ms"]):
        raise ValueError("Stale/invalid quote time")
    return bid,ask,(bid+ask)/2


def marketable_bps(direction,entry_bid,entry_ask,exit_bid,exit_ask):
    if type(direction) is not int or direction not in (-1,1):
        raise ValueError("Invalid predeclared direction")
    if direction==1:
        gross=BPS*(exit_bid/entry_ask-1)
    else:
        gross=BPS*(1-exit_ask/entry_bid)
    return {"gross_bps":str(gross),
            "fee_drag_bps":str(ROUNDTRIP_FEE_BPS),
            "illustrative_net_bps":str(gross-ROUNDTRIP_FEE_BPS),
            "actual_fills":False}


def score_second(previous,current,following):
    idx=current["index"]
    if following["index"]!=idx+2 or previous["index"]!=idx-1 or idx not in range(1,6):
        raise ValueError("Only frozen t=1..5 plus two seconds future")
    if any(r["status"]!="OBSERVED_BOTH" for r in (previous,current,following)):
        return {"status":"ABSTAIN_MISSING_QUALITY","primary":False,
                "flow_only":None,"price_only":None}
    if any(r["book_update_count"]<1 or r["fill_count"]<1 for r in (previous,current,following)):
        raise ValueError("Invalid quality status")
    prev_bid,prev_ask,prev_mid=quotes(previous)
    entry_bid,entry_ask,entry_mid=quotes(current)
    exit_bid,exit_ask,exit_mid=quotes(following)
    f=Decimal(current["taker_imbalance"])
    if not f.is_finite() or abs(f)>1:
        raise ValueError("Invalid taker imbalance")
    if f==0:
        return {"status":"ABSTAIN_ZERO_TAKER","primary":False,
                "flow_only":None,"price_only":None}
    flow_direction=1 if f>0 else -1
    side="ask" if flow_direction==1 else "bid"
    add=nonnegative_decimal(current[f"book_{side}_added_contracts"])
    reduce=nonnegative_decimal(current[f"book_{side}_reduced_contracts"])
    depth_now=positive_decimal(current[f"top5_{side}_contracts"])
    depth_prev=positive_decimal(previous[f"top5_{side}_contracts"])
    depletion=(reduce>add and depth_now<depth_prev)

    flow_model=marketable_bps(flow_direction,entry_bid,entry_ask,exit_bid,exit_ask)
    prior_move=entry_mid-prev_mid
    momentum_direction=1 if prior_move>0 else -1 if prior_move<0 else None
    price_model=(marketable_bps(momentum_direction,entry_bid,entry_ask,exit_bid,exit_ask)
                 if momentum_direction is not None else None)

    output={
        "status":"QUALIFIED_DEPLETION" if depletion else "CONTROL_NO_DEPLETION",
        "primary":depletion,"flow_sign":flow_direction,
        "flow_only":flow_model,
        "price_only":price_model,
        "price_only_prior_sign":momentum_direction,
        "opposing_side":side,
        "opposing_quote_added_contracts":str(add),
        "opposing_quote_reduced_contracts":str(reduce),
        "opposing_top5_depth_previous":str(depth_prev),
        "opposing_top5_depth_now":str(depth_now),
        "input_t_mid":str(entry_mid),"outcome_t_plus_two_mid":str(exit_mid),
        "taker_flow_imbalance":str(f),
        "asof_feature_ms":current["end_utc_ms"],
        "asof_outcome_ms":following["end_utc_ms"],
        "hypothesis_direction":flow_direction if depletion else None,
        "primary_marketable_crossing":flow_model if depletion else None,
        "primary_midpoint_only_signed_bps":str(flow_direction*BPS*(exit_mid/entry_mid-1))
            if depletion else None,
        "opposite_direction_negative_control":marketable_bps(
            -flow_direction,entry_bid,entry_ask,exit_bid,exit_ask) if depletion else None,
        "no_actual_executions":True,
    }
    return output


def score_window(data):
    if (data.get("schema")!="algorithm_ws_microstructure_seconds_v8"
        or data.get("can_trade") is not False
        or data.get("quote_readd_is_proxy_not_proven_absorption") is not True
        or data.get("trade_stream_gapless_not_certified") is not True
        or len(data.get("one_second_bins",[]))!=8):
        raise ValueError("Unverified or mismatched source data")
    rows=data["one_second_bins"]
    if any(r.get("index")!=i for i,r in enumerate(rows)):
        raise ValueError("Wrong bin order")
    return [
        {"feature_second":t,**score_second(rows[t-1],rows[t],rows[t+2])}
        for t in range(1,6)
    ]


def mean(rows,key):
    if not rows:
        return None
    return str(sum((Decimal(r[key]["illustrative_net_bps"]) for r in rows),Decimal(0))
               /Decimal(len(rows)))


def evaluate(root):
    root=Path(root)
    attempts=[]
    main=[]
    allflow=[]
    allprice=[]
    valid=0
    for name,num in SAMPLES:
        folder=root/f"ws-v10-{name}-20261030-run{num:02d}"
        record={"symbol":name.upper()+"-USDT-SWAP","run":num,
                "capture_folder":folder.name,
                "source_status":"NOT_VERIFIED","attempted":True}
        try:
            data=build_buckets(folder)
            if data["symbol"]!=record["symbol"]:
                raise ValueError("Wrong market for locked run")
            record["capture_manifest_sha256"]=data["source_manifest_sha256"]
            record["raw_messages_sha256"]=data["source_messages_sha256"]
            record["capture_start_ms"]=data["window_start_utc_ms"]
            record["capture_end_ms"]=data["window_end_utc_ms"]
            rows=score_window(data)
            record["results"]=rows
            record["source_status"]="VERIFIED"
            valid+=1
            for r in rows:
                val={"symbol":record["symbol"],"run":num,**r}
                if r["flow_only"] is not None:
                    allflow.append(val)
                if r["price_only"] is not None:
                    allprice.append(val)
                if r["primary"]:
                    main.append(val)
        except (FileNotFoundError,ValueError,KeyError,TypeError,UnicodeError) as exc:
            record["source_status"]="REJECTED_OR_MISSING"
            record["rejection"]=f"{type(exc).__name__}: {str(exc)[:180]}"
            record["results"]=[]
        attempts.append(record)
    values={
        "primary_mean_net_cross_quote_bps":mean(
            [{"x":x["primary_marketable_crossing"]} for x in main],"x"),
        "primary_mean_gross_cross_quote_bps":str(
            sum((Decimal(x["primary_marketable_crossing"]["gross_bps"]) for x in main),Decimal(0))
            /len(main)) if main else None,
        "primary_mean_midprice_indicator_bps":str(
            sum((Decimal(x["primary_midpoint_only_signed_bps"]) for x in main),Decimal(0))
            /len(main)) if main else None,
        "primary_opposite_direction_control_mean_net_bps":mean(
            [{"x":x["opposite_direction_negative_control"]} for x in main],"x"),
        "flow_only_mean_net_bps":mean(allflow,"flow_only"),
        "price_only_mean_net_bps":mean(allprice,"price_only"),
    }
    verdict=(
        "INCOMPLETE_OR_REJECTED_SOURCE_COHORT" if valid!=len(SAMPLES)
        else "INSUFFICIENT_PRIMARY_EVENTS" if not main
        else "DESCRIPTIVELY_POSITIVE_NOT_VALIDATED" if
           Decimal(values["primary_mean_net_cross_quote_bps"])>0
        else "NEGATIVE_PILOT_NOT_VALIDATED"
    )
    return {
        "schema":SCHEMA,
        "protocol_commit_before_sources":PROTOCOL_COMMIT,
        "predeclared_sources":[{"symbol":s.upper()+"-USDT-SWAP","run":r} for s,r in SAMPLES],
        "attempts":attempts,"verified_captures":valid,"planned_captures":8,
        "source_seconds_scored":sum(len(r["results"]) for r in attempts),
        "primary_eligible_n":len(main),
        "flow_only_eligible_n":len(allflow),
        "price_only_eligible_n":len(allprice),
        "primary_positive_net_n":sum(Decimal(x["primary_marketable_crossing"]["illustrative_net_bps"])>0 for x in main),
        "primary_nonpositive_net_n":sum(Decimal(x["primary_marketable_crossing"]["illustrative_net_bps"])<=0 for x in main),
        "summary_means":values,
        "verdict":verdict,
        "initial_equity_pnl_claimed":False,
        "true_bid_ask_fills_verified":False,
        "trade_feed_gapless_verified":False,
        "market_beta_and_independence_verified":False,
        "p_value":None,"can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("Do not overwrite prior scientific result")
    x=evaluate(args.root)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as f:
        json.dump(x,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    print(json.dumps({"verdict":x["verdict"],"verified":x["verified_captures"],
                      "primary_eligible_n":x["primary_eligible_n"],
                      "flow_control_n":x["flow_only_eligible_n"],
                      "price_control_n":x["price_only_eligible_n"],
                      "summary_means":x["summary_means"],"can_trade":False}))


if __name__=="__main__":
    main()
