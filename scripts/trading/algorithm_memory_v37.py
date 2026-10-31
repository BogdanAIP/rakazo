#!/usr/bin/env python3
"""Reviewed delayed-label primitive. Empirical stability is NOT a confidence bound."""
from collections import defaultdict
from datetime import datetime, timezone
import heapq
import json
import math
from pathlib import Path
from statistics import mean

import algorithm_band_v36 as band

MINIMUM_DAYS=20
MATURITY_MS=17*60000
DELETE_BEST_DAYS=2
IDS={"liquidity-payoff-memory","no-incremental-memory","price-payoff-memory",
     "rank-liquidity","rank-flow","cash"}


def sign(x):return (x>0)-(x<0)


def day(t):return datetime.fromtimestamp(t/1000,timezone.utc).date().isoformat()


def load_definitions(path):
    raw=Path(path).read_bytes()
    if len(raw)>65536:raise ValueError("Bounded hypothesis file exceeded")
    def unique(items):
        out={}
        for k,v in items:
            if k in out:raise ValueError("Duplicate hypothesis key")
            out[k]=v
        return out
    doc=json.loads(raw,object_pairs_hook=unique)
    if (set(doc)!={"schema","settings","programs"} or doc["schema"]!="matured_payoff_v37"
            or doc["settings"]!={"minimum_days":20,"maturity_minutes":17,"delete_best_days":2}):
        raise ValueError("Frozen operator settings changed")
    defs=doc["programs"]
    if any(type(v) is not int for v in doc["settings"].values()):
        raise ValueError("Integer operator settings required")
    if len(defs)!=6 or {d["id"] for d in defs}!=IDS:raise ValueError("Fixed six-program budget changed")
    seen=set()
    for d in defs:
        if set(d)!={"id","role","hypothesis","operator","score","baseline","cell","require_incremental"}:
            raise ValueError("Unexpected typed program fields")
        if d["role"] not in ("candidate","ablation","baseline") or type(d["require_incremental"]) is not bool:
            raise ValueError("Invalid typed program role/policy")
        if d["operator"] not in ("matured-economic-memory","past-rank","cash") or d["cell"] not in ("capacity","volatility","none"):
            raise ValueError("Unsupported reviewed primitive")
        if not isinstance(d["hypothesis"],str) or len(d["hypothesis"])<30:raise ValueError("Missing rationale")
        for node in (d["score"],d["baseline"]):
            # Scope this grammar extension; do not mutate older interpreters' catalog.
            original=band.lab.FEATURES
            try:
                band.lab.FEATURES=original|band.replay.EXTRA_FEATURES|band.EXTRA_FEATURES|{"price_capacity"}
                band.lab.validate(node)
            finally:band.lab.FEATURES=original
            def no_state(n):
                if n in (["previous"],["current"]):raise ValueError("Implicit state reference forbidden")
                for c in n[1:]:
                    if isinstance(c,list):no_state(c)
            no_state(node)
        semantic=band.lab.digest([d[k] for k in ("operator","score","baseline","cell","require_incremental")])
        if semantic in seen:raise ValueError("Duplicate program semantics")
        seen.add(semantic)
    return defs,band.replay.digest(path)


def score(definition,features):
    return band.lab.expression(definition["score"],features,0,0)


def cell(definition,features,direction):
    if definition["cell"]=="capacity":
        ratio=features["buy_capacity" if direction>0 else "sell_capacity"]
    elif definition["cell"]=="volatility":ratio=features["price_capacity"]
    else:ratio=0
    return (direction,int(ratio>=.5))


def stable_envelope(values):
    """Remove the two most favorable day means; empirical sensitivity, not CI."""
    if len(values)<MINIMUM_DAYS:return None
    return mean(sorted(values)[:-DELETE_BEST_DAYS])


class MaturedMemory:
    def __init__(self,require_incremental=True):
        self.require_incremental=require_incremental
        self.pending=[]
        self.history=defaultdict(lambda:defaultdict(list))
        self.resolved=0
        self.missing=0
        self.clock=None

    def schedule(self,t,key,direction,baseline_direction):
        if direction not in (-1,1) or baseline_direction not in (-1,0,1):
            raise ValueError("Invalid proposed direction")
        if self.clock!=t:raise ValueError("Advance observation clock before scheduling")
        heapq.heappush(self.pending,(t+MATURITY_MS,t,key,direction,baseline_direction))

    def advance(self,now,resolver):
        if self.clock is not None and now<self.clock:raise ValueError("Clock moved backwards")
        self.clock=now
        while self.pending and self.pending[0][0]<=now:
            due,t,key,direction,baseline=heapq.heappop(self.pending)
            # Resolver cannot run before maturity and receives no future feature row.
            label=resolver(t,direction,baseline,now)
            if label is None:
                self.missing+=1
                continue
            net,delta=label
            if not all(math.isfinite(x) for x in label):raise ValueError("Nonfinite resolved label")
            self.history[day(t)][key].append((net,delta))
            self.resolved+=1

    def decision(self,now,key,direction):
        if self.clock!=now:raise ValueError("Decision requires the current observed clock")
        values=[mean(x[0] for x in rows[key]) for date,rows in sorted(self.history.items())
                if date<day(now) and key in rows]
        increments=[mean(x[1] for x in rows[key]) for date,rows in sorted(self.history.items())
                    if date<day(now) and key in rows]
        if len(values)<MINIMUM_DAYS:return 0,"COLD_START"
        if stable_envelope(values)<=0:return 0,"NO_ABSOLUTE_STABILITY"
        if self.require_incremental and stable_envelope(increments)<=0:
            return 0,"NO_INCREMENTAL_STABILITY"
        return direction,"ADMIT"

    def fingerprint(self):
        history=[[d,[list(k),v] ] for d,rows in sorted(self.history.items()) for k,v in sorted(rows.items())]
        return band.lab.digest({"history":history,"pending":sorted(self.pending),
                                "resolved":self.resolved,"missing":self.missing,"clock":self.clock})
