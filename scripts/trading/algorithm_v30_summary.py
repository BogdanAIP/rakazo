#!/usr/bin/env python3
"""v30 audit-locked summary: original L2 matched with frozen trade-only onsets.

A scientific research result, NOT a trade performance measure. Validates
all 4 expected first-pass results against their actual original SHA-256.
"""
from __future__ import annotations
import argparse,collections,json,math
from datetime import datetime,timezone,timedelta
from decimal import Decimal as D
from pathlib import Path
from statistics import median
from algorithm_v30_archive_acquire import DAYS,PRIMARIES,digest
from algorithm_multiday_registry_v12 import canonical,sha256

ORIGINALS={
 ("2026-09-10","NEAR-USDT-SWAP"):("462cac2d769b179ee1df01957a0a289fcf3688aa060300955834c3659114c655","7e259cb928861ca88ad5fd1603cbb7f809ac2cec6787ad22340bef0d8c853802"),
 ("2026-09-17","NEAR-USDT-SWAP"):("762e30472710c5c4047fa7aec2a38b809a447935e07b5aa2373a73a32f0ca275","3cfd39583847cc78f80a17429e43a631b87f776546ac7ca20ab39d1c542515e6"),
 ("2026-09-10","SOL-USDT-SWAP"):("ccf00f789fa3605aa956d28d2dd3736a3845d478a273300d64a444286bff37fe","fb9ed423668fd641b1a5b23e05c598ca9b8afc20c9ea3fdb2bdeb8dcbdab6ec7"),
 ("2026-09-17","SOL-USDT-SWAP"):("3597d87979a0ac03735378cdbbdac098415845b0409acc20f0cba94b0fdbd749","1e250c86cd35dbc92902c23ecd0c7971e63cae71c61869520ed23ae452dd1aa6"),
}
EVENTS=(
 {"key":"PPI","utc":"2026-09-10T12:30:00+00:00","headline":"BLS August 2026 Producer Price Index release","url":"https://www.bls.gov/news.release/archives/ppi_09102026.htm","source":"BLS official release embargo 08:30 ET"},
 {"key":"FOMC","utc":"2026-09-16T18:00:00+00:00","headline":"Federal Reserve FOMC interest-rate decision","url":"https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm","source":"Federal Reserve official 14:00 EDT release"},
 {"key":"NEAR-PR","utc":"2026-09-17T14:00:00+00:00","headline":"NEAR confidential TVL/snapshot press release","url":"https://www.prnewswire.com/news-releases/nearcoms-confidential-tvl-reaches-70-million-triggering-the-near3-33-snapshot-amid-industry-wide-privacy-wave-302881903.html","source":"NEAR-supplied PRNewswire timestamp 10:00 ET"},
)
def wilson(k,n,z=1.96):
    if not n:return None
    p=k/n
    den=1+z*z/n
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    mid=(p+z*z/(2*n))/den
    return [round(max(0,mid-half),4),round(min(1,mid+half),4)]

