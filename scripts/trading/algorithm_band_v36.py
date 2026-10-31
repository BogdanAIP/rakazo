#!/usr/bin/env python3
"""Fixed-price-band liquidity accounting: DEVELOPMENT, never execution.

The visible-execution intervals are conditional accounting proxies. Original
historical feeds lack certified continuity and trader receipt clocks. JSON
hypotheses remain data interpreted by reviewed bounded AST primitives.
"""
from __future__ import annotations

import argparse
import bisect
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal as D
import json
from pathlib import Path
import subprocess
import sys

import algorithm_path_v35 as prior
import algorithm_restoration_v32 as replay
import algorithm_stream_v31 as lab
from algorithm_rank_v33 import rank_actions

EXTRA_FEATURES = {"band_flow","bid_lower","bid_upper","ask_lower","ask_upper",
                  "buy_capacity","sell_capacity","band_imbalance","event_ofi"}
IDS = {"interval-accounting","all-visible-point","depth-delta-only","band-capacity-state",
       "canonical-ofi","flow-baseline","depth-baseline","return-baseline"}
PATH_RESULT_SHA = "c2fd98fc7d153b27faa5c77510f8b56d396509bb4810b3ffd6fee8bf361366f8"
COST_REFERENCE_BP = D(20)
LEVELS = 400
MAX_TRADE_AGE_MS = 5000


def geometry(book):
    """Copy only current best 400 displayed levels, never expose mutable state."""
    return {s:tuple((p,book[s][p]) for p in sorted(book[s],reverse=s=="bids")[:LEVELS])
            for s in ("bids","asks")}


def interval(old, new):
    """Anchor the band to OLD midpoint and OLD spread; keep absolute prices."""
    bid,ask = old["bids"][0][0],old["asks"][0][0]
    mid = (bid+ask)/2
    width = COST_REFERENCE_BP+D(10000)*(ask/bid).ln()
    lower,upper = mid*(-width/D(10000)).exp(),mid*(width/D(10000)).exp()
    out = {"lower":str(lower),"upper":str(upper),"anchor_mid":str(mid),
           "half_width_bp":str(width)}
    for name,g in (("old",old),("new",new)):
        b,a = g["bids"],g["asks"]
        if not (lower <= b[0][0] < a[0][0] <= upper):
            return {**out,"status":"PRICE_BAND_CROSSED"}
        if b[-1][0] > lower or a[-1][0] < upper:
            return {**out,"status":"DEPTH_TRUNCATED"}
        for side,levels in (("bid",b),("ask",a)):
            qty = sum((q for p,q in levels if lower <= p <= upper),D(0))
            if not qty.is_finite() or qty <= 0:
                raise ValueError("Invalid covered displayed band quantity")
            out[name+"_"+side] = str(qty)
    return {**out,"status":"AVAILABLE"}


class BandHook:
    def __init__(self):
        self.previous = None
        self.intervals = {}

    def observe(self,t,book,heaps,quote):
        current = geometry(book) if quote.get("status") == "AVAILABLE" else None
        if current is None:
            out = {"status":"QUOTE_UNAVAILABLE"}
        elif self.previous is None or self.previous[0] != t-60000 or self.previous[1] is None:
            out = {"status":"PREVIOUS_GEOMETRY_UNAVAILABLE"}
        else:
            out = interval(self.previous[1],current)
        self.intervals[t] = out
        self.previous = (t,current)


def trade_sum(trades,stamps,t,lower,upper):
    start = t-60000
    left,right = bisect.bisect_left(stamps,start),bisect.bisect_left(stamps,t)
    # Strictly prior observations only; no post-T print gates a signal.
    if (not stamps or left == 0 or right == 0
            or start-stamps[left-1] > MAX_TRADE_AGE_MS
            or t-stamps[right-1] > MAX_TRADE_AGE_MS):
        return {"status":"TRADE_SPAN_UNAVAILABLE"}
    buy,sell,count = D(0),D(0),0
    for ms,side,qty,price in trades[left:right]:
        if lower <= price <= upper:
            if side == "buy":buy += qty
            elif side == "sell":sell += qty
            else:raise ValueError("Invalid source trade direction")
            count += 1
    return {"status":"AVAILABLE","buy":str(buy),"sell":str(sell),"prints":count}


