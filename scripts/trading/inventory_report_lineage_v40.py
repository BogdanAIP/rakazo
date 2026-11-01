"""Read-only late-report lineage inventory, with no global trial-count claim."""
import argparse
import hashlib
import json
from pathlib import Path

REPORTS = [
 "stream-v31/first-development-v31.json",
 "restoration-v32/first-development-v32.json",
 "rank-v33/first-development-v33.json",
 "independent-v34/first-independent-v34.json",
 "path-v35/first-development-v35.json",
 "band-v36/first-development-v36.json",
 "memory-v37/first-causal-readiness-v37.json",
]

def inventory(root):
    records=[]
    for name in REPORTS:
        raw=(root/name).read_bytes()
        obj=json.loads(raw)
        summary=obj.get("summary",{})
        definitions=obj.get("programs",[])
        if not isinstance(summary,dict) or not isinstance(definitions,list):
            raise ValueError("Unexpected report schema")
        ids=[p["id"] for p in definitions]
        if len(ids)!=len(set(ids)):
            raise ValueError("Duplicate program id in a report")
        programs=[]
        for program in definitions:
            mechanism={k:v for k,v in program.items() if k not in
                       ("id","hypothesis","role","semantic_sha")}
            programs.append({
                "id":program["id"],"role":program.get("role"),
                "reported_semantic_sha":program.get("semantic_sha"),
                "reported_mechanism_sha256":hashlib.sha256(
                    json.dumps(mechanism,sort_keys=True,separators=(",",":")).encode()).hexdigest(),
                "hash_scope":"report output/state/threshold only; feature interpreter and admission protocol are separate",
            })
        records.append({
            "report_file":name,"report_sha256":hashlib.sha256(raw).hexdigest(),
            "proposal_sha":obj.get("proposal_sha",obj.get("proposals_sha")),
            "prior_result_sha":obj.get("prior_result_sha"),
            "evaluated_summary_ids":sorted(summary),
            "summary_id_count":len(summary),
            "embedded_definition_count":len(definitions),
            "summary_ids_without_embedded_definition":sorted(set(summary)-set(ids)),
            "embedded_programs":programs,
            "admission_protocol":obj.get("admission"),
            "unrestricted_prior_control_ids":sorted(obj.get("unrestricted_prior_controls",{})),
            "trading_efficacy_evaluated_explicit":obj.get("trading_efficacy_evaluated"),
            "new_historical_source_cohort":obj.get("new_historical_source_cohort"),
        })
    return {
        "schema":"prior_trial_late_report_lineage_v1",
        "mode":"READ_ONLY_ARCHIVED_REPORT_INVENTORY",
        "records":records,
        "final_prior_trials":None,"freeze_usable":False,
        "identity_warnings":[
            "same proposal with changed admission/calibration is not automatically one rule attempt",
            "reused original rule on new instruments/periods is not automatically a new distinct rule",
            "embedded mechanism hashes omit feature-interpreter semantics and cannot certify cross-version equivalence",
            "summary labels without embedded definitions need source/protocol reconciliation",
            "readiness/causality tests are not economic strategy evaluations",
            "unrestricted controls can reference prior reports; distinguish reuse from a new evaluation",
        ],
        "missing_versions":"v0,v5-v30,v38-v39 source/report reconciliation still pending; early v1-v4 inventory remains separate",
        "old_reports_modified":False,"raw_market_archives_accessed":False,
        "new_strategy_evaluations":0,
    }

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():raise FileExistsError(args.out)
    args.out.write_text(json.dumps(inventory(args.root),indent=2)+"\n")
