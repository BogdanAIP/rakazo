#!/usr/bin/env python3
"""v28 research-only, deterministic, outcome-aware 66-anchor controls.
Joins genuine already cached official OKX L2, taker, minute CSV, historical OI
and previously curated dated news. No downloads, no orders, no model fitting.
NOT independent alpha validation: input dates and selected wins known from v24.
"""
from __future__ import annotations
import argparse
import bisect
import csv
from datetime import datetime,timezone
from decimal import Decimal as D
import hashlib
import io
import json
from pathlib import Path
import statistics
import zipfile

from algorithm_independent_days_v24 import config_sha
from algorithm_module2_crossmarket_v27 import archive_bars
from algorithm_crossmarket_v27 import load_one
from algorithm_news_pit_v26 import load as load_news, parse_utc
from algorithm_temporal_response_v23 import signal_at,midpoint,imbalance
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_controls_66_v28"
DAYS=("2026-09-03","2026-09-04")
SYMBOLS=("NEAR-USDT-SWAP","BTC-USDT-SWAP","ETH-USDT-SWAP")
HORIZONS=(5,15,60)
FEATURE_TRADE_WINDOWS=((-300,-30),(-30,0))
MIN_EXTREME_BPS=D(100)
MIN_RELATIVE_BPS=D(100)
V24_RESULTS={
    "2026-09-03":"056aaca7417863f76b9445d692a82ae971f1f0f647c47f999d40173d000049e2",
    "2026-09-04":"d66eb33ebd6e76f9fe407ba91d2bd5a41a61f94b735018125abedac9b1fa2fe5",
}
TRADE_ZIP_SHA={
    "2026-09-03":"6cbc879df4aa9eb2986fb6632183eeaa640c7b1ef988cb6f4be831d94bc568ec",
    "2026-09-04":"295d1a3e30c8970ae041a21906eb56ac6970698809923c5881ee3c576b6d41e8",
}


def day_ms(day):
    return int(datetime.fromisoformat(day+"T00:00:00+00:00").timestamp()*1000)


def anchors():
    results=[]
    for day in DAYS:
        base=day_ms(day)
        for j in range(29):results.append(base+(120+j*15)*60000)
        for minute in (0,15,30,45):
            results.append(base+(14*60+minute)*60000)
    assert len(results)==66 and len(set(results))==66
    return tuple(results)


def label(ms):
    return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat()


def lookup_q(result,t):
    q=result["all_quotes_at_predeclared_targets"].get(str(t))
    if q is None or q.get("status")!="AVAILABLE":
        return None
    if not(0<=q["book_asof_age_ms"]<=5000
           and 0<q["book_bracket_delay_ms"]<=5000):
        raise ValueError("v24 quote asof coverage invalid")
    return q


def load_book(original_root,day):
    p=Path(original_root)/f"NEAR-{day}"/f"NEAR-{day}-frozen-v23-replication-v24.json"
    raw=p.read_bytes()
    if sha256(raw)!=V24_RESULTS[day]:
        raise ValueError("Original v24 L2 result changed since audited")
    r=strictly_decode(raw)
    if r.get("day_utc")!=day or r.get("configuration_sha256")!=config_sha(day):
        raise ValueError("Original L2 date or prereg book formula mutated")
    if r.get("targets_available")!=414 or r.get("can_trade") is not False:
        raise ValueError("Incomplete source quote evidence")
    return r


def load_trades(root,day):
    p=Path(root)/f"NEAR-USDT-SWAP-trades-{day}-UTCplus8.zip"
    receipt=strictly_decode(Path(str(p)+".receipt.json").read_bytes())
    raw=p.read_bytes()
    if (sha256(raw)!=TRADE_ZIP_SHA[day] or receipt.get("sha256")!=sha256(raw)):
        raise ValueError("Original taker source tampered")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name=f"NEAR-USDT-SWAP-trades-{day}.csv"
        if z.namelist()!=[name]:
            raise ValueError("Unexpected original tick trade member")
        with z.open(name) as f:
            reader=csv.DictReader(io.TextIOWrapper(f,encoding="utf-8-sig"))
            expected=["instrument_name","trade_id","side","price","size","created_time","source"]
            if reader.fieldnames!=expected:
                raise ValueError("Actual archive trade schema mismatch")
            records=[]
            prior=-1
            ids=set()
            for x in reader:
                if x["instrument_name"]!="NEAR-USDT-SWAP" or x["side"] not in ("buy","sell"):
                    raise ValueError("Unrecognized source taker side or instrument")
                ms=int(x["created_time"])
                date_plus8=datetime.fromtimestamp((ms+8*3600000)/1000,timezone.utc).date().isoformat()
                if date_plus8!=day or ms<prior or x["trade_id"] in ids:
                    raise ValueError("Original trade source timestamp, day or unique ID invalid")
                if ms>=day_ms("2026-09-05"):
                    raise ValueError("Never ingest reserved Sep05 UTC holdout trades")
                qty=D(x["size"])
                if qty<=0 or D(x["price"])<=0:raise ValueError("Invalid source trade")
                prior=ms
                ids.add(x["trade_id"])
                records.append((ms,x["side"],qty))
    return records,{"original_zip_sha256":sha256(raw),"total_original_trade_rows":len(records)}


