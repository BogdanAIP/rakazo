#!/usr/bin/env python3
"""Research-only synthesis of executable market programs (typed AST grammar).

Explores structurally distinct programs in three representation families.
Falsifies them on chronological out-of-sample data and a max-null test.
This is NOT proof of scientific novelty, profitability, or AI autonomy.
No LLM calls, dynamic eval/exec, network, private keys, PAPER or real orders.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path

from alpha_discovery import load_csv

FEATURES = ("return", "body", "range", "location", "wick", "volume_change")
FAMILIES = ("compositions", "interactions", "stateful_conditionals")
SIDE_COST = 0.0007  # research assumption 5bp taker + 2bp slippage
ROUND_TRIP_COST = SIDE_COST * 2
ALLOC = 0.1
SIGNAL_FLOOR = 0.2
MIN_BARS = 1200
NULL_SHIFTS = 39
MAX_DEPTH = 5
MAX_PER_FAMILY = 48


def clip(v):
    return max(-8.0, min(8.0, v)) if math.isfinite(v) else 0.0


def identity(program):
    return hashlib.sha256(json.dumps(program, separators=(",", ":")).encode()).hexdigest()


def validate_ast(program, depth=0):
    if depth > MAX_DEPTH or not isinstance(program, list) or not program:
        raise ValueError("Invalid AST shape/depth")
    op = program[0]
    if op == "feature" and len(program) == 2 and program[1] in FEATURES:
        return
    if op in ("neg", "abs", "tanh", "delta", "cusum") and len(program) == 2:
        validate_ast(program[1], depth+1)
        return
    if op in ("lag", "mean", "ema") and len(program) == 3:
        valid = {"lag": (1, 4), "mean": (3, 8, 16), "ema": (2, 5)}[op]
        if type(program[1]) is not int or program[1] not in valid:
            raise ValueError("Unsupported trailing horizon")
        validate_ast(program[2], depth+1)
        return
    if op in ("add", "sub", "mul", "div") and len(program) == 3:
        validate_ast(program[1], depth+1)
        validate_ast(program[2], depth+1)
        return
    if op == "if_pos" and len(program) == 4:
        for child in program[1:]:
            validate_ast(child, depth+1)
        return
    raise ValueError("Unsafe or unsupported research AST operator")


def base_features(bars):
    n=len(bars)
    table={key:[] for key in FEATURES}
    for i, b in enumerate(bars):
        prev=bars[i-1] if i else b
        range_size=max(b.hi-b.lo, 1e-12)
        upper=b.hi-max(b.op,b.cl)
        lower=min(b.op,b.cl)-b.lo
        values={
            "return": 100*math.log(b.cl/prev.cl) if i else 0.0,
            "body": 100*math.log(b.cl/b.op),
            "range": 100*math.log(b.hi/b.lo),
            "location": 2*(b.cl-b.lo)/range_size-1,
            "wick": (upper-lower)/range_size,
            "volume_change": math.log((b.volume+1)/(prev.volume+1)) if i else 0.0,
        }
        for key, val in values.items():
            table[key].append(clip(val))
    assert all(len(v)==n for v in table.values())
    return table


def evaluate(program, features, cache=None):
    """Every output at i depends only on inputs at indices <=i."""
    validate_ast(program)
    if cache is None:
        cache={}
    key=identity(program)
    if key in cache:
        return cache[key]
    op=program[0]
    if op == "feature":
        out=features[program[1]]
    elif op in ("neg", "abs", "tanh", "delta", "cusum"):
        x=evaluate(program[1], features, cache)
        if op == "neg":
            out=[clip(-v) for v in x]
        elif op == "abs":
            out=[abs(v) for v in x]
        elif op == "tanh":
            out=[math.tanh(v) for v in x]
        elif op == "delta":
            out=[clip(x[i]-x[i-1]) if i else 0.0 for i in range(len(x))]
        else:
            out=[]
            state=0.0
            for i,v in enumerate(x):
                # bounded causal memory state, not a known profitability claim
                state=clip(0.85*state+v-(x[i-1] if i else 0.0))
                out.append(state)
    elif op in ("lag", "mean", "ema"):
        horizon=program[1]
        x=evaluate(program[2], features, cache)
        if op == "lag":
            out=[x[i-horizon] if i>=horizon else 0.0 for i in range(len(x))]
        elif op == "mean":
            running=0.0
            out=[]
            for i,v in enumerate(x):
                running+=v
                if i>=horizon:
                    running-=x[i-horizon]
                out.append(clip(running/min(horizon,i+1)))
        else:
            alpha=2/(horizon+1)
            state=0.0
            out=[]
            for v in x:
                state=clip(alpha*v+(1-alpha)*state)
                out.append(state)
    elif op in ("add", "sub", "mul", "div"):
        a=evaluate(program[1],features,cache)
        b=evaluate(program[2],features,cache)
        if op=="add":
            out=[clip(x+y) for x,y in zip(a,b)]
        elif op=="sub":
            out=[clip(x-y) for x,y in zip(a,b)]
        elif op=="mul":
            out=[clip(x*y) for x,y in zip(a,b)]
        else:
            out=[clip(x/y) if abs(y)>0.05 else 0.0 for x,y in zip(a,b)]
    elif op=="if_pos":
        condition=evaluate(program[1],features,cache)
        yes=evaluate(program[2],features,cache)
        no=evaluate(program[3],features,cache)
        out=[x if c>0 else y for c,x,y in zip(condition,yes,no)]
    else:
        raise AssertionError("AST validator incomplete")
    cache[key]=out
    return out


def leaf(rng):
    return ["feature",rng.choice(FEATURES)]


def unary(rng, operand):
    op=rng.choice(["neg","abs","tanh","delta","lag","mean","ema","cusum"])
    if op in ("lag","mean","ema"):
        return [op,rng.choice({"lag":[1,4],"mean":[3,8,16],"ema":[2,5]}[op]),operand]
    return [op,operand]


def binary(rng, a, b):
    return [rng.choice(["add","sub","mul","div"]),a,b]


def generate(family,rng):
    """Compose a complete program, not just select indicator parameters."""
    a=leaf(rng)
    b=leaf(rng)
    c=leaf(rng)
    if family=="compositions":
        return unary(rng,binary(rng,unary(rng,a),b))
    if family=="interactions":
        return binary(rng,unary(rng,binary(rng,a,b)),unary(rng,c))
    if family=="stateful_conditionals":
        return ["if_pos",["ema",5,a],unary(rng,["cusum",b]),
                binary(rng,["lag",4,c],["mean",3,leaf(rng)])]
    raise ValueError("Unknown hypothesis family")


def actions(program,features,cache):
    values=evaluate(program,features,cache)
    return [1 if v>SIGNAL_FLOOR else -1 if v < -SIGNAL_FLOOR else 0 for v in values]


def next_bar_returns(bars):
    """Decision made at candle i close; fill at i+1 OPEN, exit i+1 CLOSE."""
    return [bars[i+1].cl/bars[i+1].op-1.0 for i in range(len(bars)-1)]+[0.0]


def score(actions, outcomes, start, stop, *, shift=0):
    end=min(stop-1,len(actions)-1)
    if start<0 or stop>len(actions) or stop-start<3:
        raise ValueError("Invalid chronological evaluation range")
    sample=range(start,end)
    n=end-start
    pnl=[]
    trades=0
    for i in sample:
        decision=actions[i]
        if decision:
            # A null rotates the OUTCOME within evaluation region only.
            # Original real returns stay chronologically paired when shift=0.
            j=start+((i-start+shift)%n)
            pnl.append(ALLOC*(decision*outcomes[j]-ROUND_TRIP_COST))
            trades+=1
        else:
            pnl.append(0.0)
    wealth=1.0
    peak=1.0
    maxdd=0.0
    for r in pnl:
        wealth*=1+r
        peak=max(peak,wealth)
        maxdd=max(maxdd,1-wealth/peak)
    return {"trades":trades,"observations":n,
            "mean_pnl_per_bar":sum(pnl)/n,
            "compounded_return":wealth-1,
            "max_drawdown":maxdd}


def novelty_summary(all_actions,start,stop):
    """Behavioral diversity is in-run, NOT literature novelty."""
    if not all_actions:
        return {"unique_behaviors":0,"unique_structures":0}
    behavior={hashlib.sha256(bytes(x+1 for x in acts[start:stop])).hexdigest()
              for acts in all_actions.values()}
    return {"unique_behaviors":len(behavior),
            "unique_structures":len(all_actions)}


def empirical_max_null(shortlist, outcomes, start, stop, observed, rng, shifts=NULL_SHIFTS):
    """Selection-adjusted negative control among shortlisted programs."""
    if not shortlist:
        return {"p":1.0,"null_maxima":[]}
    n=stop-start-1
    if n < 100:
        return {"p":1.0,"null_maxima":[]}
    null_maxima=[]
    used=set()
    for _ in range(shifts):
        offset=rng.randint(max(32,n//10),n-max(32,n//10))
        if offset in used:
            continue
        used.add(offset)
        best=max(score(actions,outcomes,start,stop,shift=offset)["mean_pnl_per_bar"]
                 for actions in shortlist)
        null_maxima.append(best)
    p=(1+sum(x>=observed for x in null_maxima))/(1+len(null_maxima))
    return {"p":p,"null_maxima":null_maxima,
            "null_method":"circular_return_alignment_shift_exploratory",
            "multiple_selection_adjustment":"max_among_family_shortlist_only",
            "scientific_significance_proven":False}


def discover(bars,seed=42,per_family=24,shifts=NULL_SHIFTS,model_proposals=None):
    if len(bars)<MIN_BARS or not 4<=per_family<=MAX_PER_FAMILY:
        raise ValueError("Need >=1200 bars; 4..48 programs per family")
    if not 9<=shifts<=99:
        raise ValueError("Null shifts must be 9..99")
    if model_proposals is not None:
        if not isinstance(model_proposals,list) or len(model_proposals)>16:
            raise ValueError('Invalid model proposal count')
        for ast in model_proposals:
            validate_ast(ast)
    rng=random.Random(seed)
    n=len(bars)
    train_end=int(n*0.6)
    validation_end=int(n*0.8)
    features=base_features(bars)
    outcomes=next_bar_returns(bars)
    cache={}
    program_catalog={}
    program_family={}
    action_catalog={}
    explorations=[]
    approved=[]
    for family in FAMILIES + (('model_proposals',) if model_proposals else ()):
        family_ids=[]
        attempts=0
        while len(family_ids)<per_family and attempts<per_family*35:
            attempts+=1
            if family=='model_proposals':
                if attempts>len(model_proposals):
                    break
                program=model_proposals[attempts-1]
            else:
                program=generate(family,rng)
            validate_ast(program)
            pid=identity(program)
            if pid in program_catalog:
                continue
            program_catalog[pid]=program
            program_family[pid]=family
            action_catalog[pid]=actions(program,features,cache)
            family_ids.append(pid)
        ranked=[]
        for pid in family_ids:
            train=score(action_catalog[pid],outcomes,16,train_end)
            if train["trades"]>=20 and train["mean_pnl_per_bar"]>0:
                ranked.append((train["mean_pnl_per_bar"],pid))
        ranked.sort(reverse=True)
        shortlist=ranked[:8]
        attempted=[]
        for _,pid in shortlist:
            result=score(action_catalog[pid],outcomes,train_end,validation_end)
            if result["trades"]>=8:
                attempted.append((result["mean_pnl_per_bar"],pid,result))
        attempted.sort(key=lambda x:x[0],reverse=True)
        best=attempted[0] if attempted else None
        null={"p":1.0,"null_maxima":[]}
        family_status="FALSIFIED_PIVOT_NEXT_FAMILY"
        if best is not None and best[0]>0:
            family_shortlist=[action_catalog[pid] for _,pid,result in attempted]
            null=empirical_max_null(family_shortlist,outcomes,train_end,
                                    validation_end,best[0],rng,shifts)
            if null["p"]<=0.10 and best[2]["max_drawdown"]<=0.03:
                approved.append({
                    "family":family,"program_id":best[1],
                    "program":program_catalog[best[1]],
                    "train":score(action_catalog[best[1]],outcomes,16,train_end),
                    "validation":best[2],
                    "null_p":null["p"],
                })
                family_status="PROVISIONAL_RESEARCH_CANDIDATE"
        reason=('no_training_positive_after_cost' if not ranked else
                'insufficient_validation_trades' if not attempted else
                'validation_negative_after_cost' if best[0]<=0 else
                'null_shift_comparison_unconvincing' if null['p']>0.10 else
                'validation_drawdown_limit' if best[2]['max_drawdown']>0.03 else
                'provisional_only')
        explorations.append({
            "family":family,
            "diagnosis":reason,
            "attempts":attempts,
            "new_programs":len(family_ids),
            "training_positive":len(ranked),
            "validation_checked":len(attempted),
            "validation_best_score":best[0] if best else None,
            "family_status":family_status,
            "max_null_p":null["p"],
            "null_draws":len(null["null_maxima"]),
        })
        # Falsification triggers a switch to a DIFFERENT representation family.
        # Even an accepted candidate does not interrupt exploration of others.

    # Results above do not consult the holdout segment at all.
    # The calling audit wrapper must claim holdout only after training/validation.
    evidence={
        "protocol":"algorithm_discovery_lab_v0",
        "model_proposal_count":len(model_proposals or []),
        "search":"typed_program_synthesis_with_family_pivot",
        "offline_research_only":True,
        "can_submit_orders":False,
        "can_modify_trader":False,
        "scientific_novelty_verified":False,
        "model_proved_profitable":False,
        "seed":seed,
        "split":{"train":[0,train_end],"validation":[train_end,validation_end],
                 "holdout":[validation_end,n]},
        "cost_model":{"fee_plus_slippage_each_side":SIDE_COST,
                      "round_trip":ROUND_TRIP_COST,
                      "equity_fraction":ALLOC,
                      "funding_history_applied":False,
                      "liquidation_model":False},
        "family_experiments":explorations,
        "discovery_summary":novelty_summary(action_catalog,16,train_end),
        "hypotheses_evaluated":len(program_catalog),
        "hypothesis_catalog":[{
            "id":pid,"family":program_family[pid],"program":program,
            "train":score(action_catalog[pid],outcomes,16,train_end),
            "external_scientific_novelty_verified":False}
            for pid,program in program_catalog.items()],
        "provisional_candidates":approved,
        "status":"PROVISIONAL_REQUIRES_HOLDOUT"
                 if approved else "NO_VALIDATED_DISCOVERY",
        "next":"AUDIT_ONCE_ONLY" if approved else "PIVOT_NEW_REPRESENTATIONS_AND_NEW_DATA",
        "holdout":None,
    }
    return evidence,action_catalog,outcomes


def reveal_holdout_once(evidence,actions_catalog,outcomes):
    if evidence["holdout"] is not None:
        raise ValueError("Holdout already observed")
    if not evidence["provisional_candidates"]:
        return evidence
    start,stop=evidence["split"]["holdout"]
    # No new parameter tuning or program selection based on holdout results.
    evidence["holdout"]={
        p["program_id"]:score(actions_catalog[p["program_id"]],
                              outcomes,start,stop)
        for p in evidence["provisional_candidates"]
    }
    evidence["status"]="HOLDOUT_INSPECTED_RESEARCH_ONLY"
    evidence["next"]="INDEPENDENT_FORWARD_EVIDENCE_REQUIRED_NO_TRADING"
    return evidence


def run_audited(csv_path,registry_path,out_path,seed=42,per_family=24,
                shifts=NULL_SHIFTS,proposals_path=None):
    csv_path,out_path=Path(csv_path),Path(out_path)
    if out_path.exists() or out_path.resolve()==csv_path.resolve():
        raise FileExistsError("Create a NEW report file")
    # v5 provenance verification also validates every original official ZIP.
    from run_alpha_audited import verify_snapshot
    bars,manifest,digest=verify_snapshot(
        csv_path,csv_path.with_suffix(".manifest.json")
    )
    if manifest["source"] not in ("official_archive","public_get"):
        raise ValueError("Genuine research source required")
    # Validate untrusted model proposals BEFORE consuming a single-use claim.
    submitted=None
    if proposals_path is not None:
        from algorithm_proposals import read_proposals
        submitted=read_proposals(proposals_path)
    proposed=[p['program'] for p in submitted['proposals']] if submitted else None
    registry=Path(registry_path)
    registry.mkdir(parents=True,exist_ok=True)
    claim=registry/(digest+".algorithm-discovery.claim.json")
    # Exclusive claim BEFORE possible holdout access.
    with claim.open("x",encoding="utf-8") as f:
        json.dump({"protocol":"algorithm_discovery_lab_v0","dataset_sha256":digest,
                   "never_reuse_as_new_holdout":True},f,indent=2)
    report,catalog,outcomes=discover(bars,seed,per_family,shifts,proposed)
    report['model_proposals']=submitted
    report["dataset_sha256"]=digest
    report["dataset_source"]=manifest["source"]
    if report["provisional_candidates"]:
        reveal_holdout_once(report,catalog,outcomes)
    out_path.parent.mkdir(parents=True,exist_ok=True)
    with out_path.open("x",encoding="utf-8") as f:
        json.dump(report,f,indent=2,sort_keys=True)
        f.write("\n")
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv",required=True,type=Path)
    p.add_argument("--registry",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--seed",type=int,default=42)
    p.add_argument("--per-family",type=int,default=24)
    p.add_argument("--null-shifts",type=int,default=NULL_SHIFTS)
    p.add_argument("--proposals",type=Path,help='Model generated AST hypotheses JSON')
    a=p.parse_args()
    result=run_audited(a.csv,a.registry,a.out,a.seed,a.per_family,
                       a.null_shifts,a.proposals)
    print(json.dumps({"status":result["status"],
                      "programs":result["hypotheses_evaluated"],
                      "candidates":len(result["provisional_candidates"]),
                      "holdout_evaluated":result["holdout"] is not None,
                      "trading_enabled":False},sort_keys=True))


if __name__=="__main__":
    main()