def data(root):
    cases=[]
    all_events=[]
    all_control=[]
    entry_spreads=[]
    known=[]
    market_excess=[]
    for day,sym in ORIGINALS:
        h_on,h_book=ORIGINALS[day,sym]
        p=Path(root)/"onsets"/f"{sym}-{day}-source-only-v30.json"
        q=Path(root)/"l2"/f"{sym}-{day}-joined-v30.json"
        if digest(p)!=h_on or digest(q)!=h_book:
            raise ValueError("v30 original source SHA mismatch "+day+" "+sym)
        a=json.loads(p.read_bytes());b=json.loads(q.read_bytes())
        assert a["schema"]=="algorithm_independent_v30_tape_onset_case"
        assert len(a["all_467_decision_minutes"])==467
        assert len(b["events"])==len(a["selected_onsets"])
        assert a["totals"]["first_onsets"]==len(a["selected_onsets"])
        case=collections.Counter()
        case["decisions"]=467
        case["raw_qualified"]=a["totals"]["qualified_before_cooldown"]
        case["suppressed"]=a["totals"]["suppressed"]
        case["selected"]=len(a["selected_onsets"])
        case["muted"]=a["totals"]["muted"]
        for i,(on,book) in enumerate(zip(a["selected_onsets"],b["events"])):
            if (on["id"]!=book["id"] or on["utc"]!=book["utc"] or
                on["outcome_HINDSIGHT_ONLY"]["outcome"]!=book["future_first_passage"]):
                raise ValueError("Incorrect joined book outcome or signal order")
            gr=book["group"]
            outcome=book["future_first_passage"]
            if gr not in ("ALIGNED","UNALIGNED","L2_UNAVAILABLE"):
                raise ValueError("Unexpected L2 group")
            case[gr]+=1
            case[outcome]+=1
            event_dt=datetime.fromisoformat(on["utc"])
            matched=[]
            for release in EVENTS:
                pub=datetime.fromisoformat(release["utc"])
                if timedelta(0)<=event_dt-pub<=timedelta(minutes=120):
                    matched.append(release["key"])
            if matched:known.append({"onset_id":on["id"],"official_120min_preceding":matched})
            spread_p=Path(root)/"l2"/f"{sym}-{day}"/f"event-{i:02d}.json"
            x=json.loads(spread_p.read_bytes())
            if (x["event_id"]!=on["id"] or not x["both_asof_available"]
                or book["original_book_sha256"]!=digest(spread_p)):
                raise ValueError("Original per-event full source quotes not independently verified")
            orig=x["original_t_book"]
            bid,ask=D(orig["bid"]),D(orig["ask"])
            spread=D(10000)*(ask-bid)/((ask+bid)/2)
            entry_spreads.append({"id":on["id"],"spread_bps":str(spread),
                                  "symbol":sym,"direction":on["direction"]})
            f=on["outcome_HINDSIGHT_ONLY"]["fixed_5_15_60"]
            if len(f)!=3:raise ValueError("Fixed prespecified +5,+15,+60 horizon missing")
            case_summary={}
            for item in f:
                if item["h"] not in (5,15,60):raise ValueError("Horizon mutated")
                z=D(item["instrument_excess_bps"])*D(on["direction"])
                case_summary[str(item["h"])]=str(z)
            market_excess.append({"id":on["id"],"symbol":sym,"group":gr,
                                  "signed_excess_bps":case_summary})
            all_events.append({"id":on["id"],"day":day,"symbol":sym,
                "group":gr,"outcome":outcome,"official_known_pre120":matched,
                "entry_spread_bps":str(spread),
                "signed_excess_5_15_60":case_summary})
        statuses=collections.Counter(x["status"] for x in a["negative_controls"])
        ctrl_outcomes=collections.Counter(
            x["outcome_HINDSIGHT_ONLY"]["outcome"]
            for x in a["negative_controls"] if x["status"]=="SCORED_NO_ONSET_CONTROL")
        for record in a["negative_controls"]:
            all_control.append((day,sym,record["status"],record.get("outcome_HINDSIGHT_ONLY",{}).get("outcome")))
        case["control_scored"]=statuses["SCORED_NO_ONSET_CONTROL"]
        case["control_excluded"]=statuses["PREDECLARED_EXCLUDED_ONSET_OR_PRIOR_COOLDOWN"]
        case["control_no_direction"]=statuses["DIRECTION_UNAVAILABLE"]
        cases.append({"day":day,"symbol":sym,"source_tape_sha256":h_on,
            "source_join_sha256":h_book,
            "counts":dict(case),"negative_control_outcomes":dict(ctrl_outcomes)})
    counts=collections.defaultdict(collections.Counter)
    for e in all_events:
        counts[e["group"]][e["outcome"]]+=1
    groups={}
    for group in ("ALIGNED","UNALIGNED","L2_UNAVAILABLE"):
        c=counts[group]
        n=sum(c.values());k=c["FAVORABLE_FIRST"]
        groups[group]={"n":n,"favorable_first":k,"adverse_first":c["ADVERSE_FIRST"],
            "censored_60min":c["CENSORED_60"],
            "favorable_fraction":round(k/n,6) if n else None,
            "wilson_95_descriptive_not_iid":wilson(k,n)}
    aligned=groups["ALIGNED"];unaligned=groups["UNALIGNED"]
    diff=aligned["favorable_fraction"]-unaligned["favorable_fraction"]
    control_counts=collections.Counter(x[2] for x in all_control)
    control_out=collections.Counter(x[3] for x in all_control if x[2]=="SCORED_NO_ONSET_CONTROL")
    med_spread=median(D(e["spread_bps"]) for e in entry_spreads)
    med_excess={str(h):str(median(D(e["signed_excess_bps"][str(h)]) for e in market_excess))
                for h in (5,15,60)}
    by_symbol={}
    for sym in PRIMARIES:
        cs=[e for e in all_events if e["symbol"]==sym]
        by_symbol[sym]={
            "selected_onsets":len(cs),
            "favorable_first":sum(e["outcome"]=="FAVORABLE_FIRST" for e in cs),
            "adverse_first":sum(e["outcome"]=="ADVERSE_FIRST" for e in cs),
            "censored_60":sum(e["outcome"]=="CENSORED_60" for e in cs),
            "entry_quote_spread_median_bps":str(median(D(e["entry_spread_bps"]) for e in cs)),
            "market_relative_signed_median_60min_bps":str(median(
                D(e["signed_excess_5_15_60"]["60"]) for e in cs))}
    return {"schema":"algorithm_v30_locked_source_summary",
        "method":"preregistered source-time detector, authentic L2 closest prior snapshot strict asof",
        "expected_decisions":1868,"actual_decisions":sum(c["counts"]["decisions"] for c in cases),
        "raw_qualified":sum(c["counts"]["raw_qualified"] for c in cases),
        "suppressed":sum(c["counts"]["suppressed"] for c in cases),
        "selected_onsets":len(all_events),"muted":sum(c["counts"]["muted"] for c in cases),
        "strict_L2_asof_covered":sum(e["group"]!="L2_UNAVAILABLE" for e in all_events),
        "groups":groups,"primary_D_aligned_minus_unaligned":round(diff,6),
        "negative_controls":{"expected_grid":32,"scored":control_counts["SCORED_NO_ONSET_CONTROL"],
            "excluded_cooldown_or_onset":control_counts["PREDECLARED_EXCLUDED_ONSET_OR_PRIOR_COOLDOWN"],
            "missing_direction":control_counts["DIRECTION_UNAVAILABLE"],
            "outcomes":dict(control_out)},
        "cases":cases,"by_symbol":by_symbol,
        "quote_scenario":{"entry_spread_median_bps":str(med_spread),
                          "5bp_each_side_fee_only_roundtrip_bps":10,
                          "10bp_each_side_fee_only_roundtrip_bps":20,
                          "real_exit_book_quote_unverified":True,
                          "true_trade_PnL_and_fill_latency":"UNAVAILABLE"},
        "median_signed_instrument_minus_BTC_ETH_market_bps":med_excess,
        "news":{"official_sources":EVENTS,
                "onsets_with_known_official_release_in_120min":known,
                "indexed_source_count":len(EVENTS),
                "coverage":"INCOMPLETE; absence of registered headline NOT absence of news",
                "news_availability_live_latency":"UNKNOWN"},
        "all_original_event_records":all_events,
        "real_order_execution":False,"live_clock_arrival_certified":False,
        "original_L2_sequence_identifiers_available":False,
        "approved_profitable_algorithm":False}
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Immutable research summary exists")
    o=data(a.root)
    with a.out.open("xb") as f:f.write(canonical(o)+b"\n")
    slim={k:v for k,v in o.items() if k not in ("all_original_event_records","cases")}
    slim["output_SHA256"]=digest(a.out)
    print(json.dumps(slim,ensure_ascii=False,sort_keys=True))
if __name__=="__main__":main()