def accounting(record,executions):
    b0,a0,b1,a1 = (D(record[k]) for k in ("old_bid","old_ask","new_bid","new_ask"))
    buy,sell = D(executions["buy"]),D(executions["sell"])
    if min(b0,a0,b1,a1) <= 0 or min(buy,sell) < 0:
        raise ValueError("Invalid contract quantities")
    db,da = b1-b0,a1-a0
    soft = lambda x,q:float(x/(q+abs(x)))
    return {"bid_lower":soft(db,b0),"bid_upper":soft(db+sell,b0),
            "ask_lower":soft(da,a0),"ask_upper":soft(da+buy,a0),
            "band_flow":float((buy-sell)/(buy+sell)) if buy+sell else 0.0,
            "buy_capacity":float(buy/(a1+buy)),"sell_capacity":float(sell/(b1+sell)),
            "band_imbalance":float((b1-a1)/(b1+a1))}


def verify_path(folder):
    if json.loads((folder/"run-status.json").read_bytes())["status"] != "COMPLETE":
        raise ValueError("Prior path run incomplete")
    p = folder/"first-development-v35.json"
    if replay.digest(p) != PATH_RESULT_SHA:
        raise ValueError("Prior development result identity changed")
    return json.loads(p.read_bytes())


def extract(source,path_root,day,symbol):
    v34,v35 = prior.verify_prior(source),verify_path(path_root)
    c34 = next(c for c in v34["cases"] if (c["day"],c["symbol"]) == (day,symbol))
    c35 = next(c for c in v35["cases"] if (c["day"],c["symbol"]) == (day,symbol))
    name = f"{symbol}-{day}-restoration-v32.json"
    old_file,path_file = source/"features"/name,path_root/"features"/name
    if (replay.digest(old_file) != c34["restoration_cache_sha"]
            or replay.digest(path_file) != c35["restoration_cache_sha"]):
        raise ValueError("Previously observed source cache changed")
    old,paths = json.loads(old_file.read_bytes()),json.loads(path_file.read_bytes())
    hook = BandHook()
    book = replay.extract(source,day,symbol,source_manifest=prior.pilot.manifest,
        index_name=f"{symbol}-{day}-snapshot-index-v34.json",quote_hook=hook)
    if ({str(t):q for t,q in book["quotes"].items()} != old["quotes"]
            or {str(t):b for t,b in book["bins"].items()} != old["bins"]
            or book["source_rows"] != old["source_rows"]):
        raise ValueError("Instrumented replay changed inherited observations")
    trades,sha = lab.source.load_trades(source/"source",day,symbol,
                                      locator=prior.pilot.registered,include_price=True)
    if sha != c34["source_sha"]["tape"]:
        raise ValueError("Executed tape identity changed")
    stamps = [x[0] for x in trades]
    for t,record in hook.intervals.items():
        if record["status"] == "AVAILABLE":
            executions = trade_sum(trades,stamps,t,D(record["lower"]),D(record["upper"]))
            record["executions"] = executions
            if executions["status"] == "AVAILABLE":
                record["features"] = accounting(record,executions)
            else:
                record["status"] = executions["status"]
        p = paths["bins"].get(str(t),{}).get("path")
        record["event_ofi"] = prior.normalized(p)["event_ofi"] if p is not None else None
    book.update(schema="fixed_absolute_band_v36_development",band_intervals=hook.intervals,
                prior_cache_sha=replay.digest(old_file),prior_path_cache_sha=replay.digest(path_file),
                trade_price_source_sha=sha,legacy_observations_reconciled=True,
                conditional_accounting_identity_certified=False)
    return book


