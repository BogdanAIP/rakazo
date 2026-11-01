"""Inventory early archived report identities; never a completed prior-trial count."""
import argparse
import hashlib
import json
from pathlib import Path

FILES = [
    "algorithm-operator-v1-btc-dev-20261029.json",
    "algorithm-operator-v1-btc-critique-20261029.json",
    "algorithm-event-v2-development-20261029.json",
    "algorithm-event-v2-sol-doge-development-20261029.json",
    "algorithm-intrinsic-v3-development-20261029.json",
    "algorithm-funding-v4-development-20261029.json",
    "algorithm-funding-v4-matched-null-20261029.json",
]

def inventory(root):
    sources = []
    identities = {}
    for name in FILES:
        raw=(root/name).read_bytes()
        obj=json.loads(raw)
        rows=list(obj.get("operators",[]))
        for market in obj.get("markets",[]):
            rows.extend(market.get("results",market.get("rows",[])))
        hashed=set()
        descriptors=set()
        for row in rows:
            if not isinstance(row,dict):
                raise ValueError("Unexpected report row shape")
            sha=row.get("operator_sha256")
            if sha:
                if len(sha)!=64 or any(c not in "0123456789abcdef" for c in sha):
                    raise ValueError("Unexpected operator hash")
                identities.setdefault(sha,set()).add(row["id"])
                hashed.add(sha)
            if "id" in row:
                descriptors.add((row["id"],row.get("embargo_bars")))
        sources.append({
            "report_file":name,"report_sha256":hashlib.sha256(raw).hexdigest(),
            "hashed_operator_definitions":sorted(hashed),
            "unique_id_embargo_descriptors":[{"id":i,"embargo_bars":e}
                for i,e in sorted(descriptors,key=lambda x:(x[0],str(x[1])))],
            "descriptor_count":len(descriptors),
            "grammar_ids":sorted(obj.get("grammar",{})),
            "identity_limit":"id/embargo descriptors are not canonical executable-rule hashes; controls, nulls and changed protocols need source-lineage reconciliation",
        })
    return {"schema":"prior_trials_early_inventory_v1","mode":"READ_ONLY_ARCHIVED_REPORT_INVENTORY",
            "sources":sources,
            "hashed_operator_identity_count_v1_v2":len(identities),
            "hashed_operator_identities":[{"operator_sha256":s,"reported_ids":sorted(ids)}
                                           for s,ids in sorted(identities.items())],
            "final_prior_trials":None,"freeze_usable":False,
            "covered_versions":"partial v1-v4 reports only",
            "unresolved":["v0 and v5-v39 not yet inventoried",
                          "source-code/AST and protocol identity reconciliation across versions",
                          "candidate/ablation/control/null trial policy",
                          "distinguish selected rule attempts from robustness resamples"],
            "raw_market_data_accessed":False,"new_strategy_evaluations":0,
            "old_reports_modified":False}

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():raise FileExistsError(args.out)
    args.out.write_text(json.dumps(inventory(args.root),indent=2)+"\n")
