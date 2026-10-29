#!/usr/bin/env python3
"""Forward-only *research event labels* from two observed market snapshots.

A change in OI does not identify net long or short pressure (each contract
has both sides). No buy/sell/position output exists. Funding is a forecast
and does not model actual settlement cashflows. All source records are
revalidated by the two-round panel builder.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from algorithm_pit_pair_v5 import build_panel, MAX_ASOF_AGE_MS

SCHEMA = "algorithm_pit_observation_events_v5"

def event_at(observation, decision_ms):
    if type(decision_ms) is not int or decision_ms <= 0:
        raise ValueError("Expected positive millisecond as-of time")
    oi = observation["oi"]
    funding = observation["funding_forecast"]
    oi_time = oi["asof_available_not_before_ms"]
    funding_time = funding["asof_available_not_before_ms"]
    ready = max(oi_time, funding_time)
    if decision_ms < ready:
        return {"status": "ABSTAIN_UNRECEIVED", "event": None,
                "ready_not_before_ms": ready}
    if decision_ms - min(oi_time, funding_time) > MAX_ASOF_AGE_MS:
        return {"status": "ABSTAIN_STALE", "event": None,
                "ready_not_before_ms": ready}
    if funding["comparable"] is not True:
        return {"status": "ABSTAIN_FUNDING_PERIOD_SWITCH", "event": None,
                "ready_not_before_ms": ready}
    if oi["direction"] not in (-1, 0, 1) or funding["direction"] not in (-1, 0, 1):
        raise ValueError("Invalid event direction")
    if oi["direction"] == 0 or funding["direction"] == 0:
        return {"status": "ABSTAIN_NO_JOINT_CHANGE", "event": None,
                "ready_not_before_ms": ready}
    # The sign pair is a descriptive event alphabet. It is deliberately
    # not converted to trade direction or expected return.
    label = ("CO_MOVEMENT" if oi["direction"] == funding["direction"]
             else "OPPOSITION")
    return {
        "status": "OBSERVATION_ONLY", "event": label,
        "oi_sign": oi["direction"],
        "funding_forecast_change_sign": funding["direction"],
        "ready_not_before_ms": ready,
        "trading_action": None,
    }


def event_report(panel, decision_ms):
    if panel.get("schema") != "algorithm_pit_two_snapshot_panel_v5":
        raise ValueError("Only verified panel schema allowed")
    rows = []
    counts = {}
    for source in panel["markets"]:
        state = event_at(source, decision_ms)
        counts[state["status"] if state["event"] is None else state["event"]] = (
            counts.get(state["status"] if state["event"] is None else state["event"], 0) + 1
        )
        rows.append({"rank": source["rank"], "symbol": source["symbol"], **state})
    if len(rows) != 50 or len({r["symbol"] for r in rows}) != 50:
        raise ValueError("Incomplete frozen universe")
    return {
        "schema": SCHEMA,
        "decision_time_ms": decision_ms,
        "counts": counts,
        "observations": rows,
        "using_actual_complete_receipt_times": True,
        "future_returns_used": False,
        "this_is_not_a_trading_signal": True,
        "allow_paper": False,
        "allow_live_orders": False,
        "scientific_novelty_or_edge_proven": False,
    }


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--root", required=True, type=Path)
    cli.add_argument("--universe", required=True, type=Path)
    cli.add_argument("--out", required=True, type=Path)
    args = cli.parse_args()
    if args.out.exists():
        raise FileExistsError("Output must be new")
    paired = build_panel(args.root, args.universe)
    # At the latest response in this single manual round all rows have
    # already been observed. This is NOT a user-local current market quote.
    asof = paired["second_round_last_receipt_ms"]
    report = event_report(paired, asof)
    report["source_panel_sha256"] = hashlib.sha256(
        (json.dumps(paired, indent=2, sort_keys=True, allow_nan=False)+"\n").encode("utf8")
    ).hexdigest()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf8") as fh:
        json.dump(report, fh, indent=2, sort_keys=True, allow_nan=False)
        fh.write("\n")
    print(json.dumps({"count": len(report["observations"]),
                      "categories": report["counts"],
                      "allow_paper": False}))


if __name__ == "__main__":
    main()
