#!/usr/bin/env python3
"""Real opened-data causality stress/readiness experiment, NOT efficacy testing."""
import argparse
from collections import Counter
import copy
from datetime import datetime,timezone
import json
import math
from pathlib import Path
import subprocess

import algorithm_memory_v37 as m
from algorithm_cohort_audit_v37 import audit

PRIOR_SHA="e51d7d6e25c33c5d2a784f8d063e3756cbac93fe80d2712fab3f5d1014f56d5c"


def load_cases(prior_root,source_root):
    p=prior_root/"first-development-v36.json"
    if (json.loads((prior_root/"run-status.json").read_bytes())["status"]!="COMPLETE"
            or m.band.replay.digest(p)!=PRIOR_SHA):raise ValueError("Require frozen completed v36")
    result=json.loads(p.read_bytes());cases=[]
    for c in result["cases"]:
        path=prior_root/"features"/f"{c['symbol']}-{c['day']}-restoration-v32.json"
        if m.band.replay.digest(path)!=c["restoration_cache_sha"]:raise ValueError("Prior feature cache changed")
        book=json.loads(path.read_bytes())
        rows,_,hashes,scope=m.band.lab.load_case(source_root/"source",c["day"],c["symbol"],locator=m.band.prior.pilot.registered)
        if hashes!=c["source_sha"]:raise ValueError("Prior raw source identity changed")
        rows,quotes=m.band.attach(rows,book)
        for row in rows:
            q=quotes.get(row["t"],{})
            spread=10000*math.log(float(q["ask"])/float(q["bid"])) if q.get("status")=="AVAILABLE" else 0
            risk=math.sqrt(15)*row["sigma"]
            row["features"]["price_capacity"]=risk/(risk+20+spread)
        if sum(r["ready"] for r in rows if r["t"] in scope)!=c["available_decisions"]:
            raise ValueError("Original common coverage changed")
        cases.append({"day":c["day"],"symbol":c["symbol"],"rows":rows,"quotes":quotes,"scope":scope})
    return cases,result


def run_symbol(cases,definitions,cutoff=None,perturb=False,eager_negative_control=False):
    memories={d["id"]:m.MaturedMemory(d["require_incremental"]) for d in definitions
              if d["operator"]=="matured-economic-memory"}
    anchor_map={r["t"]:(r,c["quotes"]) for c in cases for r in c["rows"]}
    counts=Counter();status=Counter();max_days=Counter()
    last_alarm={d["id"]:-1 for d in definitions}
    def resolver(t,direction,baseline,now):
        if not eager_negative_control and now<t+m.MATURITY_MS:
            raise ValueError("Attempted premature outcome access")
        row,quotes=anchor_map[t]
        if perturb:
            quotes={qtime:({**q,"bid":str(float(q["bid"])*1.1),"ask":str(float(q["ask"])*1.1)}
                if qtime>cutoff and q.get("status")=="AVAILABLE" else q) for qtime,q in quotes.items()}
        def value(d):
            if d==0:return 0.0
            x=m.band.replay.quote_outcome([],quotes,{"t":t,"direction":d,"barrier_bps":m.band.lab.barrier(row)})
            return x.get("after_20bp_fee_bps")
        net,control=value(direction),value(baseline)
        if net is None or control is None:return None
        return net,net-control
    for c in cases:
        case_rows=[r for r in c["rows"] if cutoff is None or r["t"]<=cutoff]
        rank={d["id"]:m.band.rank_actions({"state":["constant",0],"output":d["score"]},case_rows)
              for d in definitions if d["operator"]=="past-rank"}
        for i,row in enumerate(case_rows):
            t=row["t"]
            if cutoff is not None and t>cutoff:break
            for mem in memories.values():mem.advance(t,resolver)
            if t not in c["scope"] or not row["ready"]:continue
            for d in definitions:
                name=d["id"]
                if d["operator"]=="cash":continue
                if d["operator"]=="past-rank":action=rank[name][i]
                else:
                    proposal=m.sign(m.score(d,row["features"]))
                    if proposal==0:
                        status[name+":NO_PROPOSAL"]+=1;continue
                    key=m.cell(d,row["features"],proposal);mem=memories[name]
                    max_days[name]=max(max_days[name],sum(date<m.day(t) and key in bins for date,bins in mem.history.items()))
                    action,reason=mem.decision(t,key,proposal);status[name+":"+reason]+=1
                    if (t-min(c["scope"]))%(16*60000)==0:
                        baseline=m.sign(m.band.lab.expression(d["baseline"],row["features"],0,0))
                        if eager_negative_control:
                            # Intentionally broken audit comparator, never an admissible hypothesis mode.
                            label=resolver(t,proposal,baseline,t)
                            if label is not None:mem.history[m.day(t)][key].append(label);mem.resolved+=1
                        else:mem.schedule(t,key,proposal,baseline)
                if action and t>=last_alarm[name]+16*60000:
                    counts[name]+=1;last_alarm[name]=t
    return {"actions":dict(counts),"statuses":dict(status),"max_prior_day_blocks":dict(max_days),
            "memory_fingerprints":{k:v.fingerprint() for k,v in memories.items()},
            "resolved_labels":{k:v.resolved for k,v in memories.items()},
            "missing_labels":{k:v.missing for k,v in memories.items()}}


