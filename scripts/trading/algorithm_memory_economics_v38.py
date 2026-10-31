#!/usr/bin/env python3
"""Chronological DEVELOPMENT diagnostics; historical quote proxies are not PnL."""
from collections import Counter
from datetime import datetime,timezone
import json
import math
from pathlib import Path
import random
from statistics import mean

import algorithm_memory_v37 as m
import algorithm_foundation_v38 as f


def load_case(root,day,symbol):
    target=root/day
    p=target/"features"/f"{symbol}-{day}-restoration-v32.json"
    book=json.loads(p.read_bytes())
    if book.get("context_sha")!=f.context_sha(day,symbol):raise ValueError("Frozen cohort context changed")
    original,_,url=f.file_paths(target,day,symbol)
    receipt=json.loads(Path(str(original)+".receipt.json").read_bytes())
    if (receipt["source_url"]!=url or f.archives.digest(original)!=book["original_archive_sha"]
            or receipt["original_sha256"]!=book["original_archive_sha"]):
        raise ValueError("Original L2 identity changed")
    rows,_,hashes,scope=m.band.lab.load_case(target/"source",day,symbol,locator=f.registered)
    if hashes["tape"]!=book["trade_price_source_sha"]:raise ValueError("Price tape/source mismatch")
    labels=m.band.lab.episodes(rows,scope) # Ground truth before liquidity coverage exclusions.
    rows,quotes=m.band.attach(rows,book)
    for row in rows:
        q=quotes.get(row["t"],{})
        spread=10000*math.log(float(q["ask"])/float(q["bid"])) if q.get("status")=="AVAILABLE" else 0
        risk=math.sqrt(15)*row["sigma"]
        row["features"]["price_capacity"]=risk/(risk+20+spread)
    return {"day":day,"symbol":symbol,"rows":rows,"quotes":quotes,"scope":scope,"labels":labels,
        "source_sha":hashes,"feature_sha":f.archives.digest(p),"l2_sha":book["original_archive_sha"],
        "source_rows":book["source_rows"],"availability":dict(Counter(r["band_availability"] for r in rows if r["t"] in scope)),
        "sequence_ids_available":book["sequence_ids_available"]}


def quoted(c,t,direction):
    if direction==0:return {"status":"ABSTAIN","after_20bp_fee_bps":0.0}
    row=next(r for r in c["rows"] if r["t"]==t)
    return m.band.replay.quote_outcome([],c["quotes"],
        {"t":t,"direction":direction,"barrier_bps":m.band.lab.barrier(row)})


def additive_drawdown(values):
    total=peak=drawdown=0.0
    for x in values:
        total+=x;peak=max(peak,total);drawdown=max(drawdown,peak-total)
    return drawdown


def moving_block_sensitivity(cases,candidate="liquidity-payoff-memory"):
    """Joint asset-day panels; empirical bootstrap, conditional on assumptions."""
    days=sorted({c["day"] for c in cases})
    if len(days)<20:return {"status":"UNPOWERED_FEWER_THAN_20_DAYS","days":len(days)}
    dates=[datetime.fromisoformat(d) for d in days]
    if any((b-a).days!=1 for a,b in zip(dates,dates[1:])):
        return {"status":"UNPOWERED_NONCONTIGUOUS_DAY_BLOCKS","days":len(days)}
    ids=sorted(cases[0]["programs"]);panels={k:[] for k in ids}
    for day in days:
        group=[c for c in cases if c["day"]==day]
        if len(group)!=2 or any(c["programs"][k]["missing_quote_paths"] for c in group for k in ids):
            return {"status":"UNKNOWN_INCOMPLETE_COMMON_DAY_PANEL","days":len(days)}
        n=sum(c["available_decisions"] for c in group)
        if n==0:return {"status":"UNKNOWN_EMPTY_DAY_PANEL","days":len(days)}
        for k in ids:panels[k].append(sum(c["programs"][k]["sum_quote_20bp"] for c in group)/n)
    controls=[k for k in ids if k!=candidate];rng=random.Random(38);draws={k:[] for k in controls}
    absolute=[];n=len(days)
    for _ in range(2000):
        chosen=[]
        while len(chosen)<n:
            start=rng.randrange(n-2);chosen.extend(range(start,start+3))
        chosen=chosen[:n];absolute.append(mean(panels[candidate][i] for i in chosen))
        for k in controls:draws[k].append(mean(panels[candidate][i]-panels[k][i] for i in chosen))
    def interval(values):
        s=sorted(values);return [s[7],s[1992]] # Approx .4/99.6: absolute plus five paired contrasts.
    return {"status":"DEVELOPMENT_CONDITIONAL_SENSITIVITY_NOT_DISCOVERY","days":n,
        "block_days":3,"draws":2000,"seed":38,"joint_asset_days":True,
        "stationarity_and_block_length_sufficiency_certified":False,
        "multiple_comparisons":len(controls)+1,"paired_controls":len(controls),
        "candidate_absolute_interval":interval(absolute),
        "paired_intervals":{k:interval(v) for k,v in draws.items()},
        "unit":"Quoted proxy bp per available decision, not actual return"}


