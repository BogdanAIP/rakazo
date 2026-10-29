#!/usr/bin/env python3
"""Freeze a bounded candidate universe FROM an already saved OKX selection.

This does NOT re-certify the original API responses (their raw bytes may be
absent), historical membership, listing survival, or historical OI coverage.
A membership freeze on 2026-10-29 cannot apply to earlier backtests.
No network, orders, scheduler, accounts or paid providers.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re

SCHEMA = "algorithm_pit_universe_v5"
MARKET = re.compile(r"[A-Z0-9]{2,20}-USDT-SWAP\Z")


def freeze(path, *, size=50):
    path = Path(path)
    raw = path.read_bytes()
    if len(raw) > 2_000_000:
        raise ValueError("Unbounded market list")
    original = json.loads(raw)
    if (original.get("schema") != "okx_usdt_swap_universe_v1"
            or original.get("source") != "official_okx_public_rest"):
        raise ValueError("Unknown universe source")
    if not isinstance(size, int) or type(size) is not int or size != 50:
        raise ValueError("Protocol requires exactly 50 preselected candidates")
    ts = original.get("fetched_at_utc")
    try:
        timestamp = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as e:
        raise ValueError("Invalid source timestamp") from e
    if timestamp.utcoffset() != timezone.utc.utcoffset(timestamp):
        raise ValueError("Non-UTC source")
    for digest in ("instruments_response_sha256", "tickers_response_sha256"):
        if not re.fullmatch("[0-9a-f]{64}", original.get(digest, "")):
            raise ValueError("Missing source response hash")
    selection = original.get("selection")
    if (not isinstance(selection, dict)
            or selection.get("minimum_listing_days") != 90
            or selection.get("min_estimated_24h_turnover_usdt") != 2_000_000
            or selection.get("max_spread_bps") != 30):
        raise ValueError("Unknown previous screening protocol")
    rows = original.get("selected")
    if not isinstance(rows, list) or len(rows) < size:
        raise ValueError("Insufficient frozen candidates")
    if original.get("total_live_liquid_candidates", 0) < size:
        raise ValueError("Claimed eligibility less than 50")
    used = set()
    entries = []
    previous = float("inf")
    for position, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError("Invalid market row")
        sym = row.get("symbol")
        if not isinstance(sym, str) or not MARKET.fullmatch(sym) or sym in used:
            raise ValueError("Duplicate/invalid instrument")
        used.add(sym)
        turnover = row.get("estimated_24h_quote_turnover_usdt")
        spread = row.get("spread_bps")
        if (type(turnover) not in (float, int) or not math.isfinite(turnover)
                or turnover < 2_000_000 or turnover > previous
                or type(spread) not in (float, int) or not math.isfinite(spread)
                or not 0 <= spread <= 30):
            raise ValueError("Market screening or ranking mismatch")
        previous = turnover
        try:
            listed = datetime.fromisoformat(row["listed_since"].replace("Z", "+00:00"))
        except (KeyError, AttributeError, ValueError) as e:
            raise ValueError("Unknown listing date") from e
        if (listed.tzinfo is None or listed > timestamp
                or (timestamp-listed).days < 90):
            raise ValueError("Market not old enough at selection")
        if position < size:
            entries.append({
                "rank": position+1, "symbol": sym,
                "estimated_quote_turnover_24h_usdt": turnover,
                "spread_bps_at_source_capture": spread,
                "listed_since": row["listed_since"],
                "historical_data_coverage_verified": False,
            })
    return {
        "schema": SCHEMA,
        "source_file_sha256": hashlib.sha256(raw).hexdigest(),
        "source_filename": path.name,
        "source_fetched_at_utc": ts,
        "source_instruments_response_sha256_unverifiable_without_raw":
            original["instruments_response_sha256"],
        "source_tickers_response_sha256_unverifiable_without_raw":
            original["tickers_response_sha256"],
        "source_raw_api_responses_verified": False,
        "historical_point_in_time_membership_verified": False,
        "membership_fixed_from_source_utc": ts,
        "market_count": size,
        "selection_rule": "first_50_by_stored_24h_estimated_quote_turnover_after_saved_filters",
        "members": entries,
        "trading_approved": False,
        "independent_evaluation_ready": False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("Never overwrite frozen source")
    result=freeze(args.source)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open("x",encoding="utf8") as file:
        json.dump(result,file,indent=2,sort_keys=True,allow_nan=False)
        file.write("\n")
    print(json.dumps({"count":result["market_count"],
                      "historical_membership_verified":False,
                      "trading_approved":False}))


if __name__=="__main__":
    main()
