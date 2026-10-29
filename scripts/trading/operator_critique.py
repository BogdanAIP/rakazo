#!/usr/bin/env python3
"""Transform failed operator experiments into a falsifiable research brief.

Deterministic critique, not a model or scientific reviewer. It never changes
risk controls, edits datasets, reads the reserved holdout, or starts trading.
The next LLM must propose a new mathematical representation for human review.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

ALLOWED = {
    "insufficient_train_activity", "non_positive_training_after_cost",
    "insufficient_validation_activity", "non_positive_validation_after_cost",
    "failure_in_validation_subregime", "negative_null_control",
    "provisional_requires_independent_replication",
}
COST_EACH_SIDE = 0.0007
ALLOC = 0.1


def review(result):
    if result.get("protocol") != "algorithm_operator_research_v1":
        raise ValueError("Unsupported experiment protocol")
    if (result.get("holdout_used") is not False or
            result.get("can_submit_orders") is not False):
        raise ValueError("No critique of live-execution or inspected holdout")
    experiments = result.get("operators")
    if not isinstance(experiments, list) or not 1 <= len(experiments) <= 8:
        raise ValueError("Missing bounded experimental records")
    trace = []
    for item in experiments:
        if item.get("diagnosis") not in ALLOWED:
            raise ValueError("Invalid failure diagnosis")
        train = item["train"]
        trades, observations = train["trades"],train["observations"]
        if type(trades) is not int or type(observations) is not int or observations <= 0:
            raise ValueError("Invalid numeric research metrics")
        density = round(trades / observations, 6)
        # Approximate additive cost debit per bar; not future PnL.
        debit = density * 2 * COST_EACH_SIDE * ALLOC
        trace.append({
            "operator_id":item["id"],
            "parent_id":item["parent_id"],
            "diagnosis":item["diagnosis"],
            "train_trade_count":trades,
            "train_exposure_frequency":density,
            "modeled_cost_drag_per_bar":round(debit,10),
            "train_compounded_return":train["compounded_return"],
            "validation_compounded_return":item["validation"]["compounded_return"],
            "counterexample_description": (
                "High repeated decisions can exhaust expected edge under costs"
                if density > 0.15 else
                "Hypothesized state transition has no reliable observed edge"
            ),
            "proposed_representation_change": (
                "Explore event-triggered sparse decision policies, persistent "
                "no-trade state, or regime-dependent signal expiry; mathematical "
                "operator extension requires explicit safe-language review."
                if density > 0.15 else
                "Explore alternative causal state representations and stronger falsifying "
                "nulls; not only parameter retuning."
            ),
        })
    failures = [x for x in trace if x["diagnosis"] !=
                "provisional_requires_independent_replication"]
    return {
        "schema": "operator_research_critique_v1",
        "status": "PREPARE_NEW_UNTESTED_HYPOTHESIS" if failures else
                  "INDEPENDENT_REPLICATION_REQUIRED",
        "dataset_sha256": result.get("dataset_sha256"),
        "source_report_sha256": hashlib.sha256(
            json.dumps(result, sort_keys=True, separators=(",", ":"),
                       allow_nan=False).encode()).hexdigest(),
        "holdout_reexamined": False,
        "training_and_validation_previously_viewed": True,
        "cannot_claim_fresh_validation_by_reusing_same_dataset": True,
        "scientific_novelty_verified": False,
        "new_operator_semantics_allowed_only_after_review": True,
        "critic": "deterministic_failure_classification_not_llm",
        "trace": trace,
        "llm_research_assignment": (
            "Read the source hypothesis AST/state transitions and the failure trace. "
            "Generate a structurally distinct causal mathematical mechanism, not "
            "merely new stop-losses, moving-average windows or thresholds. Explain "
            "why its predictions might improve under fees, and propose a concrete "
            "adversarial counterexample that would falsify it. A new state transition "
            "must be reviewed and implemented in a bounded interpreter before any "
            "experiment. Do not use the inspected development dataset as fresh "
            "validation, never open the reserved holdout, never trade."
        ),
        "next_evidence_requirements": [
            "Provenance-stamped new unseen forward dataset and timestamped signals",
            "Review of mathematical novelty against prior work",
            "Separate evaluation of structural difference vs true predictive value",
            "Selection corrections across every inspected proposal",
            "More than one liquid crypto market and regime, with actual costs",
            "No PAPER or live execution until explicit review",
        ],
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--report", type=Path,required=True)
    p.add_argument("--out", type=Path,required=True)
    args=p.parse_args()
    if args.out.exists() or args.out.resolve()==args.report.resolve():
        raise FileExistsError("Critique output must be new and distinct")
    src=json.loads(args.report.read_text(encoding="utf-8"))
    result=review(src)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf-8") as f:
        json.dump(result,f,indent=2,sort_keys=True)
        f.write("\n")
    print(json.dumps({"status":result["status"],
                      "failed_hypotheses":len(result["trace"]),
                      "holdout_reexamined":False}))


if __name__=="__main__":
    main()
