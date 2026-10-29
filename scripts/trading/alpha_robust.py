#!/usr/bin/env python3
"""V3 cost-robust chronological market research.

RESEARCH ONLY. No exchange keys, private endpoints, scheduling or orders.
The 'funding buffer' is a pessimistic hypothetical fee per trade, NOT actual
settled funding history. The simulator still lacks liquidation and orderbook.
"""
from __future__ import annotations

import math
import random
from dataclasses import asdict
from alpha_discovery import Rule, statistics, trade
from alpha_walkforward import (
    BASELINE, EMBARGO_BARS, TEST_BARS, TRAIN_BARS,
    choose_from_past, collect_returns, fitness, gate,
)

MIN_BARS_V3 = 8640  # 90 calendar days
DEVELOPMENT_SHARE = 0.8
MIN_DEV_FOLDS = 12
MIN_STRESS_TRADES = 40
NORMAL_BPS_SIDE = 7  # 5 taker + 2 adverse price impact
STRESS_BPS_SIDE = 15  # 5 taker + 10 adverse price impact
STRESS_FUNDING_BPS_TRADE = 2  # hypothetical pessimistic per-trade debit


def stress_adjust(raw_returns, per_side_bps, funding_bps_per_trade):
    if not 0 <= per_side_bps <= 100 or not 0 <= funding_bps_per_trade <= 50:
        raise ValueError("Research cost assumptions out of bounds")
    # Base trade() has already charged 7bp per side.
    deduction = (2 * (per_side_bps - NORMAL_BPS_SIDE) +
                 funding_bps_per_trade) / 10_000
    return [r - deduction for r in raw_returns]


def test_fold(candles, start, stop, *, seed=42, rounds=2):
    if start < TRAIN_BARS + EMBARGO_BARS:
        raise ValueError("Training history unavailable")
    # Train on past only; never optimize against stress scenario in the future.
    winner, selection = choose_from_past(
        candles, start - EMBARGO_BARS - TRAIN_BARS,
        start - EMBARGO_BARS, seed=seed, rounds=rounds
    )
    raw = collect_returns(candles, winner, start, stop)
    ref = collect_returns(candles, BASELINE, start, stop)
    stressed = stress_adjust(raw, STRESS_BPS_SIDE, STRESS_FUNDING_BPS_TRADE)
    stressed_reference = stress_adjust(
        ref, STRESS_BPS_SIDE, STRESS_FUNDING_BPS_TRADE
    )
    return {
        "train": [start - EMBARGO_BARS - TRAIN_BARS, start - EMBARGO_BARS],
        "embargo": [start - EMBARGO_BARS, start],
        "evaluate": [start, stop],
        "candidate": asdict(winner) if winner is not None else None,
        "selection": selection,
        "normal": statistics(raw),
        "normal_baseline": statistics(ref),
        "stress": statistics(stressed),
        "stress_baseline": statistics(stressed_reference),
        "no_trade": winner is None,
    }, raw, ref, stressed, stressed_reference


def v3_gate(folds, normal, normal_ref, stress, stress_ref):
    base = gate([{"strategy_result": f["normal"]} for f in folds],
                normal, normal_ref)
    stressed, benchmark = statistics(stress), statistics(stress_ref)
    positive_stress_folds = sum(f["stress"]["return"] > 0 for f in folds)
    differences = [
        f["stress"]["return"] - f["stress_baseline"]["return"]
        for f in folds
    ]
    beats_stressed_baseline_folds = sum(d > 0 for d in differences)
    passed = (
        base["passed"] and len(folds) >= MIN_DEV_FOLDS
        and stressed["trades"] >= MIN_STRESS_TRADES
        and stressed["return"] > 0 and
        stressed["return"] > benchmark["return"] and
        stressed["drawdown"] <= 0.03 and
        positive_stress_folds * 3 >= len(folds) * 2 and
        beats_stressed_baseline_folds * 2 >= len(folds)
    )
    return {
        "status": "RESEARCH_ONLY_ROBUST_GATE" if passed else "NO_VALIDATED_EDGE",
        "passed": passed,
        "normal_gate": base,
        "stress_strategy": stressed,
        "stress_baseline": benchmark,
        "stress_profitable_folds": positive_stress_folds,
        "stress_outperformed_folds": beats_stressed_baseline_folds,
        "folds": len(folds),
        "conditions": {
            "min_folds": MIN_DEV_FOLDS,
            "min_stress_trades": MIN_STRESS_TRADES,
            "positive_stress_fold_share": "at_least_2_of_3",
            "beats_baseline_fold_share": "at_least_half",
            "positive_excess_stress_net_return": True,
            "max_drawdown_fraction": 0.03,
        },
        "model_selection_bias_corrected": False,
        "statistical_significance_proven": False,
    }


