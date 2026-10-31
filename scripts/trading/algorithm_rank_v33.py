#!/usr/bin/env python3
"""Development redesign: scale-free, past-only admission of fixed AST scores.

No model changes, threshold search, independent holdout, orders or network calls.
Addresses v32's nontriggering raw-score scales; does not reverse its result.
"""
from collections import deque
import argparse
import json
from pathlib import Path

import algorithm_restoration_v32 as book
import algorithm_stream_v31 as lab

WINDOW = 120
MINIMUM = 60
TAIL_RANK = .90


def rank_actions(definition, rows):
    history = deque(maxlen=WINDOW)
    state = 0.0
    result = []
    for row in rows:
        if not row.get("restoration_available"):
            state = 0.0
            result.append(0)
            continue
        old = state
        state = lab.expression(definition["state"], row["features"], old, 0)
        value = lab.expression(definition["output"], row["features"], old, state)
        a = abs(value)
        # Neither the current observation nor its future outcome enters calibration.
        p = ((.5 + sum(x < a for x in history) + .5*sum(x == a for x in history))
             / (len(history)+1)) if history else 0.0
        eligible = len(history) >= MINIMUM and a > 0 and p >= TAIL_RANK
        result.append((1 if value > 0 else -1) if eligible else 0)
        history.append(a)
    return result


def verify_caches(cache, result_file):
    original = json.loads(Path(result_file).read_bytes())
    if original.get("schema") != "restoration_v32_development" or len(original["cases"]) != 4:
        raise ValueError("Missing original v32 result identity")
    expected = set(lab.ORIGINALS)
    if {(x["day"],x["symbol"]) for x in original["cases"]} != expected:
        raise ValueError("Restoration cohort changed")
    for case in original["cases"]:
        p = Path(cache)/f"{case['symbol']}-{case['day']}-restoration-v32.json"
        if book.digest(p) != case["restoration_cache_sha"]:
            raise ValueError("Previously extracted original cache changed")


def main():
    parser = argparse.ArgumentParser()
    for name in ("root", "cache", "prior-result", "proposals", "out"):
        parser.add_argument("--"+name, required=True, type=Path)
    args = parser.parse_args()
    if args.out.exists():
        raise FileExistsError("Preserve first v33 output")
    verify_caches(args.cache, args.prior_result)
    lab.FEATURES.update(book.EXTRA_FEATURES)
    definitions, sha = lab.proposals(args.proposals)
    result = book.evaluate(args.root, args.cache, definitions, sha, action_function=rank_actions)
    result["schema"] = "rank_admission_v33_development"
    result["prior_result_sha"] = book.digest(args.prior_result)
    result["admission"] = {"window": WINDOW, "minimum": MINIMUM, "tail_rank": TAIL_RANK,
                           "current_sample_in_calibration": False,
                           "raw_v32_thresholds_used": False,
                           "rank_hyperparameters_searched": False}
    with args.out.open("x", encoding="utf-8") as f:
        json.dump(result, f, sort_keys=True, allow_nan=False)
    print(json.dumps({"summary": result["summary"], "output_sha": book.digest(args.out)}))


if __name__ == "__main__":
    main()