def attach(rows,book):
    rows,quotes = replay.attach(rows,book)
    intervals = {int(t):x for t,x in book["band_intervals"].items()}
    for row in rows:
        record = intervals.get(row["t"],{"status":"GEOMETRY_UNAVAILABLE"})
        status = record["status"] if row["restoration_available"] else "RESET_OR_QUOTE_UNAVAILABLE"
        if status == "AVAILABLE" and record.get("event_ofi") is None:
            status = "CANONICAL_COMPARATOR_UNAVAILABLE"
        row["band_availability"] = status
        available = status == "AVAILABLE"
        row["restoration_available"] = available
        row["ready"] = row["ready"] and available
        f = {**record["features"],"event_ofi":record["event_ofi"]} if available else {
            key:0.0 for key in EXTRA_FEATURES}
        row["features"].update(f)
    return rows,quotes


def screen(programs):
    c = programs["interval-accounting"]
    if c["alarms"] < 4:return "INSUFFICIENT_ALARMS"
    if c["quote_path_unavailable"]:return "UNAVAILABLE_QUOTE_PATH"
    if c["mean_quote_20bp"] is None or c["mean_quote_20bp"] <= 0:
        return "NONPOSITIVE_QUOTED_MEAN"
    others = [v for k,v in programs.items() if k != "interval-accounting"]
    if any(v["alarms"] < 4 or v["quote_path_unavailable"] for v in others):
        return "CONTROL_UNPOWERED"
    if any(v["mean_quote_20bp"] is None or c["mean_quote_20bp"] <= v["mean_quote_20bp"] for v in others):
        return "NO_INCREMENTAL_MEAN"
    return "PASS"


def evaluate(source,path_root,cache,proposals):
    v34,v35 = prior.verify_prior(source),verify_path(path_root)
    lab.FEATURES.update(replay.EXTRA_FEATURES|EXTRA_FEATURES)
    definitions,sha = lab.proposals(proposals)
    if {p["id"] for p in definitions} != IDS:
        raise ValueError("Fixed typed search budget changed")
    coverage = {}
    for c34,c35 in zip(v34["cases"],v35["cases"]):
        day,symbol = c34["day"],c34["symbol"]
        p = cache/f"{symbol}-{day}-restoration-v32.json"
        b = json.loads(p.read_bytes())
        if (b.get("schema") != "fixed_absolute_band_v36_development"
                or b.get("prior_cache_sha") != c34["restoration_cache_sha"]
                or b.get("prior_path_cache_sha") != c35["restoration_cache_sha"]
                or b.get("legacy_observations_reconciled") is not True):
            raise ValueError("Invalid new geometry lineage")
        # Coverage uses only timestamp scope and source availability, never outcomes.
        synthetic_rows = [{"t":t,"ready":True,"features":{"flow":0.0}}
                          for t in lab.source.cohort(day)]
        tagged,_ = attach(synthetic_rows,b)
        coverage[(day,symbol)] = dict(Counter(r["band_availability"] for r in tagged))
    result = replay.evaluate(source,cache,definitions,sha,action_function=rank_actions,
        cohort=prior.pilot.CASES,locator=prior.pilot.registered,feature_attacher=attach)
    result.update(schema="fixed_band_v36_development",programs=definitions,
                  prior_v34_result_sha=replay.digest(source/"first-independent-v34.json"),
                  prior_v35_result_sha=PATH_RESULT_SHA,independent_validation=False,
                  source_data_previously_examined=True,effective_algorithm_confirmed=False,
                  scientific_novelty_established=False,accounting_identity_certified=False)
    for c in result["cases"]:
        c["availability_counts"] = coverage[(c["day"],c["symbol"])]
        c["candidate_screen"] = screen(c["programs"])
        for program in c["programs"].values():
            for alarm in program["records"]:
                alarm["scheduled_context_120min"] = [e for e in prior.pilot.NEWS
                    if 0 <= alarm["t"]-int(datetime.fromisoformat(e["scheduled_utc"]).timestamp()*1000)
                    <= 120*60000]
                alarm["actual_news_coverage"] = "UNKNOWN"
    result["candidate_development_pass"] = all(c["candidate_screen"] == "PASS" for c in result["cases"])
    result["unrestricted_prior_controls"] = {k:v35["summary"][k]
        for k in ("canonical-ofi","flow-baseline","depth-baseline","return-baseline")}
    result["comparison_scope"] = "All new rules share source/geometry coverage; prior unrestricted controls retained separately, not paired causal effects."
    result["news_coverage"] = "UNKNOWN"
    return result


