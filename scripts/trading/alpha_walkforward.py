#!/usr/bin/env python3
"""Alpha Discovery v2: chronological, bounded evolutionary walk-forward research.

No network, exchange, accounts, PAPER orders or schedules. The only outputs
are deterministic research reports. Market-specific realism is NOT guaranteed.
"""
from __future__ import annotations

import random
from dataclasses import asdict

from alpha_discovery import (
    Rule, evolve, fitness, initial_rules, replay, trade,
)

MIN_BARS = 2880  # 30 full days of 15m candles, not enough to establish edge
TRAIN_BARS = 960  # trailing 10 days
TEST_BARS = 192  # next 2 days
EMBARGO_BARS = 4  # no training outcome or signal from the immediate 1h gap
DEVELOPMENT_FRACTION = 0.80
MIN_TRAIN_TRADES = 16
MIN_OUT_OF_SAMPLE_TRADES = 25
MAX_SEARCH_ROUNDS = 4

# A fixed known-rule comparator, NOT the currently installed Rakazo Trader.
BASELINE = Rule("trend", 16, 0.003, 0.006, 0.009)


def collect_returns(candles, rule, start, end):
    if rule is None:
        return []
    # Every trade opens after its signal and closes before end.
    out = [trade(candles, rule, i)
           for i in range(max(start, rule.lookback), end - 1)]
    return [x for x in out if x is not None]


def summarized(returns):
    from alpha_discovery import statistics
    return statistics(returns)


def choose_from_past(candles, train_start, train_end, seed=42, rounds=2):
    """Create/mutate rules using ONLY [train_start, train_end) closed candles."""
    if not 1 <= rounds <= MAX_SEARCH_ROUNDS:
        raise ValueError("Invalid search-round bound")
    if train_end - train_start < TRAIN_BARS:
        raise ValueError("Insufficient training coverage")
    rng = random.Random(seed)
    considered, candidates = {}, initial_rules()
    for _ in range(rounds):
        for rule in candidates:
            if rule not in considered:
                considered[rule] = replay(candles, rule, train_start, train_end)
        leaders = sorted(
            considered,
            key=lambda r: (fitness(considered[r]), -r.lookback, str(r)),
            reverse=True
        )[:8]
        candidates = [r for r in evolve(leaders[:4], rng) if r not in considered]
        if not candidates:
            break
    qualified = [
        r for r, stats in considered.items()
        if stats["trades"] >= MIN_TRAIN_TRADES and
        stats["return"] > 0 and fitness(stats) > 0
    ]
    qualified.sort(key=lambda r: (fitness(considered[r]), -r.lookback, str(r)),
                   reverse=True)
    winner = qualified[0] if qualified else None
    return winner, {
        "trials": len(considered),
        "qualified": len(qualified),
        "train_trades": considered[winner]["trades"] if winner else 0,
        "train_score": fitness(considered[winner]) if winner else None,
    }


def fold(candles, start, stop, *, seed, rounds=2, train_bars=TRAIN_BARS,
         embargo_bars=EMBARGO_BARS):
    if stop > len(candles) or start < train_bars + embargo_bars:
        raise ValueError("Invalid fold boundaries")
    train_end = start - embargo_bars
    train_start = train_end - train_bars
    winner, trials = choose_from_past(candles, train_start, train_end,
                                      seed=seed, rounds=rounds)
    observed = collect_returns(candles, winner, start, stop)
    comparison = collect_returns(candles, BASELINE, start, stop)
    return {
        "train": [train_start, train_end],
        "embargo": [train_end, start],
        "evaluation": [start, stop],
        "strategy": asdict(winner) if winner else None,
        "selection": trials,
        "strategy_result": summarized(observed),
        "baseline_result": summarized(comparison),
        "no_trade_decision": winner is None,
    }, observed, comparison


