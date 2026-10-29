#!/usr/bin/env python3
"""Verify public OKX settled funding event pages as immutable RESEARCH evidence.

This file does not contact the exchange. It accepts externally captured raw
official GET /api/v5/public/funding-rate-history responses and validates
actual realizedRate events. No assumed zero funding, intervals, or trading.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from okx_dataset import SYMBOL

def canonical(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode("utf-8")


def validate(pages, symbol, as_of):
    if not SYMBOL.fullmatch(symbol):
        raise ValueError("Invalid swap instrument")
    if as_of.tzinfo is None or as_of.utcoffset() != timedelta(0):
        raise ValueError("UTC capture clock required")
    as_of_ms = int(as_of.timestamp() * 1000)
    if not isinstance(pages, list) or not pages:
        raise ValueError("Raw OKX funding pages required")
    result = []
    previous = None
    digests = []
    for index, page in enumerate(pages):
        if (not isinstance(page, dict) or page.get("code") != "0"
                or not isinstance(page.get("data"), list)
                or not 1 <= len(page["data"]) <= 100):
            raise ValueError("Invalid official funding history page")
        digests.append(hashlib.sha256(canonical(page)).hexdigest())
        for row in page["data"]:
            if not isinstance(row, dict) or row.get("instId") != symbol:
                raise ValueError("Funding instrument mismatch")
            stamp = row.get("fundingTime")
            if not isinstance(stamp, str) or not re.fullmatch(r"\d{13}", stamp):
                raise ValueError("Funding event timestamp invalid")
            t = int(stamp)
            if t > as_of_ms:
                raise ValueError("Future or unsettled funding event")
            if previous is not None and t >= previous:
                raise ValueError("Funding pages must be strictly newest-first")
            previous = t
            realized = row.get("realizedRate")
            if not isinstance(realized, str) or not realized.strip():
                raise ValueError("Only observed realizedRate is acceptable")
            rate = float(realized)
            if not math.isfinite(rate) or abs(rate) > 0.1:
                raise ValueError("Implausible or missing settled funding rate")
            result.append({"time_ms": t, "realized_rate": rate})
    return {
        "schema": "okx_settled_funding_evidence_v1",
        "symbol": symbol,
        "as_of_utc": as_of.isoformat(),
        "source": "supplied_raw_okx_public_api_pages_not_authenticated",
        "pages_sha256": digests,
        "events": sorted(result, key=lambda r: r["time_ms"]),
        "events_count": len(result),
        "calendar_completeness_verified": False,
        "funding_frequency_assumed": False,
        "can_enable_trading": False,
    }


def known_settlement_cashflow(direction, entry_ms, exit_ms, events):
    """Return ONLY observed funding cashflow per notional, not assumed coverage."""
    if direction not in (-1, 1) or not 0 <= entry_ms < exit_ms:
        raise ValueError("Bad synthetic holding interval/direction")
    previous = None
    cashflow = 0.0
    matched = 0
    for event in events:
        t = event["time_ms"]
        if previous is not None and t <= previous:
            raise ValueError("Funding event order invalid")
        previous = t
        r = event["realized_rate"]
        if not math.isfinite(r):
            raise ValueError("Funding event invalid")
        if entry_ms < t <= exit_ms:
            # Positive funding: longs pay shorts. Negative: reverse.
            cashflow -= direction * r
            matched += 1
    return {
        "observed_cashflow_per_notional": round(cashflow, 12),
        "observed_settlements": matched,
        "coverage_certified": False,
        "no_settlement_observed_means_zero_funding": False,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--symbol", required=True)
    p.add_argument("--raw-pages", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    if args.out.exists() or args.out.resolve() == args.raw_pages.resolve():
        raise FileExistsError("Output must be a new, distinct file")
    raw_bytes = args.raw_pages.read_bytes()
    pages = json.loads(raw_bytes)
    observed = validate(pages, args.symbol, datetime.now(timezone.utc))
    observed["input_file_sha256"] = hashlib.sha256(raw_bytes).hexdigest()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as file:
        json.dump(observed, file, sort_keys=True, indent=2)
        file.write("\n")
    print(json.dumps({"events": observed["events_count"],
                      "coverage_verified": False,
                      "symbol": args.symbol,
                      "output": str(args.out)}))


if __name__ == "__main__":
    main()
