#!/usr/bin/env python3
"""Descriptive same-count episode nulls for archived funding filters (NO p-values).

Within each development partition, sample the same number of v3 price-entry
episodes from the funding-availability-matched baseline. Preserve each chosen
episode's actual direction and full holding duration; only the *selection*
criterion changes. These after-the-fact nulls are NONCAUSAL DIAGNOSTICS and
do not establish independent significance or live performance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics

from algorithm_funding_v4 import (
    CANDIDATES, EMBARGO_BARS, gate_decisions, verified_funding,
)
from algorithm_intrinsic_lab import decisions as price_decisions
from algorithm_event_lab import replay
from run_alpha_audited import verify_snapshot

TRIALS = 256
COSTS = {"base": .0007, "double": .0014}


def episodes(actions):
    """Return [start,end,sign] in decision indices, end-exclusive."""
    result = []
    first = None
    prev = 0
    for i, signal in enumerate(actions):
        if signal not in (-1, 0, 1) or type(signal) is not int:
            raise ValueError("Nonfinite or invalid target")
        if signal != prev:
            if prev:
                result.append((first, i, prev))
            first = i if signal else None
        prev = signal
    if prev:
        result.append((first, len(actions), prev))
    # No next bar to execute a last-bar entry.
    return [x for x in result if x[0] < len(actions)-1]


def net_episode(bars, episode, side_cost):
    """Exact additive fixed-notional net PnL (no exposure overlaps)."""
    first, end, side = episode
    if not 0 <= first < end <= len(bars) or side not in (-1, 1):
        raise ValueError("Invalid episode")
    entry = bars[first+1].op
    exitprice = bars[end+1].op if end+1 < len(bars) else bars[-1].cl
    if not all(math.isfinite(x) and x > 0 for x in (entry, exitprice)):
        raise ValueError("Invalid synthetic execution price")
    ratio = exitprice / entry
    return .1 * (side * (ratio - 1) - side_cost * (1 + ratio))


def diagnostic(bars, targets, events, gate, lag, *, seed):
    coverage, _ = gate_decisions(bars, targets, events, "price_coverage", lag)
    filtered, metrics = gate_decisions(bars, targets, events, gate, lag)
    available = episodes(coverage)
    chosen = episodes(filtered)
    universe = set(available)
    if any(ep not in universe for ep in chosen):
        raise AssertionError("Funding gate created a non-baseline episode")
    n = len(chosen)
    rng = random.Random(seed)
    comparisons = {}
    for label, side_cost in COSTS.items():
        weights = [net_episode(bars, ep, side_cost) for ep in available]
        exact = replay(bars, filtered, side_cost=side_cost, allocation=.1)["net_return"]
        chosen_sum = sum(net_episode(bars, ep, side_cost) for ep in chosen)
        if abs(exact - chosen_sum) > 1e-10:
            raise AssertionError("Episode accounting differs from replay")
        sample_returns = []
        for _ in range(TRIALS):
            indices = rng.sample(range(len(available)), n)
            sample_returns.append(sum(weights[j] for j in indices))
        sample_returns.sort()
        comparisons[label] = {
            "candidate_net_return": exact,
            "same_count_null_median": statistics.median(sample_returns),
            "same_count_null_min": sample_returns[0],
            "same_count_null_max": sample_returns[-1],
            "same_count_null_q05": sample_returns[int(.05*(TRIALS-1))],
            "same_count_null_q95": sample_returns[int(.95*(TRIALS-1))],
            "fraction_null_ge_candidate_descriptive_only":
                sum(v >= exact - 1e-12 for v in sample_returns) / TRIALS,
        }
    return {"availability_eligible_episodes": len(available),
            "accepted_executable_episodes": n, "attempts": metrics,
            "null_trials": TRIALS, "not_a_p_value": True,
            "comparisons": comparisons}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv", nargs="+", type=Path, required=True)
    p.add_argument("--funding", nargs="+", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    if args.out.exists():
        raise FileExistsError("A new research report path is required")
    if len(args.csv) != len(args.funding) or not 1 <= len(args.csv) <= 5:
        raise ValueError("Supply matched CSV and funding paths")
    seen = set()
    markets = []
    for path, funding_path in zip(args.csv, args.funding):
        bars, manifest, data_sha = verify_snapshot(path, path.with_suffix(".manifest.json"))
        symbol = manifest["symbol"]
        if symbol in seen:
            raise ValueError("Duplicate instrument")
        seen.add(symbol)
        settled, funding_sha = verified_funding(funding_path, symbol)
        n = len(bars)
        rows = []
        for segment, start, stop in (
            ("train", 0, int(n*.6)),
            ("exposed_development", int(n*.6), int(n*.8))
        ):
            sample = bars[start:stop]
            for model in CANDIDATES:
                targets, _, _ = price_decisions(sample, model)
                for lag in EMBARGO_BARS:
                    for gate in ("carry_receive", "funding_deceleration"):
                        ident = f"{symbol}:{segment}:{model}:{lag}:{gate}:v4"
                        seed = int.from_bytes(hashlib.sha256(ident.encode()).digest()[:8], "big")
                        rows.append({
                            "segment": segment, "model": model, "embargo_bars": lag,
                            "gate": gate, **diagnostic(sample, targets, settled, gate, lag, seed=seed)})
        markets.append({"symbol": symbol, "bars": n, "dataset_sha256": data_sha,
                        "funding_sha256": funding_sha,
                        "reserved_range": [int(n*.8),n], "rows": rows})
    report = {
        "schema": "algorithm_funding_count_matched_null_v4",
        "markets": markets, "trials_per_comparison": TRIALS,
        "null_condition": "UNIFORM_EPISODE_SUBSET_MATCHED_COUNT_DURATION_AND_DIRECTION_AS_ORIGINALLY_OBSERVED",
        "null_uses_future_selection": True,
        "independent_test": False, "actual_publication_latency_known": False,
        "funding_cashflow_included": False, "inferential_significance": False,
        "holdout_used": False, "can_submit_orders": False, "can_start_paper": False,
        "decision": "EXPLORATORY_ABSTAIN"
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf8") as file:
        json.dump(report, file, sort_keys=True, indent=2, allow_nan=False)
        file.write("\n")
    print(json.dumps({"markets":len(markets), "trials":TRIALS,
                      "significance_claim":False,"holdout_used":False}))


if __name__ == "__main__":
    main()
