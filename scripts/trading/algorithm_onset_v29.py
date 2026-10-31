#!/usr/bin/env python3
"""v29: past-only genuine trade-flow onset detection on 934 fixed minute decisions.

OFFLINE, outcome-aware exploratory research. NEVER actual orders, alpha or a
realtime-ready bot. Uses six immutable official OKX module2 UTC+8 minute ZIPs,
and two real signed-taker-trade module1 ZIPs; no HTTP calls or holdout Sep05.
"""
from __future__ import annotations

import argparse
import bisect
from datetime import datetime,timezone
from decimal import Decimal as D
import json
from pathlib import Path
from statistics import median

from algorithm_controls_v28 import load_trades,load_oi_sources,historical_oi_context,source_news_at
from algorithm_module2_crossmarket_v27 import archive_bars
from algorithm_news_pit_v26 import load as load_news
from algorithm_multiday_registry_v12 import canonical,sha256

SCHEMA="algorithm_onset_first_passage_v29"
DAYS=("2026-09-03","2026-09-04")
SYMBOLS=("NEAR-USDT-SWAP","BTC-USDT-SWAP","ETH-USDT-SWAP")
TRADE_BASELINE_SECONDS=300
TRADE_RECENT_SECONDS=60
MIN_TRADE_PRINTS=5
MIN_INTENSITY_RATIO=D("3.0")
MIN_SIGNED_FLOW_FRACTION=D("0.60")
MUTED_PRICE_ABS_BPS=D("5.0")
COOLDOWN_MINUTES=60
FIRST_PASSAGE_ABS_BPS=D("100")
MAX_FUTURE_MINUTES=60
REPORT_HORIZONS_MINUTES=(5,15,60)


def time_ms(day,hour,minute):
    return int(datetime.fromisoformat(day+"T00:00:00+00:00").timestamp()*1000)+(hour*60+minute)*60000


def time_utc(ts):
    return datetime.fromtimestamp(ts/1000,timezone.utc).isoformat()


def decision_grid():
    result=[]
    for day in DAYS:
        for k in range(421):
            result.append(time_ms(day,2,0)+k*60000)
        for k in range(46):
            result.append(time_ms(day,14,0)+k*60000)
    if len(result)!=934 or len(set(result))!=934 or result!=sorted(result):
        raise ValueError("Registered 934-minute cohort mutated")
    return tuple(result)


def exact_completed_close(prices,at_ms):
    # at_ms is the END of the one-minute bar, never the bar START at target.
    return prices.get(at_ms-60000)


def bps(current,base):
    if current is None or base is None or base<=0:
        return None
    return D(10000)*(current/base-D(1))


def summarize_takers(records,timestamps,left,right):
    low=bisect.bisect_left(timestamps,left)
    high=bisect.bisect_left(timestamps,right)
    subset=records[low:high]
    buy=sum((v for _,side,v in subset if side=="buy"),D(0))
    sell=sum((v for _,side,v in subset if side=="sell"),D(0))
    total=buy+sell
    return {
        "start_utc":time_utc(left),"end_exclusive_utc":time_utc(right),
        "actual_trade_prints":len(subset),
        "taker_buy_contracts":str(buy),"taker_sell_contracts":str(sell),
        "taker_total_contracts":str(total),
        "signed_taker_fraction":str((buy-sell)/total) if total else None,
        "taker_buy_share":str(buy/total) if total else None,
    }


