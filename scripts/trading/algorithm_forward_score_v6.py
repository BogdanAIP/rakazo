#!/usr/bin/env python3
"""Evaluate exactly one preregistered cohort from verified post-freeze candles.

NEVER sends an order. A single shared market-time block cannot establish an
independent profitable edge. It is one source-integrity/negative-control test.
"""
from __future__ import annotations
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from algorithm_forward_prices_v6 import (
    freeze_file, verify_batch, validate_candles, BAR, SCHEMA as CAPTURE_SCHEMA,
)

SCHEMA = "algorithm_forward_one_cohort_outcome_v6"


def calc_return(entry, exitprice, side, fee_side):
    entry = Decimal(entry)
    exitprice = Decimal(exitprice)
    fee_side = Decimal(str(fee_side))
    if not entry.is_finite() or not exitprice.is_finite() or entry<=0 or exitprice<=0:
        raise ValueError("Cannot simulate nonpositive market open price")
    if type(side) is not int or side not in (-1,1):
        raise ValueError("Only preregistered signed hypothetical positions")
    ratio=exitprice/entry
    notional=Decimal("0.1")
    gross=notional*side*(ratio-Decimal(1))
    modeled_execution_drag=notional*fee_side*(1+ratio)
    return {"gross_equity_fraction":str(gross),
            "estimated_execution_drag_equity_fraction":str(modeled_execution_drag),
            "net_equity_fraction":str(gross-modeled_execution_drag)}


def evaluate(frozen, captures_root):
    if frozen.get("schema")!="algorithm_forward_frozen_v6":
        raise ValueError("Unsupported immutable protocol")
    if frozen.get("can_submit_orders") is not False or frozen.get("can_start_paper") is not False:
        raise ValueError("Research safety policy violation")
    if frozen.get("primary_exit_candle_open_ms")-frozen.get("entry_candle_open_ms")!=4*BAR:
        raise ValueError("Unfrozen horizon")
    root=Path(captures_root)
    first=None
    all_rows=[]
    input_sha=[]
    for batch in range(1,11):
        folder=root/f"forward-v6-prices-20261029-batch{batch:02d}"
        manifest,manifest_sha=verify_batch(folder,frozen,batch)
        if first is not None and manifest["records"][0]["request_sent_ms"]<first:
            raise ValueError("Nonchronological outcome capture")
        first=manifest["records"][-1]["received_complete_ms"]
        input_sha.append(manifest_sha)
        for i,candidate in enumerate(frozen["candidates"][(batch-1)*5:batch*5]):
            receipt=manifest["records"][i+1]
            if receipt["symbol"]!=candidate["symbol"] or receipt["kind"]!="candles":
                raise ValueError("Rank/source mismatch")
            bars=validate_candles((folder/receipt["raw_file"]).read_bytes(),
                                   receipt["received_complete_ms"])
            entry_t=frozen["entry_candle_open_ms"]
            exit_t=frozen["primary_exit_candle_open_ms"]
            short_t=frozen["diagnostic_exit_candle_open_ms"]
            for t in (entry_t,exit_t,short_t):
                if t not in bars or bars[t]["confirm"]!="1":
                    raise ValueError("Required price not confirmed")
            entry=bars[entry_t]["open"]
            primary_exit=bars[exit_t]["open"]
            diagnostic_exit=bars[short_t]["open"]
            side=candidate["primary_direction_for_research_only"]
            row={"rank":candidate["rank"],"symbol":candidate["symbol"],
                 "source_label":candidate["source_label"],
                 "observation_and_price_temporal_order_verified":True,
                 "primary_included":candidate["primary_included"],
                 "entry_open_price":entry,"primary_exit_open_price":primary_exit,
                 "diagnostic_exit_open_price":diagnostic_exit,
                 "unsigned_primary_price_change_fraction":
                     str(Decimal(primary_exit)/Decimal(entry)-Decimal(1)),
                 "side":side,"fees_settled_verified":False,
                 "funding_cashflow_included":False}
            if candidate["primary_included"]:
                if type(side) is not int or side not in (-1,1) or candidate["source_label"]!="CO_MOVEMENT":
                    raise ValueError("Hypothesis was silently altered")
                row["base"]=calc_return(entry,primary_exit,side,frozen["side_cost_base"])
                row["stress"]=calc_return(entry,primary_exit,side,frozen["side_cost_stress"])
                row["short_horizon_diagnostic"]={
                    "base":calc_return(entry,diagnostic_exit,side,frozen["side_cost_base"]),
                    "stress":calc_return(entry,diagnostic_exit,side,frozen["side_cost_stress"])}
            else:
                if side is not None:
                    raise ValueError("Abstain case contains position direction")
                row["primary_return"]=None
                row["reason"]="NO_HYPOTHESIS_POSITION"
            all_rows.append(row)
    if len(all_rows)!=50 or len(set(r["symbol"] for r in all_rows))!=50:
        raise ValueError("Incomplete source verification")
    included=[r for r in all_rows if r["primary_included"]]
    if len(included)!=5:
        raise ValueError("Not the preregistered five qualifying events")
    totals={}
    for name in ("base","stress"):
        totals[name]=str(sum(
            (Decimal(x[name]["net_equity_fraction"]) for x in included),Decimal(0)))
    return {
        "schema":SCHEMA,
        "freeze_sha256":frozen["_verified_sha256"],
        "candle_capture_manifest_sha256":input_sha,
        "markets":all_rows,
        "summary":{
            "market_count":len(all_rows),"qualifying_events":len(included),
            "abstaining_markets":len(all_rows)-len(included),
            "modeled_fixed_notional_equity_fraction_base_sum":totals["base"],
            "modeled_fixed_notional_equity_fraction_stress_sum":totals["stress"],
            "market_time_blocks":1,
        },
        "execution_assumptions":{
            "size_per_qualifier":frozen["per_instrument_initial_equity_notional"],
            "side_cost_base":frozen["side_cost_base"],
            "side_cost_stress":frozen["side_cost_stress"],
            "all_prices_confirmed_okx_trade_candle_opens":True,
            "actual_fills_verified":False,
            "funding_cashflows_included":False,
            "margin_mark_and_liquidation_simulated":False,
        },
        "independent_performance_validated":False,
        "inferential_p_value":None,
        "decision":"INSUFFICIENT_INDEPENDENT_EVIDENCE",
        "can_start_paper":False,"can_submit_orders":False,
    }


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--freeze",type=Path,required=True)
    cli.add_argument("--expected-freeze-sha256",required=True)
    cli.add_argument("--prices-root",type=Path,required=True)
    cli.add_argument("--out",type=Path,required=True)
    args=cli.parse_args()
    if args.out.exists():
        raise FileExistsError("No overwrite of previous evaluation")
    frozen=freeze_file(args.freeze,args.expected_freeze_sha256)
    frozen["_verified_sha256"]=args.expected_freeze_sha256
    result=evaluate(frozen,args.prices_root)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as stream:
        json.dump(result,stream,indent=2,sort_keys=True,allow_nan=False)
        stream.write("\n")
    print(json.dumps({"hypothesis":frozen["primary_hypothesis"],
                      "qualifying":result["summary"]["qualifying_events"],
                      "decision":result["decision"],
                      "can_submit_orders":False}))


if __name__=="__main__":
    main()