def evaluate_foundation(root,last_day):
    definitions,proposal_sha=m.load_definitions(Path(__file__).resolve().parents[2]/
        "docs/trading/ALGORITHM-MEMORY-PROPOSALS-v37.json")
    days=f.DAYS[:f.DAYS.index(last_day)+1]
    cases=[load_case(root,d,s) for d in days for s in f.SYMBOLS];results=[]
    for symbol in f.SYMBOLS:
        group=[c for c in cases if c["symbol"]==symbol]
        memories={d["id"]:m.MaturedMemory(d["require_incremental"]) for d in definitions
                  if d["operator"]=="matured-economic-memory"}
        anchors={r["t"]:c for c in group for r in c["rows"]}
        def resolver(t,direction,baseline,now):
            if now<t+m.MATURITY_MS:raise ValueError("Premature economic-label lookup")
            a=quoted(anchors[t],t,direction).get("after_20bp_fee_bps")
            b=quoted(anchors[t],t,baseline).get("after_20bp_fee_bps")
            return None if a is None or b is None else (a,a-b)
        for c in group:
            rows=c["rows"];actions={d["id"]:[0]*len(rows) for d in definitions};reasons=Counter();max_days=Counter()
            for d in definitions:
                if d["operator"]=="past-rank":
                    actions[d["id"]]=m.band.rank_actions({"state":["constant",0],"output":d["score"]},rows)
            for i,row in enumerate(rows):
                t=row["t"]
                for mem in memories.values():mem.advance(t,resolver)
                if not row["ready"] or t not in c["scope"]:continue
                for d in definitions:
                    if d["operator"]!="matured-economic-memory":continue
                    name=d["id"];proposal=m.sign(m.score(d,row["features"]))
                    if proposal==0:reasons[name+":NO_PROPOSAL"]+=1;continue
                    key=m.cell(d,row["features"],proposal);mem=memories[name]
                    max_days[name]=max(max_days[name],sum(date<m.day(t) and key in bins for date,bins in mem.history.items()))
                    action,reason=mem.decision(t,key,proposal);actions[name][i]=action;reasons[name+":"+reason]+=1
                    if (t-min(c["scope"]))%(16*60000)==0:
                        baseline=m.sign(m.band.lab.expression(d["baseline"],row["features"],0,0))
                        mem.schedule(t,key,proposal,baseline)
            scores={}
            for d in definitions:
                name=d["id"];s=m.band.lab.score(rows,actions[name],c["scope"],c["labels"])
                qs=[quoted(c,a["t"],a["direction"]) for a in s["records"]]
                values=[q["after_20bp_fee_bps"] for q in qs if "after_20bp_fee_bps" in q]
                pairs=list(zip(s["records"],qs));paired=[]
                for alarm,q in pairs:
                    i=next(i for i,r in enumerate(rows) if r["t"]==alarm["t"])
                    controls={k:quoted(c,alarm["t"],actions[k][i]).get("after_20bp_fee_bps")
                              for k in actions if k!=name}
                    paired.append({"t":alarm["t"],"own_quote_proxy":q.get("after_20bp_fee_bps"),
                                   "same_time_control_intents_without_cooldown":controls})
                missing=len(qs)-len(values)
                s.update(quoted_scenarios=qs,missing_quote_paths=missing,mean_quote_20bp=mean(values) if values else None,
                    sum_quote_20bp=sum(values) if not missing else None,
                    hypothetical_additive_drawdown_bp=additive_drawdown(values) if not missing else None,
                    execution_certified=False,news_context="UNKNOWN",funding_and_extra_slippage="UNKNOWN",
                    paired_direction_diagnostic=paired,
                    worst_quoted_counterexamples=sorted([{"t":a["t"],"proxy_bp":q["after_20bp_fee_bps"]}
                        for a,q in pairs if "after_20bp_fee_bps" in q],key=lambda x:x["proxy_bp"])[:3])
                scores[name]=s
            results.append({"day":c["day"],"symbol":symbol,"decisions":len(c["scope"]),
                "available_decisions":sum(r["ready"] for r in rows if r["t"] in c["scope"]),
                "availability":c["availability"],"episodes_before_liquidity_exclusions":len(c["labels"]),
                "source_sha":c["source_sha"],"l2_sha":c["l2_sha"],"feature_sha":c["feature_sha"],
                "source_rows":c["source_rows"],"sequence_ids_available":c["sequence_ids_available"],
                "memory_reasons":dict(reasons),"max_prior_day_blocks":dict(max_days),"programs":scores,
                "memory_state":{k:{"fingerprint":v.fingerprint(),"resolved":v.resolved,"missing":v.missing}
                                for k,v in memories.items()}})
    summary={}
    for d in definitions:
        name=d["id"];ps=[c["programs"][name] for c in results]
        vals=[q["after_20bp_fee_bps"] for p in ps for q in p["quoted_scenarios"] if "after_20bp_fee_bps" in q]
        summary[name]={"alarms":sum(p["alarms"] for p in ps),"mean_quote_20bp":mean(vals) if vals else None,
            "missing_quote_paths":sum(p["missing_quote_paths"] for p in ps),
            "detected_early":sum(p["detected_early"] for p in ps),"missed":sum(p["missed"] for p in ps),
            "unmatched_early_alarms":sum(p["unmatched_early_alarms"] for p in ps)}
    return {"schema":"memory_foundation_v38_development","days":list(days),"programs":definitions,
        "proposal_sha":proposal_sha,"summary":summary,"cases":results,
        "uncertainty_sensitivity":moving_block_sensitivity(results),"programs_tested":6,"fitted_variants":0,
        "independent_validation":False,"effective_algorithm_confirmed":False,"executable_pnl":False,
        "scientific_novelty_established":False,"news_oi_liquidation_funding_provenance":"UNKNOWN",
        "interpretation":"Training foundation DEVELOPMENT. Cold-start abstention is not an economic rejection; quote diagnostics are not actual PnL."}