def detector_at(t,records,timestamps,near_completed_close):
    old=summarize_takers(records,timestamps,t-360000,t-60000)
    now=summarize_takers(records,timestamps,t-60000,t)
    pnow=exact_completed_close(near_completed_close,t)
    pprior=exact_completed_close(near_completed_close,t-60000)
    immediate_move=bps(pnow,pprior)
    result={
        "decision_utc":time_utc(t),"decision_ms":t,
        "last_complete_candle_end_utc":time_utc(t),
        "previous_5min_excluding_latest_min":old,
        "latest_1min_strictly_before_decision":now,
        "last_completed_1min_price_move_bps":str(immediate_move) if immediate_move is not None else None,
        "trigger_qualification":"NO_SIGNAL",
        "direction":None,
        "taker_flow_volume_acceleration_ratio":None,
        "taker_signed_flow_fraction":now["signed_taker_fraction"],
        "onset_kind":None,
        "event_selected_after_60minute_cooldown":False,
        "cooldown_suppressed":False,
        "no_future_trades_or_candles_in_detector":True,
    }
    # The original immutable UTC+8 daily ZIP verifies continuous source-day
    # COVERAGE, not that a trade must exist at the exact observation boundary.
    # Absence of trades during an interval is an authentic zero-volume sample,
    # NOT evidence that the source file is missing.
    if pnow is None or pprior is None:
        result["trigger_qualification"]="SOURCE_MISSING"
        return result
    old_vol=D(old["taker_total_contracts"])
    recent_vol=D(now["taker_total_contracts"])
    if old_vol<=0:
        result["trigger_qualification"]="BASELINE_ZERO_ABSTAIN"
        return result
    ratio=recent_vol/(old_vol/D(5))
    result["taker_flow_volume_acceleration_ratio"]=str(ratio)
    if (now["actual_trade_prints"]<MIN_TRADE_PRINTS
        or ratio<MIN_INTENSITY_RATIO or recent_vol<=0):
        return result
    signed=D(now["signed_taker_fraction"])
    if abs(signed)<MIN_SIGNED_FLOW_FRACTION:
        return result
    result["trigger_qualification"]="QUALIFIED_WITHOUT_COOLDOWN"
    result["direction"]=1 if signed>0 else -1
    result["onset_kind"]="MUTED_PRICE_RESPONSE" if abs(immediate_move)<=MUTED_PRICE_ABS_BPS else "VISIBLE_PRICE_RESPONSE"
    result["immediate_price_move_is_aligned_with_flow"]=(immediate_move*D(result["direction"])>0)
    return result


def first_passage(event,prices):
    t=event["decision_ms"]
    direction=event["direction"]
    if direction not in (1,-1):
        raise ValueError("Direction must be frozen signed taker flow")
    starts={sym:exact_completed_close(prices[sym],t) for sym in SYMBOLS}
    if any(value is None or value<=0 for value in starts.values()):
        return {"status":"ORIGINAL_SOURCE_MISSING_AT_SIGNAL","outcome":"UNSCORABLE"}
    first=None
    path=[]
    for h in range(1,MAX_FUTURE_MINUTES+1):
        values={sym:exact_completed_close(prices[sym],t+h*60000) for sym in SYMBOLS}
        if any(value is None for value in values.values()):
            return {"status":"ORIGINAL_SOURCE_MISSING_FUTURE_MINUTE",
                    "outcome":"UNSCORABLE","scored_complete_minutes":h-1}
        returns={sym:bps(values[sym],starts[sym]) for sym in SYMBOLS}
        control=(returns["BTC-USDT-SWAP"]+returns["ETH-USDT-SWAP"])/D(2)
        near=returns["NEAR-USDT-SWAP"]
        directional=D(direction)*near
        record={
            "minute_after_onset":h,
            "NEAR_close_return_bps":str(near),
            "BTC_close_return_bps":str(returns["BTC-USDT-SWAP"]),
            "ETH_close_return_bps":str(returns["ETH-USDT-SWAP"]),
            "BTC_ETH_fixed_equal_weight_market_bps":str(control),
            "NEAR_minus_market_bps":str(near-control),
            "signed_NEAR_directional_bps":str(directional),
        }
        path.append(record)
        if first is None:
            if directional>=FIRST_PASSAGE_ABS_BPS:
                first={"first_passage":"DIRECTIONAL_100BPS_FIRST","minute":h,"at":record}
            elif directional<=-FIRST_PASSAGE_ABS_BPS:
                first={"first_passage":"ADVERSE_100BPS_FIRST","minute":h,"at":record}
    fixed={str(h):path[h-1] for h in REPORT_HORIZONS_MINUTES}
    if first is None:
        first={"first_passage":"CENSORED_60_MINUTES","minute":None,"at":None}
    return {
        "status":"SOURCE_COMPLETE_HISTORICAL_MINUTE_CLOSES",
        "outcome":first["first_passage"],
        "first_passage_minute":first["minute"],
        "first_passage_market_context":first["at"],
        "fixed_5_15_60minute_close_returns":fixed,
        "all_60minute_source_close_trajectory":path,
        "is_not_tradable_bid_ask_or_realized_PnL":True,
    }