def gate(development_folds, strategy_returns, baseline_returns):
    """Fixed research gate. No test-derived parameter optimization."""
    results = summarized(strategy_returns)
    baseline = summarized(baseline_returns)
    tested = len(development_folds)
    profitable = sum(f["strategy_result"]["return"] > 0
                     for f in development_folds)
    # Do NOT promote statistically unsupported, sparse, or worse-than-baseline.
    passed = (
        tested >= 4 and results["trades"] >= MIN_OUT_OF_SAMPLE_TRADES
        and results["return"] > 0 and results["return"] > baseline["return"]
        and results["drawdown"] <= 0.03
        and profitable * 2 >= tested  # at least half of the folds
    )
    return {
        "status": "RESEARCH_GATE_PASSED" if passed else "NO_VALIDATED_EDGE",
        "folds": tested,
        "profitable_folds": profitable,
        "strategy": results,
        "fixed_baseline": baseline,
        "criteria": {
            "min_folds": 4, "min_trades": MIN_OUT_OF_SAMPLE_TRADES,
            "max_drawdown_fraction": 0.03,
            "must_outperform_baseline": True, "min_profitable_fold_share": 0.5
        },
        "statistical_significance_established": False,
        "passed": passed,
    }


def walk_forward(candles, seed=42, rounds=2, train_bars=TRAIN_BARS,
                 test_bars=TEST_BARS, embargo_bars=EMBARGO_BARS):
    """Evaluate policy without ever training on data ahead of a scored fold."""
    if not MIN_BARS <= len(candles):
        raise ValueError("Require at least 2880 closed 15m bars for v2")
    if (train_bars < 192 or test_bars < 48 or embargo_bars < 1
            or train_bars + embargo_bars + 4 * test_bars >
            int(len(candles) * DEVELOPMENT_FRACTION)):
        raise ValueError("Not enough development data for four folds")
    if not 1 <= rounds <= MAX_SEARCH_ROUNDS:
        raise ValueError("Invalid search rounds")

    development_end = int(len(candles) * DEVELOPMENT_FRACTION)
    development = []
    development_returns, baseline_returns = [], []
    start = train_bars + embargo_bars
    k = 0
    while start + test_bars <= development_end:
        frame, own_returns, standard_returns = fold(
            candles, start, start + test_bars, seed=seed + k,
            rounds=rounds, train_bars=train_bars,
            embargo_bars=embargo_bars
        )
        frame["sequence"] = k + 1
        development.append(frame)
        development_returns.extend(own_returns)
        baseline_returns.extend(standard_returns)
        start += test_bars
        k += 1

    research_gate = gate(development, development_returns, baseline_returns)
    holdout = None

    # CRITICAL: no holdout testing or exposure when development gate fails.
    if research_gate["passed"]:
        holdout_folds = []
        real_returns, holdout_baseline = [], []
        start = development_end
        k = 0
        while start < len(candles):
            stop = min(start + test_bars, len(candles))
            # A full bar must be available for each reported outcome.
            if stop - start < 48:
                break
            frame, own_returns, standard_returns = fold(
                candles, start, stop, seed=seed + 10000 + k,
                rounds=rounds, train_bars=train_bars,
                embargo_bars=embargo_bars
            )
            frame["sequence"] = k + 1
            holdout_folds.append(frame)
            real_returns.extend(own_returns)
            holdout_baseline.extend(standard_returns)
            start = stop
            k += 1
        holdout = {
            "status": "ONE_TIME_RESEARCH_ONLY",
            "folds": holdout_folds,
            "strategy": summarized(real_returns),
            "baseline": summarized(holdout_baseline),
            "note": "No empirical confidence interval; no edge/PAPER authorization",
        }

    return {
        "protocol": "alpha_discovery_v2_walkforward",
        "mode": "OFFLINE_RESEARCH_ONLY",
        "can_submit_orders": False,
        "network_access": False,
        "bars": len(candles),
        "policy": {
            "train_bars": train_bars,
            "test_bars": test_bars,
            "embargo_bars": embargo_bars,
            "seed": seed,
            "mutation_rounds": rounds,
            "development_range": [0, development_end],
            "reserved_holdout_range": [development_end, len(candles)],
            "max_rule_lookback": 64,
            "baseline": asdict(BASELINE),
            "search_family": "bounded_trend_reversal_mutation",
            "fee_bps_per_side": 5,
            "slippage_bps_per_side": 2,
            "equity_allocation": 0.1,
            "futures_funding_model": False,
            "independent_holdout_reuse_allowed": False,
        },
        "development_folds": development,
        "research_gate": research_gate,
        "holdout": holdout,
        "decision": (
            "CONTINUE_GENERATING_ON_NEW_DATA_NO_TRADE"
            if not research_gate["passed"]
            else "HOLDOUT_OBSERVED_RESEARCH_ONLY_NO_PAPER_AUTHORIZATION"
        ),
    }


if __name__ == "__main__":
    raise SystemExit("Use run_alpha_audited.py --protocol v2 with the holdout registry")