def experiment(prior_root,source_root,proposals,manifest_root,expected_head):
    workspace=Path(__file__).resolve().parents[2]
    head=subprocess.run(["git","rev-parse","HEAD"],cwd=workspace,capture_output=True,text=True,check=True).stdout.strip()
    dirty=subprocess.run(["git","status","--porcelain"],cwd=workspace,capture_output=True,text=True,check=True).stdout.strip()
    if head!=expected_head or dirty:raise ValueError("Require frozen clean audit pipeline")
    definitions,sha=m.load_definitions(proposals)
    manifests=[(p.name,p.read_bytes()) for p in sorted(manifest_root.glob("*.manifest.json"))]
    if len(manifests)!=5:raise ValueError("Known metadata catalog changed; inspect first")
    august=audit(manifests,[f"2026-08-{i:02d}" for i in range(1,21)],{"NEAR-USDT-SWAP","SOL-USDT-SWAP","BTC-USDT-SWAP","ETH-USDT-SWAP"})
    july=audit(manifests,[f"2026-07-{i:02d}" for i in range(1,21)],{"NEAR-USDT-SWAP","SOL-USDT-SWAP","BTC-USDT-SWAP","ETH-USDT-SWAP"})
    cases,original=load_cases(prior_root,source_root)
    readiness=[];stress=[]
    for symbol in m.band.prior.pilot.SYMBOLS:
        group=sorted((c for c in cases if c["symbol"]==symbol),key=lambda c:c["day"])
        readiness.append({"symbol":symbol,**run_symbol(group,definitions)})
        for c in group:
            for hour,minute in ((4,0),(8,0),(14,30)):
                cutoff=m.band.lab.source.v29.time_ms(c["day"],hour,minute)
                original_prefix=run_symbol(group,definitions,cutoff)
                changed_prefix=run_symbol(group,definitions,cutoff,True)
                eager=run_symbol(group,definitions,cutoff,False,True)
                eager_changed=run_symbol(group,definitions,cutoff,True,True)
                equal=original_prefix==changed_prefix
                if not equal:raise ValueError("Future changes altered causal memory prefix")
                stress.append({"symbol":symbol,"cutoff_utc":datetime.fromtimestamp(cutoff/1000,timezone.utc).isoformat(),
                    "causal_prefix_equal":equal,"premature_negative_control_detected":eager!=eager_changed})
    if not any(s["premature_negative_control_detected"] for s in stress):
        raise ValueError("Stress test not demonstrably sensitive to the premature negative control")
    controls={name:sum(r["actions"].get(name,0) for r in readiness) for name in ("rank-liquidity","rank-flow")}
    if controls!={"rank-liquidity":original["summary"]["interval-accounting"]["alarms"],
                  "rank-flow":original["summary"]["flow-baseline"]["alarms"]}:
        raise ValueError("Readiness controls disagree with original v36")
    return {"schema":"v37_causal_readiness_and_cohort_audit","frozen_head":head,"proposal_sha":sha,
        "prior_v36_sha":PRIOR_SHA,"cohort_audit_august":august,"cohort_proposal_july":july,
        "readiness":readiness,"future_corruption_stress":stress,
        "trading_efficacy_evaluated":False,"independent_validation":False,"effective_algorithm_confirmed":False,
        "new_source_payloads_downloaded":False,"unresolved_claim_registry_locations":True,
        "sampling_uncertainty_calibrated":False,"empirical_envelope_is_confidence_interval":False,
        "interpretation":"Engineering causality/readiness experiment on two opened dates. Cold-start abstention is expected and is not economic validation."}


def main():
    p=argparse.ArgumentParser()
    for name in ("prior-root","source-root","proposals","manifest-root","out"):
        p.add_argument("--"+name,type=Path,required=True)
    p.add_argument("--expected-head",required=True)
    a=p.parse_args()
    if a.out.exists():raise FileExistsError("Preserve first readiness/audit result")
    z=experiment(a.prior_root,a.source_root,a.proposals,a.manifest_root,a.expected_head)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    with a.out.open("x",encoding="utf-8") as f:json.dump(z,f,sort_keys=True,allow_nan=False)
    print(json.dumps({"sha":m.band.replay.digest(a.out),"august_status":z["cohort_audit_august"]["status"],
        "august_conflicts":z["cohort_audit_august"]["conflicts"],"readiness":z["readiness"],
        "causal_prefix_tests":len(z["future_corruption_stress"]),
        "negative_controls_detected":sum(x["premature_negative_control_detected"] for x in z["future_corruption_stress"])}))


if __name__=="__main__":main()
