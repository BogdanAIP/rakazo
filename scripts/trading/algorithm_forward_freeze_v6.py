#!/usr/bin/env python3
"""Preregister a *hypothetical* 50-market forward research cohort.

Builds on exact raw verified v5 PIT captures. A freeze pins membership,
signal definitions, source hashes and FUTURE execution boundaries before
fetching any subsequent price outcomes. No account, orders, or scheduler.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import time

from algorithm_pit_events_v5 import event_report, load_verified_panel
from algorithm_pit_capture_v5 import strict_json

SCHEMA = "algorithm_forward_frozen_v6"
BAR = 900_000
GUARD = 300_000
PRIMARY_HORIZON = 60 * 60_000
DIAGNOSTIC_HORIZON = 15 * 60_000
SOURCE_MAX_AGE = 3_600_000
REQUIRED_MARKETS = 50
PRIMARY = "co_movement_funding_sign_v6"


def strict_next_boundary(t):
    if type(t) is not int or t < 0:
        raise ValueError("Invalid event time")
    return (t // BAR + 1) * BAR


def freeze(panel_path, events_path, root, universe, *, clock_ms):
    if type(clock_ms) is not int or clock_ms <= 0:
        raise ValueError("Invalid freeze UTC time")
    panel, panel_sha = load_verified_panel(panel_path, root, universe)
    raw = Path(events_path).read_bytes()
    saved = strict_json(raw)
    expected = event_report(panel, panel["second_round_last_receipt_ms"])
    for name in ("schema", "decision_time_ms", "counts", "observations"):
        if saved.get(name) != expected[name]:
            raise ValueError("Event labels mismatch the verified two-round panel")
    if (saved.get("source_panel_sha256") != panel_sha
            or saved.get("source_panel_verified_against_raw_captures") is not True
            or saved.get("allow_paper") is not False
            or saved.get("allow_live_orders") is not False):
        raise ValueError("Event source receipt or no-trade policy invalid")
    min_receipt = min(
        min(m["oi"]["second_received_ms"],
            m["funding_forecast"]["second_received_ms"])
        for m in panel["markets"]
    )
    max_receipt = panel["second_round_last_receipt_ms"]
    if clock_ms < max_receipt or clock_ms - min_receipt > SOURCE_MAX_AGE:
        raise ValueError("Freeze before capture or after feature expiry")
    entry = strict_next_boundary(max(clock_ms + GUARD, max_receipt))
    rows = []
    for event in saved["observations"]:
        actual = event["event"]
        side = None
        if actual == "CO_MOVEMENT":
            side = event["funding_forecast_change_sign"]
            if type(side) is not int or side not in (-1, 1):
                raise ValueError("Unknown funding change sign")
        rows.append({
            "rank": event["rank"],
            "symbol": event["symbol"],
            "source_label": actual or event["status"],
            "primary_direction_for_research_only": side,
            "primary_included": side is not None,
            "future_return_seen": False,
        })
    if len(rows) != REQUIRED_MARKETS or len({r["symbol"] for r in rows}) != REQUIRED_MARKETS:
        raise ValueError("Incomplete frozen cohort")
    return {
        "schema": SCHEMA, "protocol_document":
            "docs/trading/ALGORITHM-FORWARD-PROTOCOL-v6-20261029.md",
        "freeze_recorded_utc_ms": clock_ms,
        "five_minute_guard_ms": GUARD,
        "first_source_received_ms": min_receipt,
        "last_source_received_ms": max_receipt,
        "entry_candle_open_ms": entry,
        "primary_exit_candle_open_ms": entry + PRIMARY_HORIZON,
        "diagnostic_exit_candle_open_ms": entry + DIAGNOSTIC_HORIZON,
        "earliest_primary_outcome_collection_ms": entry + PRIMARY_HORIZON + BAR,
        "price_bar": "15m", "price_source": "OKX_PUBLIC_MARKET_CANDLES",
        "primary_hypothesis": PRIMARY,
        "execution_proxy": "next_eligible_open_to_plus_60m_open",
        "per_instrument_initial_equity_notional": 0.1,
        "side_cost_base": 0.0007, "side_cost_stress": 0.0014,
        "market_count": REQUIRED_MARKETS,
        "source_panel_sha256": panel_sha,
        "source_event_labels_sha256": hashlib.sha256(raw).hexdigest(),
        "source_universe_sha256": panel["frozen_universe_sha256"],
        "candidates": rows,
        "independent_validation": False,
        "minimum_qualifying_time_blocks_for_claim": 30,
        "minimum_independent_days_for_claim": 10,
        "minimum_total_qualifying_events_for_claim": 100,
        "minimum_unique_markets_for_claim": 20,
        "historical_membership_proven": False,
        "not_a_real_execution_backtest": True,
        "can_start_paper": False, "can_submit_orders": False,
    }


def save_freeze(path, result):
    path = Path(path)
    if path.exists():
        raise FileExistsError("No overwrite of preregistration")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf8") as stream:
        json.dump(result, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--panel", required=True, type=Path)
    p.add_argument("--events", required=True, type=Path)
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--universe", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    if args.out.exists():
        raise FileExistsError("Existing freeze must not be rewritten")
    result = freeze(args.panel, args.events, args.root, args.universe,
                    clock_ms=time.time_ns() // 1_000_000)
    digest = save_freeze(args.out, result)
    print(json.dumps({"freeze_sha256": digest,
        "primary_candidates": sum(x["primary_included"] for x in result["candidates"]),
        "entry_ms": result["entry_candle_open_ms"],
        "earliest_outcome_collection_ms": result["earliest_primary_outcome_collection_ms"],
        "outcome_scored": False, "can_submit_orders": False}))


if __name__ == "__main__":
    main()