def trade_feature(records,times,t,left_s,right_s):
    lo=bisect.bisect_left(times,t+left_s*1000)
    hi=bisect.bisect_left(times,t+right_s*1000)
    subset=records[lo:hi]
    buys=sum((qty for _,side,qty in subset if side=="buy"),D(0))
    sells=sum((qty for _,side,qty in subset if side=="sell"),D(0))
    total=buys+sells
    duration=right_s-left_s
    return {
        "period_relative_seconds":[left_s,right_s],
        "executed_trade_rows":len(subset),
        "taker_buy_contracts":str(buys),
        "taker_sell_contracts":str(sells),
        "total_taker_contracts":str(total),
        "buy_share_contracts":str(buys/total) if total else None,
        "signed_taker_fraction":str((buys-sells)/total) if total else None,
        "contracts_per_second":str(total/D(duration)),
        "original_trade_ids_not_in_quote_feed":True,
    }


def load_oi_sources(root):
    data={}
    hashes={}
    for name in ("sep03_loss","sep03_win","sep04_loss","sep04_win"):
        pair=load_one(root,name,"NEAR-USDT-SWAP","oi")
        if pair is None:
            raise ValueError("Previously verified genuine archived OI missing")
        rows,receipt=pair
        hashes[name]=receipt["raw_response_sha256"]
        for x in rows:
            ts=int(x[0])
            value=D(x[1])
            if ts in data and data[ts]!=value:
                raise ValueError("Overlapping genuine OI history disagrees between original responses")
            data[ts]=value
    return data,hashes


