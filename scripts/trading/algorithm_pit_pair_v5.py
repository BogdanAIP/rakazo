#!/usr/bin/env python3
"""Integrity-checked two-snapshot OI and funding forecast research panel.

This is a point-in-time *acquisition* pair, not an OHLCV backtest.
The field becomes known no earlier than its own SECOND complete HTTP receipt.
Old/young/same-settlement forecasts are never silently joined across periods.
No network, scheduler, accounts, orders or trading entry points.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from algorithm_pit_audit_v5 import audit as first_batch_audit
from algorithm_pit_capture_v5 import verify_capture, finite_decimal

SCHEMA = "algorithm_pit_two_snapshot_panel_v5"
MIN_PAIR_MS = 15 * 60_000
MAX_PAIR_MS = 2 * 3_600_000
MAX_ASOF_AGE_MS = 3_600_000
KINDS = ("oi", "funding")


def find(manifest, kind, symbol):
    rows = [r for r in manifest["records"] if r["kind"] == kind and r["symbol"] == symbol]
    if len(rows) != 1:
        raise ValueError("Missing or repeated market observation")
    return rows[0]


def pair_field(previous, latest, symbol, kind, decision_ms):
    """Return None if information was not received by the requested instant."""
    if type(decision_ms) is not int or decision_ms < 0:
        raise ValueError("Invalid UTC decision timestamp")
    if kind not in KINDS:
        raise ValueError("Unrecognized source")
    a, b = find(previous, kind, symbol), find(latest, kind, symbol)
    t1, t2 = a["received_complete_ms"], b["received_complete_ms"]
    dt = t2 - t1
    if dt < MIN_PAIR_MS or dt > MAX_PAIR_MS:
        raise ValueError("Insufficient or impossible inter-snapshot separation")
    if a["body_sha256"] == b["body_sha256"]:
        raise ValueError("Repeated raw source instead of a new observation")
    if decision_ms < t2 or decision_ms - t2 > MAX_ASOF_AGE_MS:
        return None
    if kind == "oi":
        old = finite_decimal(a["observed"]["oiCcy"])
        new = finite_decimal(b["observed"]["oiCcy"])
        if old <= 0 or new <= 0:
            raise ValueError("Nonpositive OI")
        pct = (new / old - Decimal(1)) * 100
        return {
            "kind": "oi_fraction_delta",
            "asof_available_not_before_ms": t2,
            "first_received_ms": t1,
            "second_received_ms": t2,
            "interval_ms": dt,
            "delta_percent": str(pct),
            "direction": 1 if pct > 0 else -1 if pct < 0 else 0,
        }
    earlier, later = a["observed"], b["observed"]
    if earlier["future_forecast_is_realized_rate"] is not False or later["future_forecast_is_realized_rate"] is not False:
        raise ValueError("Forecast mislabelled as settled rate")
    if earlier["historical_publication_time_known"] is not False or later["historical_publication_time_known"] is not False:
        raise ValueError("Historical timestamp claim not grounded")
    if earlier["forecast_settlement_time_ms"] != later["forecast_settlement_time_ms"]:
        return {
            "kind": "funding_forecast_delta",
            "comparable": False,
            "reason": "different_forecast_settlement_period",
            "asof_available_not_before_ms": t2,
            "first_received_ms": t1,
            "second_received_ms": t2,
            "delta_bps": None,
            "direction": None,
        }
    old = finite_decimal(earlier["forecast_funding_rate"], signed=True)
    new = finite_decimal(later["forecast_funding_rate"], signed=True)
    delta = (new - old) * Decimal(10000)
    return {
        "kind": "funding_forecast_delta",
        "comparable": True,
        "forecast_settlement_time_ms": earlier["forecast_settlement_time_ms"],
        "asof_available_not_before_ms": t2,
        "first_received_ms": t1,
        "second_received_ms": t2,
        "delta_bps": str(delta),
        "direction": 1 if delta > 0 else -1 if delta < 0 else 0,
    }


def build_panel(root, universe, *, second_prefix="okx-pit-v5-20261029-second-batch"):
    """Re-verify every byte of both snapshot rounds before computing changes."""
    root = Path(root)
    universe = Path(universe)
    frozen_bytes = universe.read_bytes()
    u = json.loads(frozen_bytes)
    if (u.get("schema") != "algorithm_pit_universe_v5"
            or u.get("market_count") != 50
            or u.get("trading_approved") is not False
            or u.get("historical_point_in_time_membership_verified") is not False):
        raise ValueError("Unexpected membership freeze")
    symbols = [r["symbol"] for r in u["members"]]
    if len(symbols) != 50 or len(set(symbols)) != 50:
        raise ValueError("Invalid group membership")
    first_audit = first_batch_audit(root, universe)
    receipts = []
    market_rows = []
    seen = set()
    old_last, new_first = first_audit["last_response_ms"], None
    for k in range(1, 11):
        old, old_sha = verify_capture(root / f"okx-pit-v5-20261029-batch{k:02d}")
        new, new_sha = verify_capture(root / f"{second_prefix}{k:02d}")
        batch = symbols[(k-1)*5:k*5]
        if old["symbols"] != batch or new["symbols"] != batch:
            raise ValueError("Reordered or omitted capture evidence")
        if old_sha == new_sha:
            raise ValueError("The same capture was supplied twice")
        if old["records"][-1]["received_complete_ms"] >= new["records"][0]["request_sent_ms"]:
            raise ValueError("New batch cannot precede old batch")
        first_time = new["records"][0]["request_sent_ms"]
        if new_first is None:
            new_first = first_time
        if first_time <= old_last:
            raise ValueError("Second round started before first round ended")
        if k > 1 and first_time < receipts[-1]["second_last_receipt_ms"]:
            raise ValueError("Second round time order is invalid")
        last_time = new["records"][-1]["received_complete_ms"]
        receipts.append({
            "batch": k, "old_manifest_sha256": old_sha,
            "new_manifest_sha256": new_sha,
            "second_first_request_ms": first_time,
            "second_last_receipt_ms": last_time,
            "symbols": batch,
        })
        for sym in batch:
            if sym in seen:
                raise ValueError("Duplicate instrument")
            seen.add(sym)
            oi_t = find(new, "oi", sym)["received_complete_ms"]
            f_t = find(new, "funding", sym)["received_complete_ms"]
            oi = pair_field(old, new, sym, "oi", oi_t)
            funding = pair_field(old, new, sym, "funding", f_t)
            if oi is None or funding is None:
                raise ValueError("Unexpected unavailable field at its own receipt")
            # As-of counterexample: the second observation cannot exist one ms
            # before its complete receive time.
            if pair_field(old, new, sym, "oi", oi_t - 1) is not None:
                raise AssertionError("OI leak into the past")
            if pair_field(old, new, sym, "funding", f_t - 1) is not None:
                raise AssertionError("Funding leak into the past")
            market_rows.append({
                "symbol": sym, "rank": len(market_rows) + 1,
                "oi": oi, "funding_forecast": funding,
                "trading_signal": None,
                "forward_return_scored": False,
            })
    if set(symbols) != seen:
        raise ValueError("Incomplete 50 market panel")
    if receipts[-1]["second_last_receipt_ms"] - new_first > 3_600_000:
        raise ValueError("Second round was not bounded in time")
    oi_pos = sum(r["oi"]["direction"] > 0 for r in market_rows)
    oi_neg = sum(r["oi"]["direction"] < 0 for r in market_rows)
    comparable = [r["funding_forecast"] for r in market_rows if r["funding_forecast"]["comparable"]]
    f_up = sum(r["direction"] > 0 for r in comparable)
    f_down = sum(r["direction"] < 0 for r in comparable)
    f_flat = sum(r["direction"] == 0 for r in comparable)
    return {
        "schema": SCHEMA,
        "frozen_universe_sha256": hashlib.sha256(frozen_bytes).hexdigest(),
        "first_round_audit_schema": first_audit["schema"],
        "first_round_last_receipt_ms": old_last,
        "second_round_first_request_ms": new_first,
        "second_round_last_receipt_ms": receipts[-1]["second_last_receipt_ms"],
        "batch_receipts": receipts,
        "markets": market_rows,
        "summary": {
            "market_count": len(market_rows),
            "oi_increased": oi_pos,
            "oi_decreased": oi_neg,
            "oi_unchanged": 50 - oi_pos - oi_neg,
            "funding_same_period": len(comparable),
            "funding_different_period": 50 - len(comparable),
            "funding_forecast_increased": f_up,
            "funding_forecast_decreased": f_down,
            "funding_forecast_unchanged": f_flat,
        },
        "asof_uses_complete_receive_time": True,
        "snapshot_only_not_return_backtest": True,
        "funding_values_are_forecasts_not_settled": True,
        "historical_publication_time_certified": False,
        "independent_performance_validated": False,
        "can_start_paper": False,
        "can_submit_orders": False,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--universe", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    if args.out.exists():
        raise FileExistsError("Refuse to replace a research observation")
    result = build_panel(args.root, args.universe)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf8") as f:
        json.dump(result, f, indent=2, sort_keys=True, allow_nan=False)
        f.write("\n")
    print(json.dumps({
        "summary": result["summary"],
        "asof_verified": True,
        "independent_performance_validated": False,
        "can_start_paper": False,
    }))


if __name__ == "__main__":
    main()
