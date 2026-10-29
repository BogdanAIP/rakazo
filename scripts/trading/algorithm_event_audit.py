#!/usr/bin/env python3
"""Reproducible finite witnesses and synthetic loss counterexamples; no markets."""
from datetime import datetime, timedelta, timezone
from itertools import product
import argparse
import json
from pathlib import Path
import math

from alpha_discovery import Candle
from algorithm_discovery_lab import base_features
from algorithm_operator_lab import causal_operator, direction, load_operators
from algorithm_event_lab import (
    compact_score, distinguishing_witness, eventize, fingerprint, interpret, load,
)


def price_probe(log_returns_percent):
    """16 flat warmup bars, then realizable contiguous OHLCV observations."""
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    rows, price = [], 100.0
    for i, r in enumerate([0.0]*16 + list(log_returns_percent)):
        close = price * math.exp(r/100)
        rows.append(Candle(start+timedelta(minutes=15*i), price,
                           max(price,close)*1.0001, min(price,close)/1.0001,
                           close, 100.0))
        price = close
    return rows


def legacy_witness(candidate, legacy, max_depth=4):
    """Bounded search on a small, realizable OHLCV alphabet, not all prices."""
    attempts = 0
    for depth in range(1, max_depth+1):
        for word in product((-.4, -.1, 0.0, .1, .4), repeat=depth):
            attempts += 1
            table = base_features(price_probe(word))
            events = eventize(candidate, table)
            actual = interpret(candidate, events)[0][16:]
            old = direction(causal_operator(legacy, table)[0])[16:]
            if actual != old:
                return {"status":"DISTINGUISHED_ON_REALIZABLE_PRICE_PROBE",
                        "log_return_percent":list(word), "events":events[16:],
                        "candidate_actions":actual, "legacy_actions":old,
                        "sequences_checked":attempts}
    return {"status":"INCONCLUSIVE_NO_WITNESS_IN_BOUNDED_PROBES",
            "sequences_checked":attempts}


def audit(definitions, legacy):
    pairs = [{"left":a["id"],"right":b["id"],**distinguishing_witness(a,b)}
             for i,a in enumerate(definitions) for b in definitions[i+1:]]
    prior = [{"candidate":d["id"],"legacy":old["id"],**legacy_witness(d,old)}
             for d in definitions if d["role"] == "candidate" for old in legacy]
    attacks = {"escrow-confirmation":[.5,.1,-1.0,0.0],
               "countershock-release":[.5,-.1,-.1,.8,0.0]}
    losses = []
    for d in definitions:
        if d["id"] not in attacks:
            continue
        word = attacks[d["id"]]
        sample = price_probe(word)
        events = eventize(d,base_features(sample))
        actions,trace = interpret(d,events)
        losses.append({"candidate":d["id"],"log_returns_percent":word,
                       "actions":actions[16:],"trace":trace,
                       "result":compact_score(sample,actions,.0007),
                       "claim_falsified":"Sparse confirmed entries cannot lose: FALSE",
                       "market_predictive_edge_tested":False})
    return {"schema":"algorithm_event_semantic_audit_v2",
            "proposal_sha256":fingerprint(definitions), "abstract_transducer_pairs":pairs,
            "legacy_realizable_price_witnesses":prior,"synthetic_loss_counterexamples":losses,
            "bounds":{"abstract_event_alphabet":36,"abstract_pair_budget":30000,
                      "legacy_return_alphabet_percent":[-.4,-.1,0,.1,.4],"legacy_max_depth":4},
            "scientific_novelty_proven":False,"predictive_edge_proven":False,
            "real_market_data_used":False,"can_submit_orders":False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--operators",type=Path,required=True)
    p.add_argument("--legacy",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    if a.out.exists():
        raise FileExistsError("Use a new audit output")
    result=audit(load(a.operators),load_operators(a.legacy)["operators"])
    a.out.parent.mkdir(parents=True,exist_ok=True)
    with a.out.open("x",encoding="utf-8") as f:
        json.dump(result,f,indent=2,sort_keys=True,allow_nan=False)
        f.write("\n")
    print(json.dumps({"abstract_pairs":len(result["abstract_transducer_pairs"]),
                      "legacy_pairs":len(result["legacy_realizable_price_witnesses"]),
                      "loss_counterexamples":len(result["synthetic_loss_counterexamples"]),
                      "real_market_data_used":False}))


if __name__=="__main__":
    main()
