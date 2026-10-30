#!/usr/bin/env python3
"""v14 ChatGPT-authored hypothesis registration and source-only signal adapter.

AI writes STRICT DATA, not Python to execute. Explicit human manual invocation.
Nothing here accesses future market prices, evaluates PnL, modifies the frozen
v12 model seal or touches any exchange/account API. No daemon or API key.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import json
import time

from algorithm_multiday_registry_v12 import (
    canonical, sha256, strictly_decode, study_plan, read_entries, GENESIS
)
from algorithm_ws_buckets_v8 import build_buckets
from algorithm_manual_runner_v13 import foreground_lock, setup as runner_setup

SCHEMA="algorithm_ai_hypothesis_v14"
LEDGER="algorithm_ai_hypothesis_ledger_v14"
SIGNAL_SCHEMA="algorithm_ai_source_signal_v14"
ALLOWED_RULES={"flow_sign_flip_with_midprice_inertia_v1",
               "impact_per_contract_decay_v1"}
PROPOSAL_ID=re.compile(r"[a-z][a-z0-9_-]{7,47}\Z")
HEX64=re.compile(r"[a-f0-9]{64}\Z")
REQUIRED_BASELINES={"cash","flow_only","price_only"}
FIELDS={
    "taker_buy_contracts","taker_sell_contracts","fill_count",
    "book_update_count","best_bid","best_ask","book_end_asof_ms",
    "window_start_utc_ms","window_end_utc_ms"
}
FUTURE_LABEL="UNAVAILABLE_UNVERIFIED"
MAX_PROPOSALS=25


def now_ms():
    return time.time_ns()//1_000_000


def utc_day(ms):
    return datetime.fromtimestamp(ms/1000,timezone.utc).date().isoformat()


def strict_str(value, minlen=20, maxlen=800):
    if not isinstance(value,str) or not minlen<=len(value.strip())<=maxlen:
        raise ValueError("Required bounded nonblank text")
    # Everything in a proposal is DATA. Do not execute it, follow its
    # instructions, or permit embedding command lines/credential requests.
    if any(marker in value.lower() for marker in (
            "api_key", "api secret", "private key", "send order",
            "place order", "subprocess", "os.system", "exec(", "eval(")):
        raise ValueError("Disallowed executable or private trading instruction")
    return value.strip()


def check_proposal(p, *, allow_extra=False):
    expected={
        "schema","id","title","author","created_utc_ms",
        "problem","mechanism","scientific_novelty_status",
        "rule_id","signal_definition","eligibility","refutation",
        "failure_modes","prior_hypotheses_comparison",
        "source_observables","predeclared_baselines",
        "forward_horizon_ms","future_outcome_source_status",
        "economic_execution_assumptions","phase",
        "can_trade","can_start_paper","returns_observed"
    }
    if not isinstance(p,dict) or set(p)!=expected:
        raise ValueError("Proposal fields differ from fixed schema")
    if p["schema"]!=SCHEMA or not isinstance(p["id"],str) or not PROPOSAL_ID.fullmatch(p["id"]):
        raise ValueError("Invalid proposal identity")
    if p["author"]!="ChatGPT, reviewed via user-invoked research session":
        raise ValueError("Source must identify AI role and explicit manual boundary")
    if type(p["created_utc_ms"]) is not int or p["created_utc_ms"]<=0:
        raise ValueError("Invalid creation clock")
    if (p["rule_id"] not in ALLOWED_RULES
        or p["scientific_novelty_status"]!="NOT_VERIFIED"
        or p["future_outcome_source_status"]!=FUTURE_LABEL
        or p["phase"]!="PROPOSED_SOURCE_ONLY"
        or p["can_trade"] is not False
        or p["can_start_paper"] is not False
        or p["returns_observed"] is not False):
        raise ValueError("Unsupported rule or misleading validated/trading claim")
    for field in (
        "title","problem","mechanism","signal_definition","eligibility",
        "refutation","failure_modes","prior_hypotheses_comparison",
        "economic_execution_assumptions"
    ):
        strict_str(p[field],8 if field=="title" else 35)
    if (not isinstance(p["source_observables"],list)
        or not 3<=len(p["source_observables"])<=len(FIELDS)
        or len(set(p["source_observables"]))!=len(p["source_observables"])
        or not set(p["source_observables"]).issubset(FIELDS)):
        raise ValueError("Unsupported or unspecified accessible source measurements")
    if (not isinstance(p["predeclared_baselines"],list)
        or len(set(p["predeclared_baselines"]))!=len(p["predeclared_baselines"])
        or not REQUIRED_BASELINES.issubset(set(p["predeclared_baselines"]))
        or not set(p["predeclared_baselines"]).issubset(
            {"cash","flow_only","price_only","opposite_on_same_events"})):
        raise ValueError("Missing honest null and price/flow control models")
    if type(p["forward_horizon_ms"]) is not int or p["forward_horizon_ms"] not in (60_000,300_000,900_000):
        raise ValueError("Unregistered/unsafe horizon")
    # Return identity exact bytes; no arbitrary code is dynamically evaluated.
    return p


def paths(study):
    root=Path(study)/"ai-research-v14"
    return root,root/"proposals",root/"ledger",root/"source-signals"


def setup(study):
    _,plan_sha=study_plan(study)
    root,proposals,ledger,signals=paths(study)
    for folder in (root,proposals,ledger,signals):
        folder.mkdir(exist_ok=True)
    return plan_sha


def registered(study):
    plan_sha=setup(study)
    _,props,ledger,_=paths(study)
    files=sorted(ledger.glob("*.json"))
    prev=GENESIS
    seen=set()
    out=[]
    for i,f in enumerate(files,1):
        if f.name!=f"{i:06d}.json":
            raise ValueError("Hypothesis ledger numbering gap")
        record=strictly_decode(f.read_bytes())
        obj={k:record[k] for k in ("schema","sequence","previous_sha256",
                                  "plan_sha256","proposal_id",
                                  "proposal_sha256","registered_utc_ms")}
        digest=sha256(canonical(obj))
        if (record.get("schema")!=LEDGER or record.get("sequence")!=i
            or record.get("previous_sha256")!=prev
            or record.get("plan_sha256")!=plan_sha
            or record.get("entry_sha256")!=digest):
            raise ValueError("Broken AI-hypothesis hash ledger")
        ident=record["proposal_id"]
        if not isinstance(ident,str) or not PROPOSAL_ID.fullmatch(ident) or ident in seen:
            raise ValueError("Duplicate/invalid hypothesis ID")
        seen.add(ident)
        raw=(props/f"{ident}.json").read_bytes()
        if sha256(raw)!=record["proposal_sha256"]:
            raise ValueError("Stored original AI proposal has changed")
        proposal=check_proposal(strictly_decode(raw))
        if (proposal["id"]!=ident
            or proposal["created_utc_ms"]>record["registered_utc_ms"]):
            raise ValueError("AI proposal created after registration")
        prev=digest
        out.append((record,proposal))
    stray=sorted(f.name for f in props.glob("*.json")
                 if f.stem not in seen)
    if stray:
        raise ValueError("Unregistered proposal file present: "+str(stray[:3]))
    return out


def propose(study,proposal_file,*,now=None):
    now=now_ms() if now is None else now
    # Caller (ChatGPT in this chat) authoring text ≠ executing it.
    raw=Path(proposal_file).read_bytes()
    if len(raw)>20_000:
        raise ValueError("Oversized hypothesis")
    p=check_proposal(strictly_decode(raw))
    if p["created_utc_ms"]>now or now-p["created_utc_ms"]>7*86_400_000:
        raise ValueError("Proposal timestamp is invalid/stale")
    setup(study)
    runner_setup(study)
    with foreground_lock(study):
        prior=registered(study)
        if len(prior)>=MAX_PROPOSALS:
            raise ValueError("Research candidate budget exhausted; do not data-mine")
        if any(r["proposal_id"]==p["id"] or item["rule_id"]==p["rule_id"]
               for r,item in prior):
            raise FileExistsError("Duplicate ID/rule; must create a distinct testable mechanism")
        # Preserve exact original file bytes instead of silently reformatting.
        root,props,ledger,_=paths(study)
        target=props/f"{p['id']}.json"
        with target.open("xb") as stream:
            stream.write(raw)
        seq=len(prior)+1
        _,plan_sha=study_plan(study)
        head={
            "schema":LEDGER,"sequence":seq,
            "previous_sha256":prior[-1][0]["entry_sha256"] if prior else GENESIS,
            "plan_sha256":plan_sha,
            "proposal_id":p["id"],"proposal_sha256":sha256(raw),
            "registered_utc_ms":now
        }
        receipt={**head,"entry_sha256":sha256(canonical(head))}
        with (ledger/f"{seq:06d}.json").open("xb") as f:
            f.write(canonical(receipt)+b"\n")
        registered(study)
        return {"proposal_id":p["id"],"proposal_sha256":sha256(raw),
                "ledger_entry_sha256":receipt["entry_sha256"],
                "status":"PROPOSED_SOURCE_ONLY",
                "can_trade":False}


def dec(value):
    try:
        v=Decimal(str(value))
    except Exception as e:
        raise ValueError("Invalid numeric source") from e
    if not v.is_finite():
        raise ValueError("Nonfinite source")
    return v


def midpoint(row):
    if row["best_bid"] is None or row["best_ask"] is None:
        return None
    bid,ask=dec(row["best_bid"]),dec(row["best_ask"])
    if bid<=0 or ask<=bid:
        raise ValueError("Crossed source book")
    return (bid+ask)/2


def source_only_signal(source,proposal):
    """Interpret precisely one audited nonexecuting research rule on 8s data."""
    check_proposal(proposal)
    if proposal["rule_id"]=="impact_per_contract_decay_v1":
        # Exact imported allowlisted pure function; never eval AI-authored text.
        from algorithm_impact_decay_v15 import impact_decay_signal
        return impact_decay_signal(source,proposal)
    if proposal["rule_id"]!="flow_sign_flip_with_midprice_inertia_v1":
        raise ValueError("Rule not implemented")
    rows=source["one_second_bins"]
    if len(rows)!=8:
        raise ValueError("Unexpected number of observed one-second bins")
    selected=[]
    for i,row in enumerate(rows):
        if row["index"]!=i:
            raise ValueError("Reordered source bins")
    early,late=rows[:4],rows[4:]
    qualified_bins=sum(r["status"]=="OBSERVED_BOTH" for r in rows)
    early_fills=sum(r["fill_count"] for r in early)
    late_fills=sum(r["fill_count"] for r in late)
    fe=sum((dec(r["buy_taker_contracts"])-dec(r["sell_taker_contracts"]) for r in early),Decimal(0))
    fl=sum((dec(r["buy_taker_contracts"])-dec(r["sell_taker_contracts"]) for r in late),Decimal(0))
    m3=midpoint(rows[3]);m7=midpoint(rows[7])
    source_ok=(qualified_bins>=6 and early_fills>=5 and late_fills>=5
               and rows[3]["status"]=="OBSERVED_BOTH"
               and rows[7]["status"]=="OBSERVED_BOTH"
               and rows[7]["book_update_count"]>=1)
    direction=None
    reason="SOURCE_QUALITY_ABSTAIN"
    if source_ok:
        if fe==0 or fl==0 or fe*fl>=0:
            reason="NO_HALFTIME_FLOW_REVERSAL"
        elif m3 is None or m7 is None or (m7-m3)*fe<=0:
            reason="NO_PRICE_INERTIA_AFTER_FLOW_FLIP"
        else:
            direction=-1 if fe>0 else 1
            reason="SOURCE_ONLY_CANDIDATE_EVENT"
    return {
        "rule_id":proposal["rule_id"],
        "asof_capture_end_utc_ms":source["window_end_utc_ms"],
        "eligible":direction is not None,
        "hypothetical_direction":direction,
        "eligibility_result":reason,
        "source_qualified_bins":qualified_bins,
        "early_fill_count":early_fills,
        "late_fill_count":late_fills,
        "early_net_taker_contracts":str(fe),
        "late_net_taker_contracts":str(fl),
        "mid_second3":str(m3) if m3 is not None else None,
        "mid_second7":str(m7) if m7 is not None else None,
        "future_quote_labels_accessed":False,
        "future_profitability":None,
        "can_trade":False,
    }


def signal(study,ident,day,symbol,*,now=None):
    now=now_ms() if now is None else now
    setup(study)
    with foreground_lock(study):
        proposals={p["id"]:(receipt,p) for receipt,p in registered(study)}
        if ident not in proposals:
            raise ValueError("Candidate was not registered first")
        receipt,p=proposals[ident]
        plan,_=study_plan(study)
        b=next((x for x in plan["calendar"] if x["date_utc"]==day),None)
        if b is None or b["split"]!="development" or symbol not in b["symbols"]:
            raise ValueError("Only preregistered development-day symbol")
        evidence=next((e["observation"] for e in read_entries(study,plan,recheck_source=True)
                       if e["observation"]["date_utc"]==day
                       and e["observation"]["symbol"]==symbol),None)
        if evidence is None or evidence["status"]!="SOURCE_VERIFIED_NO_OUTCOME":
            raise ValueError("No registered and re-audited source")
        if receipt["registered_utc_ms"]>=evidence["capture_start_utc_ms"]:
            raise ValueError("Hypothesis was written after source capture began")
        if now<evidence["capture_end_utc_ms"]:
            raise ValueError("Source still in the future")
        source=build_buckets(evidence["capture_path"])
        if (source["symbol"]!=symbol
            or source["source_manifest_sha256"]!=evidence["source_manifest_sha256"]
            or source["source_messages_sha256"]!=evidence["source_messages_sha256"]):
            raise ValueError("Source proof mismatch")
        extracted=source_only_signal(source,p)
        _,_,_,signals=paths(study)
        entry={
            "schema":SIGNAL_SCHEMA,
            "proposal_id":ident,"proposal_sha256":receipt["proposal_sha256"],
            "study_plan_sha256":receipt["plan_sha256"],
            "symbol":symbol,"date_utc":day,
            "source_manifest_sha256":source["source_manifest_sha256"],
            "source_messages_sha256":source["source_messages_sha256"],
            "registered_at_utc_ms":now,
            "source_only_result":extracted,
            "future_outcome_source_status":FUTURE_LABEL,
            "realized_pnl":None,
            "can_trade":False,"can_start_paper":False
        }
        target=signals/f"{day}-{symbol}-{ident}.json"
        with target.open("xb") as stream:
            stream.write(canonical(entry)+b"\n")
        return {"signal_sha256":sha256(target.read_bytes()),
                "symbol":symbol,"date_utc":day,
                "eligibility_result":extracted["eligibility_result"],
                "hypothetical_direction":extracted["hypothetical_direction"],
                "can_trade":False}


def overview(study):
    plan,plan_sha=study_plan(study)
    allproposals=registered(study)
    _,_,_,signals=paths(study)
    frozen=[]
    for p in sorted(signals.glob("*.json")):
        x=strictly_decode(p.read_bytes())
        if (x.get("schema")!=SIGNAL_SCHEMA or x.get("can_trade") is not False
            or x.get("can_start_paper") is not False
            or x.get("realized_pnl") is not None
            or x.get("study_plan_sha256")!=plan_sha):
            raise ValueError("Invalid altered source-only signal")
        frozen.append(x)
    return {
        "schema":"algorithm_ai_research_status_v14",
        "proposals_registered":len(allproposals),
        "proposal_ids":[p["id"] for _,p in allproposals],
        "source_only_signals_frozen":len(frozen),
        "future_quote_labels_verified":0,
        "validated_profitability_models":0,
        "self_running_background_agent":False,
        "on_demand_chatgpt_hypothesis_authoring":True,
        "model_sealed_for_validation":(Path(study)/"model-seal.json").exists(),
        "can_trade":False,"can_start_paper":False,
        "status":"AI_PROPOSALS_REGISTERED_OUTCOMES_NOT_AVAILABLE",
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",required=True,type=Path)
    s=p.add_subparsers(dest="action",required=True)
    s1=s.add_parser("propose");s1.add_argument("--proposal",required=True,type=Path)
    s2=s.add_parser("signal")
    s2.add_argument("--id",required=True)
    s2.add_argument("--date",required=True)
    s2.add_argument("--symbol",required=True)
    s.add_parser("status")
    args=p.parse_args()
    result=(propose(args.study,args.proposal) if args.action=="propose" else
            signal(args.study,args.id,args.date,args.symbol) if args.action=="signal"
            else overview(args.study))
    print(json.dumps(result,ensure_ascii=False,sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