def historical_oi_context(oi,t):
    floored=(t//3_600_000)*3_600_000
    older=floored-2*3_600_000
    recent=floored-1*3_600_000
    a=oi.get(older)
    b=oi.get(recent)
    return {
        "older_hour_utc":label(older),
        "latest_hour_strictly_before_signal_hour_utc":label(recent),
        "older_oi_contracts":str(a) if a is not None else None,
        "latest_oi_contracts":str(b) if b is not None else None,
        "historical_hourly_oi_change_percent":str(D(100)*(b/a-D(1))) if a and b else None,
        "availability_at_actual_signal_unverified":True,
        "not_individual_liquidation_or_order_identity":True,
    }


def source_news_at(news,t):
    now=datetime.fromtimestamp(t/1000,timezone.utc)
    known=[]
    future=[]
    for e in news["events"]:
        availability=e.get("first_available_utc")
        if not availability or parse_utc(availability)>now:
            continue
        event_at=parse_utc(e["event_time_utc"])
        entry={
            "event_id":e["id"],"event_utc":e["event_time_utc"],
            "first_known_utc":availability,"source_url":e["source_url"],
            "timestamp_type":e["timestamp_type"],
            "source_reliability":e["source_reliability"],
        }
        if event_at<=now:
            known.append(entry)
        elif event_at<=now+__import__("datetime").timedelta(hours=2):
            future.append(entry)
    count2h=sum(0<=(now-parse_utc(e["event_utc"])).total_seconds()<=2*3600 for e in known)
    count6h=sum(0<=(now-parse_utc(e["event_utc"])).total_seconds()<=6*3600 for e in known)
    return {
        "curated_past_occurrences_already_published":known,
        "curated_preannounced_future_within_2h":future,
        "curated_known_past_event_count_last_2h":count2h,
        "curated_known_past_event_count_last_6h":count6h,
        "news_registry_is_INCOMPLETE_not_all_market_news":True,
    }


def close_features(bars,t):
    bytime={int(r[0]):D(r[4]) for r in bars}
    base=bytime.get(t-60000)
    if base is None or base<=0:
        return {"status":"MISSING_COMPLETED_1MIN_BAR","base_close":None,"bps":{str(h):None for h in HORIZONS}}
    out={}
    for h in HORIZONS:
        cl=bytime.get(t+(h-1)*60000)
        out[str(h)]=str(D(10000)*(cl/base-D(1))) if cl is not None else None
    return {
        "status":"ORIGINAL_COMPLETED_BAR_ONLY",
        "base_bar_start_utc":label(t-60000),
        "base_close":str(base),"bps":out,
        "no_future_bar_at_time_t_used":True,
    }


def outcome_class(x):
    if x is None:return "SOURCE_UNAVAILABLE"
    val=D(x)
    return "EXTREME_UP" if val>=MIN_EXTREME_BPS else (
        "EXTREME_DOWN" if val<=-MIN_EXTREME_BPS else "NONEXTREME"
    )


def description(records):
    by_class={}
    for r in records:
        c=r["outcome_60m"]["NEAR_absolute_class"]
        by_class.setdefault(c,[]).append(r)
    summary=[]
    for klass,samples in sorted(by_class.items()):
        def stats(key):
            vals=[]
            for row in samples:
                value=key(row)
                if value is not None:vals.append(D(value))
            if not vals:return {"observed":0,"median":None,"mean":None}
            vals.sort()
            mid=(vals[(len(vals)-1)//2]+vals[len(vals)//2])/D(2)
            return {"observed":len(vals),"median":str(mid),"mean":str(sum(vals,D(0))/D(len(vals)))}
        summary.append({
            "outcome_class":klass,"anchors":len(samples),
            "market_days":sorted({r["day"] for r in samples}),
            "original_shock_eligible_count":sum(r["exante_features"]["shock_rule"]["status"]=="ELIGIBLE" for r in samples),
            "median_and_mean_abs_dI":stats(lambda r:abs(D(r["exante_features"]["delta_book_imbalance"])) if r["exante_features"].get("delta_book_imbalance") is not None else None),
            "median_and_mean_pre30_buy_share":stats(lambda r:r["exante_features"]["trade_pre30s"]["buy_share_contracts"]),
            "median_and_mean_pre30_vs_270s_trade_rate":stats(lambda r:r["exante_features"]["taker_rate_ratio_30s_to_previous_270s"]),
            "median_and_mean_oi_change_percent_unverified_point_in_time":stats(lambda r:r["historical_context_not_certified_PIT"]["OI"]["historical_hourly_oi_change_percent"]),
            "news_item_count_last2h_total_NOT_news_density":sum(r["exante_features"]["curated_news"]["curated_known_past_event_count_last_2h"] for r in samples),
        })
    return summary


def compute(orig_root):
    root=Path(orig_root)
    oi,oi_sha=load_oi_sources(root/"crossmarket-v27")
    news=load_news()
    books={}
    trades={}
    trade_meta={}
    candles={}
    candle_meta={}
    for day in DAYS:
        books[day]=load_book(root/"official-l2-v24",day)
        trades[day],trade_meta[day]=load_trades(root/"official-trades-v25",day)
        candles[day]={}
        candle_meta[day]={}
        for sym in SYMBOLS:
            candles[day][sym],candle_meta[day][sym]=archive_bars(root/"crossmarket-v27"/"module2",day,sym)
    if len(anchors())!=66:raise ValueError("Reg cohort changed")
    result=[]
    for t in anchors():
        day=datetime.fromtimestamp(t/1000,timezone.utc).date().isoformat()
        original=books[day]
        prev=lookup_q(original,t-30000)
        cur=lookup_q(original,t)
        if cur is not None:
            rule=signal_at(prev,cur,"pressure_shock_without_mid_adaptation")
            I=str(imbalance(cur))
            dI=str(imbalance(cur)-imbalance(prev)) if prev else None
            drift=str(D(10000)*(midpoint(cur)/midpoint(prev)-D(1))) if prev else None
            spread=str(D(10000)*(D(cur["ask"])-D(cur["bid"]))/midpoint(cur))
        else:
            rule={"status":"ABSTAIN_NO_ANCHOR_BOOK","direction":None}
            I=dI=drift=spread=None
        timeline=trades[day]
        times=[x[0] for x in timeline]
        if not(timeline[0][0]<=t-300000 and timeline[-1][0]>=t):
            raise ValueError("Registered signal had no complete pre300 trade coverage")
        prior=trade_feature(timeline,times,t,-300,-30)
        recent=trade_feature(timeline,times,t,-30,0)
        rate0=D(prior["contracts_per_second"])
        rate1=D(recent["contracts_per_second"])
        rate_ratio=str(rate1/rate0) if rate0>0 else None
        prices={sym:close_features(candles[day][sym],t) for sym in SYMBOLS}
        outcome={}
        for h in HORIZONS:
            a=prices["NEAR-USDT-SWAP"]["bps"][str(h)]
            b=prices["BTC-USDT-SWAP"]["bps"][str(h)]
            e=prices["ETH-USDT-SWAP"]["bps"][str(h)]
            if a is None or b is None or e is None:
                outcome[str(h)]={"status":"MISSING_ACTUAL_ONE_MIN_CANDLE","NEAR_bps":a,"market_control_bps":None,"NEAR_excess_bps":None}
            else:
                ctrl=(D(b)+D(e))/D(2)
                outcome[str(h)]={
                    "status":"ORIGINAL_HISTORICAL_MINUTE_CLOSES",
                    "NEAR_bps":a,"BTC_bps":b,"ETH_bps":e,
                    "market_control_bps":str(ctrl),"NEAR_excess_bps":str(D(a)-ctrl),
                }
        main=outcome["60"]
        record={
            "signal_utc":label(t),"signal_exchange_utc_ms":t,"day":day,
            "exante_features":{
                "original_v24_L2_tminus30s":prev,
                "original_v24_L2_t":cur,
                "book_imbalance_now":I,"delta_book_imbalance":dI,
                "midprice_change_in_last30s_bps":drift,
                "spread_now_bps":spread,"shock_rule":rule,
                "trade_previous270s":prior,"trade_pre30s":recent,
                "taker_rate_ratio_30s_to_previous_270s":rate_ratio,
                "curated_news":source_news_at(news,t),
            },
            "historical_context_not_certified_PIT":{
                "OI":historical_oi_context(oi,t)
            },
            "OUTCOMES_HINDSIGHT_NOT_FEATURES":outcome,
            "outcome_60m":{
                "NEAR_absolute_class":outcome_class(main["NEAR_bps"]),
                "NEAR_relative_class":outcome_class(main["NEAR_excess_bps"]),
                "observed_NEAR_bps":main["NEAR_bps"],
                "observed_excess_bps":main["NEAR_excess_bps"],
            },
            "counts_as_independent_market_day":False,
        }
        result.append(record)
    raw_sources={
        "module2_1m_ZIP_originals":candle_meta,
        "NEAR_taker_ZIP_originals":trade_meta,
        "NEAR_L2_v24_result_original_sha256":V24_RESULTS,
        "NEAR_OI_4_original_rest_sha256":oi_sha,
        "news_registry_source":"docs/trading/ALGORITHM-NEWS-PIT-EVENTS-v26-20261031.json",
    }
    return {
        "schema":SCHEMA,
        "status":"66_TIME_ONLY_ANCHORS_POST_HOC_MULTI_SOURCE_MECHANISM_EXPLORATION",
        "source_dates_utc":list(DAYS),
        "minute_targets_fixed_before_this_join":list(HORIZONS),
        "fixed_extreme_60m_move_bps":str(MIN_EXTREME_BPS),
        "fixed_absolute_excess_60m_bps":str(MIN_RELATIVE_BPS),
        "registered_time_anchor_count":len(result),
        "original_verified_source_provenance":raw_sources,
        "all_anchors_full_evidence":result,
        "outcome_groups_descriptive_not_inferential":description(result),
        "news_registry_partial_and_curated_hindsight":True,
        "original_OI_hour_timestamp_publication_latency_unverified":True,
        "adjacent_anchors_and_days_nonindependent":True,
        "market_impact_fill_fee_slippage_not_measured":True,
        "not_tested_on_sep05_or_untouched_market_days":True,
        "source_event_gaplessness_NOT_independently_proven":True,
        "no_source_individual_order_ids_spoofing_intent_unproven":True,
        "no_alphas_discovered_or_validated":True,
        "realised_PnL":None,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--original-research-root",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():raise FileExistsError("Do not overwrite original v28 analysis")
    out=compute(args.original_research_root)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("xb") as f:f.write(canonical(out)+b"\n")
    print(json.dumps({
        "status":out["status"],
        "anchors":out["registered_time_anchor_count"],
        "group_summary":out["outcome_groups_descriptive_not_inferential"],
        "new_rule_status":"NONE_VALIDATED",
        "result_SHA256":sha256(args.out.read_bytes()),
        "can_trade":False,
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