def robust_walk_forward(candles, seed=42, rounds=2):
    n = len(candles)
    if n < MIN_BARS_V3:
        raise ValueError("V3 needs at least 90 days of real 15-minute history")
    if not 1 <= rounds <= 4:
        raise ValueError("Rounds must be 1..4")
    boundary = int(n * DEVELOPMENT_SHARE)
    development, normals, refs, stresses, stress_refs = [], [], [], [], []
    start, k = TRAIN_BARS + EMBARGO_BARS, 0
    while start + TEST_BARS <= boundary:
        frame, raw, ref, sraw, sref = test_fold(
            candles, start, start + TEST_BARS,
            seed=seed + k, rounds=rounds
        )
        frame["fold"] = k + 1
        development.append(frame)
        normals.extend(raw)
        refs.extend(ref)
        stresses.extend(sraw)
        stress_refs.extend(sref)
        start += TEST_BARS
        k += 1

    admit = v3_gate(development, normals, refs, stresses, stress_refs)
    final = None
    if admit["passed"]:
        # Test holdout only after completely frozen development gate.
        holdout_folds, h_norm, h_ref, h_stress, h_stress_ref = [], [], [], [], []
        start = boundary
        k = 0
        while start < n:
            stop = min(n, start + TEST_BARS)
            if stop - start < 48:
                break
            frame, raw, ref, sraw, sref = test_fold(
                candles, start, stop, seed=seed + 10_000 + k, rounds=rounds
            )
            frame["fold"] = k + 1
            holdout_folds.append(frame)
            h_norm.extend(raw)
            h_ref.extend(ref)
            h_stress.extend(sraw)
            h_stress_ref.extend(sref)
            start = stop
            k += 1
        final = {
            "folds": holdout_folds,
            "normal": statistics(h_norm),
            "normal_baseline": statistics(h_ref),
            "stress": statistics(h_stress),
            "stress_baseline": statistics(h_stress_ref),
            "note": "Reserved one-time chronological forward research; not an independent real PAPER trial",
        }

    return {
        "protocol": "alpha_discovery_v3_robust",
        "mode": "OFFLINE_RESEARCH_ONLY",
        "can_submit_orders": False,
        "minimum_closed_bars": MIN_BARS_V3,
        "bars": n,
        "development_range": [0, boundary],
        "holdout_range": [boundary, n],
        "policy": {
            "train_closed_bars": TRAIN_BARS,
            "embargo_bars": EMBARGO_BARS,
            "test_closed_bars": TEST_BARS,
            "search_rounds": rounds,
            "seed": seed,
            "baseline": asdict(BASELINE),
            "cost_normal_bps_per_side": NORMAL_BPS_SIDE,
            "cost_stress_bps_per_side": STRESS_BPS_SIDE,
            "funding_stress_bps_each_trade": STRESS_FUNDING_BPS_TRADE,
            "actual_historical_funding_verified": False,
            "derivative_contract_rules_verified": False,
            "liquidation_simulated": False,
            "multiple_testing_corrected": False,
        },
        "development_folds": development,
        "development_gate": admit,
        "holdout": final,
        "next": (
            "RESEARCH_PASSED_STILL_NOT_PAPER_APPROVED"
            if admit["passed"] else
            "RESEARCH_FAILED_NO_TRADE_RESAMPLE_NEW_UNSEEN_DATA"
        ),
    }