def source_prices(root):
    prices={}
    source_sha={}
    for day in DAYS:
        prices[day]={}
        source_sha[day]={}
        for sym in SYMBOLS:
            rows,meta=archive_bars(root/"crossmarket-v27"/"module2",day,sym)
            prices[day][sym]={int(r[0]):D(r[4]) for r in rows}
            source_sha[day][sym]=meta["original_zip_sha256"]
    return prices,source_sha


def build(research_root):
    root=Path(research_root)
    source,source_sha=source_prices(root)
    trades={}
    trade_source_sha={}
    for day in DAYS:
        rows,metadata=load_trades(root/"official-trades-v25",day)
        trades[day]=rows
        trade_source_sha[day]=metadata["original_zip_sha256"]
    oi,oi_source_sha=load_oi_sources(root/"crossmarket-v27")
    news=load_news()
    all_decisions=[]
    onsets=[]
    trade_times_by_day={day:[event[0] for event in rows] for day,rows in trades.items()}
    next_permitted_ms=-1
    for t in decision_grid():
        day=datetime.fromtimestamp(t/1000,timezone.utc).date().isoformat()
        rows=trades[day]
        d=detector_at(t,rows,trade_times_by_day[day],source[day]["NEAR-USDT-SWAP"])
        if d["trigger_qualification"]=="QUALIFIED_WITHOUT_COOLDOWN":
            if t<next_permitted_ms:
                d["cooldown_suppressed"]=True
                d["trigger_qualification"]="SUPPRESSED_DUPLICATE"
            else:
                d["event_selected_after_60minute_cooldown"]=True
                next_permitted_ms=t+COOLDOWN_MINUTES*60000
                kind=d["onset_kind"]
                onset={
                    "id":f"{day}-{time_utc(t)[11:16]}",
                    "day":day,"decision_utc":time_utc(t),
                    "decision_ms":t,
                    "onset_kind":kind,
                    "direction":d["direction"],
                    "exante_detector_features":d,
                    "news_known_at_or_before_source_time_incomplete_registry":source_news_at(news,t),
                    "historical_hourly_OI_NOT_certified_known_at_signal":historical_oi_context(oi,t),
                }
                onsets.append(onset)
        all_decisions.append(d)
    # This is intentionally a SEPARATE PASS: outcomes cannot choose timestamps.
    for event in onsets:
        event["future_historical_barrier_outcome_HINDSIGHT_ONLY"]=first_passage(
            event,source[event["day"]]
        )
    total={
        "schema":SCHEMA,
        "status":"OFFLINE_ONSET_CHANGEPOINT_RESEARCH_ON_PREVIOUSLY_SEEN_DAYS_NOT_ALPHA",
        "signal_definition":{
            "decision_grid_minutes":934,
            "min_trades_last60s":MIN_TRADE_PRINTS,
            "min_signed_volume_fraction":str(MIN_SIGNED_FLOW_FRACTION),
            "min_recent_to_prior_perminute_volume_ratio":str(MIN_INTENSITY_RATIO),
            "muted_if_absolute_last_minute_close_bps_lte":str(MUTED_PRICE_ABS_BPS),
            "global_cooldown_minutes":COOLDOWN_MINUTES,
            "outcome_first_passage_minute_close_positive_negative_bps":str(FIRST_PASSAGE_ABS_BPS),
            "max_first_passage_censor_minutes":MAX_FUTURE_MINUTES,
            "not_tradable_in_true_realtime_without_timestamp_delivery_proof":True,
        },
        "previously_cached_original_source_sha256":{
            "module2_1m_archives":source_sha,
            "module1_NEAR_taker_trades":trade_source_sha,
            "hourly_NEAR_OI":oi_source_sha,
        },
        "all_934_precommitted_decision_minutes_including_abstains":all_decisions,
        "all_selected_onsets":onsets,
        "totals":{
            "decisions":len(all_decisions),
            "raw_qualifying_before_cooldown":sum(d["trigger_qualification"] in
               ("QUALIFIED_WITHOUT_COOLDOWN","SUPPRESSED_DUPLICATE") for d in all_decisions),
            "suppressed_by_cooldown":sum(d["cooldown_suppressed"] for d in all_decisions),
            "selected_unique_onsets":len(onsets),
            "selected_muted":sum(x["onset_kind"]=="MUTED_PRICE_RESPONSE" for x in onsets),
            "selected_visible":sum(x["onset_kind"]=="VISIBLE_PRICE_RESPONSE" for x in onsets),
        },
        "sep05_frozen_holdout_untouched":True,
        "all_outcomes_post_signal_only":True,
        "hourly_OI_source_publication_at_exact_timestamp_unverified":True,
        "news_registry_partial_and_cherry_picked_after_v24_outcomes":True,
        "no_book_or_trade_actor_identity_or_cancellation_intent":True,
        "no_statistically_independent_holdout_days":True,
        "no_actual_fills_spread_fee_slippage_funding_measured":True,
        "no_approved_new_trading_algorithm":True,
        "can_trade":False,
        "can_start_paper":False,
    }
    return total


