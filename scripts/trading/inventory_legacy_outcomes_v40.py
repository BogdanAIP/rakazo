"""Index selected legacy outcome reports without confusing market rows with trials."""
import argparse
import hashlib
import json
from pathlib import Path

REPORTS = {
 6:"pit-captures/forward-v6-20261029-outcome.json",
 7:"pit-captures/micro-v7-forward-outcome-20261030.json",
 9:"pit-captures/ws-v9-queue-recovery-20261030-outcome.json",
 10:"pit-captures/ws-v10-depletion-20261030-outcome-v2.json",
 11:"pit-captures/ws-v11-20261030-incomplete-validation.json",
 24:"official-l2-v24/NEAR-2026-09-03_04-postresult-robustness-v24.json",
 27:"crossmarket-v27/NEAR_BTC_ETH_2026-09-03_04-crossmarket-v27.json",
 28:"controls-v28/NEAR-2026-09-03_04-66anchors-controls-v28.json",
 29:"onset-v29/NEAR-2026-09-03_04-934min-onset-v29.json",
 30:"onset-v30/v30-locked-final-summary.json",
}

def inventory(root):
    records=[]
    for version,name in REPORTS.items():
        raw=(root/name).read_bytes()
        obj=json.loads(raw)
        records.append({
            "version":version,"report_file":name,
            "report_sha256":hashlib.sha256(raw).hexdigest(),
            "report_schema":obj.get("schema"),
            "top_level_keys":sorted(obj),
            "array_shapes_NOT_trial_counts":{
                k:{"length":len(v),"item_keys":sorted(v[0]) if v and isinstance(v[0],dict) else None}
                for k,v in obj.items() if isinstance(v,list)},
            "declared_candidate_ids":obj.get("candidate_hypotheses"),
            "declared_horizons":obj.get("all_fixed_horizons_seconds"),
            "frozen_definition_sha":obj.get("freeze_sha256",obj.get("frozen_hypothesis_sha256")),
            "embedded_signal_definition":obj.get("signal_definition"),
            "summary_field_names":sorted(obj.get("summary",{})),
            "control_field_names":sorted(obj.get("primary_and_controls",{})),
            "full_identity_reconciled":False,
        })
    return {
        "schema":"legacy_outcome_source_index_v1","mode":"READ_ONLY_ARCHIVED_REPORT_INDEX",
        "records":records,"final_prior_trials":None,"freeze_usable":False,
        "policy":"Count selectable configurations including ablations; do not count event/market rows as trials. Distinguish diagnostics, nonselectable nulls and source-only stages.",
        "next":"Reconcile frozen definitions, horizons, gates and selectable controls per version; merge with early and late inventories using all six agreed identity components. Publish coverage-complete conservative upper bound before freeze.",
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