def run_all(source,path_root,output,expected_head):
    workspace = Path(__file__).resolve().parents[2]
    head = subprocess.run(["git","rev-parse","HEAD"],cwd=workspace,capture_output=True,
                          text=True,check=True).stdout.strip()
    status = subprocess.run(["git","status","--porcelain"],cwd=workspace,capture_output=True,
                            text=True,check=True).stdout.strip()
    if head != expected_head or status:raise ValueError("Require frozen clean development head")
    for p in (source,path_root):
        if output.resolve() == p.resolve() or p.resolve() in output.resolve().parents:
            raise ValueError("Do not write into prior experiment roots")
    prior.verify_prior(source);verify_path(path_root)
    output.mkdir(parents=True,exist_ok=True)
    journal_path = output/"run-status.json"
    journal = {"schema":"v36_finite_stage_journal","frozen_head":head,"status":"RUNNING",
               "completed":[],"started_utc":datetime.now(timezone.utc).isoformat()}
    with journal_path.open("x",encoding="utf-8") as f:json.dump(journal,f,sort_keys=True)
    cache = output/"features"
    stages = [(f"extract-{s}-{d}",["--day",d,"--symbol",s],
               cache/f"{s}-{d}-restoration-v32.json",300) for d,s in prior.pilot.CASES]
    stages.append(("evaluate",["--cache",str(cache),"--proposals",
        str(workspace/"docs/trading/ALGORITHM-BAND-PROPOSALS-v36.json")],
        output/"first-development-v36.json",180))
    for label,extras,out,timeout in stages:
        journal.update(stage=label,updated_utc=datetime.now(timezone.utc).isoformat())
        journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
        print(json.dumps({"stage":label,"status":"STARTING"}),flush=True)
        try:
            subprocess.run([sys.executable,str(Path(__file__).resolve()),"--source",str(source),
                "--prior-path",str(path_root),"--out",str(out)]+extras,
                cwd=workspace,check=True,timeout=timeout)
        except (subprocess.SubprocessError,OSError) as error:
            journal.update(status="INCOMPLETE_EXECUTION",error_type=type(error).__name__)
            journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
            raise
        journal["completed"].append({"stage":label,"sha":replay.digest(out)})
        journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
    journal.update(status="COMPLETE",updated_utc=datetime.now(timezone.utc).isoformat())
    journal_path.write_text(json.dumps(journal,sort_keys=True),encoding="utf-8")
    return {"status":"COMPLETE","frozen_head":head,
            "result_sha":replay.digest(output/"first-development-v36.json")}


def main():
    p = argparse.ArgumentParser()
    for arg in ("source","prior-path","out"):
        p.add_argument("--"+arg,type=Path,required=True)
    p.add_argument("--day",choices=prior.pilot.DAYS)
    p.add_argument("--symbol",choices=prior.pilot.SYMBOLS)
    p.add_argument("--cache",type=Path)
    p.add_argument("--proposals",type=Path)
    p.add_argument("--run-dir",type=Path)
    p.add_argument("--expected-head")
    a = p.parse_args()
    if a.out.exists():raise FileExistsError("Preserve first development output")
    if a.run_dir:result=run_all(a.source,a.prior_path,a.run_dir,a.expected_head)
    elif a.day:result=extract(a.source,a.prior_path,a.day,a.symbol)
    else:result=evaluate(a.source,a.prior_path,a.cache,a.proposals)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    with a.out.open("x",encoding="utf-8") as f:json.dump(result,f,sort_keys=True,allow_nan=False)
    print(json.dumps({"sha":replay.digest(a.out),"summary":result.get("summary"),
                      "source_rows":result.get("source_rows"),
                      "candidate_pass":result.get("candidate_development_pass")}))


if __name__ == "__main__":main()