def analyze_summary(result):
    groups={}
    for e in result["all_selected_onsets"]:
        category=e["onset_kind"]
        groups.setdefault(category,[]).append(e)
    summary=[]
    for category,episodes in sorted(groups.items()):
        counts={name:sum(x["future_historical_barrier_outcome_HINDSIGHT_ONLY"]["outcome"]==name
               for x in episodes)
            for name in ("DIRECTIONAL_100BPS_FIRST","ADVERSE_100BPS_FIRST",
                         "CENSORED_60_MINUTES","UNSCORABLE")}
        signed_market_relative_60=[]
        for e in episodes:
            outcome=e["future_historical_barrier_outcome_HINDSIGHT_ONLY"]
            fixed=outcome.get("fixed_5_15_60minute_close_returns",{})
            row=fixed.get("60")
            if row is not None:
                signed_market_relative_60.append(D(e["direction"])*D(row["NEAR_minus_market_bps"]))
        med=median(signed_market_relative_60) if signed_market_relative_60 else None
        summary.append({
            "classification":category,
            "onset_events":len(episodes),
            "unique_days":sorted(set(x["day"] for x in episodes)),
            "outcome_counts":counts,
            "median_signed_market_relative_60m_bps":str(med) if med is not None else None,
            "cannot_claim_independence_across_two_days":True,
        })
    return summary


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--original-research-root",required=True,type=Path)
    ap.add_argument("--out",required=True,type=Path)
    args=ap.parse_args()
    if args.out.exists():
        raise FileExistsError("Immutable v29 result already exists; do not overwrite")
    output=build(args.original_research_root)
    output["posthoc_descriptive_group_summary"]=analyze_summary(output)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("xb") as f:f.write(canonical(output)+b"\n")
    print(json.dumps({
        "status":output["status"],
        "totals":output["totals"],
        "groups":output["posthoc_descriptive_group_summary"],
        "original_output_sha256":sha256(args.out.read_bytes()),
        "can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
