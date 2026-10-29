#!/usr/bin/env python3
"""Fail-closed audit of ten manual five-symbol OKX public capture batches.

This is only a one-time forward research *starting observation*, never an OI
history/backtest or evidence that archived funding settlement times were
publication times. No network, orders, accounts, trade signals or scheduler.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from algorithm_pit_capture_v5 import verify_capture, point_in_time_oi_delta

SCHEMA = "algorithm_pit_batch_audit_v5"


def audit(root, frozen_path):
    root, frozen_path = Path(root), Path(frozen_path)
    frozen_bytes = frozen_path.read_bytes()
    frozen = json.loads(frozen_bytes)
    if (frozen.get("schema") != "algorithm_pit_universe_v5"
            or frozen.get("market_count") != 50
            or frozen.get("historical_point_in_time_membership_verified") is not False
            or frozen.get("trading_approved") is not False
            or len(frozen.get("members", [])) != 50):
        raise ValueError("Invalid frozen candidate universe")
    symbols = [m["symbol"] for m in frozen["members"]]
    if len(set(symbols)) != 50 or any(m["rank"] != i+1 for i, m in enumerate(frozen["members"])):
        raise ValueError("Duplicated or reordered candidates")
    timestamp = datetime.fromisoformat(
        frozen["source_fetched_at_utc"].replace("Z", "+00:00"))
    if timestamp.utcoffset() != timezone.utc.utcoffset(timestamp):
        raise ValueError("Non-UTC source snapshot")
    source_ms = int(timestamp.timestamp()*1000)
    bundles = []
    counts = {"symbols": 0, "oi": 0, "funding_forecasts": 0,
              "server_clock_responses": 0, "raw_api_responses": 0}
    seen_symbols = set()
    first = last = None
    previous_end = source_ms
    manifests = []
    for batch in range(1, 11):
        name = f"okx-pit-v5-20261029-batch{batch:02d}"
        manifest, sha = verify_capture(root / name)
        expected = symbols[(batch-1)*5:batch*5]
        if manifest["symbols"] != expected:
            raise ValueError("Capture order differs from frozen market ranks")
        if manifest.get("no_scheduler") is not True or manifest.get("no_credentials") is not True:
            raise ValueError("Unsafe source capture")
        sent = manifest["records"][0]["request_sent_ms"]
        received = manifest["records"][-1]["received_complete_ms"]
        if sent < previous_end:
            raise ValueError("Overlapping or time-reversed capture batches")
        previous_end = received
        first = sent if first is None else first
        last = received
        for item in manifest["records"]:
            if item["kind"] == "oi":
                counts["oi"] += 1
            elif item["kind"] == "funding":
                counts["funding_forecasts"] += 1
                if (item["observed"]["future_forecast_is_realized_rate"] is not False
                        or item["observed"]["historical_publication_time_known"] is not False):
                    raise ValueError("Misleading funding semantics")
            else:
                counts["server_clock_responses"] += 1
        counts["symbols"] += len(manifest["symbols"])
        counts["raw_api_responses"] += len(manifest["records"])
        seen_symbols.update(manifest["symbols"])
        manifests.append(manifest)
        bundles.append({"folder": name, "sha256": sha,
                        "symbols": expected, "first_request_ms": sent,
                        "last_response_ms": received})
    if (seen_symbols != set(symbols) or counts != {
        "symbols": 50, "oi": 50, "funding_forecasts": 50,
        "server_clock_responses": 20, "raw_api_responses": 120}):
        raise ValueError("Incomplete 50-market source evidence")
    if first < source_ms:
        raise ValueError("Captured observations precede universe selection")
    if last-first > 3_600_000:
        raise ValueError("Not a bounded one-hour manual collection")
    # One OI value per market: never pretend a prior historical value exists.
    if any(point_in_time_oi_delta(manifests, sym, last) is not None for sym in symbols):
        raise ValueError("Unexpected second OI observation in a single snapshot run")
    return {
        "schema": SCHEMA,
        "universe_sha256": hashlib.sha256(frozen_bytes).hexdigest(),
        "source_universe_selected_at_utc": frozen["source_fetched_at_utc"],
        "first_request_ms": first, "last_response_ms": last,
        "counts": counts,
        "batch_receipts": bundles,
        "single_snapshot_has_no_oi_delta": True,
        "historical_funding_publication_verified": False,
        "funding_settlement_cashflow_modeled": False,
        "historical_backtest_ready": False,
        "independent_forward_test_ready": False,
        "trading_approved": False,
        "can_submit_orders": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--universe", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise FileExistsError("A new audit report must not overwrite evidence")
    result = audit(args.root, args.universe)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf8") as stream:
        json.dump(result, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"symbols": result["counts"]["symbols"],
                      "responses": result["counts"]["raw_api_responses"],
                      "oi_history_ready": False, "trading_approved": False}))


if __name__ == "__main__":
    main()
