#!/usr/bin/env python3
"""Algorithm Discovery v4: funding-conditioned, research-only ablation.

Official archived *settlement timestamps* do not provide original publication
timestamps. A post-settlement embargo is an ASSUMPTION, not proven point-in-
time availability. Funding is used as an input feature only after this embargo.
This module has no network, exchange authentication, accounts or order routes.
"""
from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import timedelta
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile

from algorithm_event_lab import replay
from algorithm_intrinsic_lab import GRAMMAR, decisions as price_decisions
from run_alpha_audited import verify_snapshot

SCHEMA = "algorithm_funding_condition_v4"
BAR_MS = 900_000
MAX_AGE_MS = 8 * 3_600_000
MAX_PREVIOUS_INTERVAL_MS = 12 * 3_600_000
# Neither latency is asserted as the actual historical OKX publication delay.
EMBARGO_BARS = (1, 4)
CANDIDATES = ("recoil-recovery", "recovery-failure")
GATES = ("price_coverage", "carry_receive", "funding_deceleration")
COSTS = {"base": .0007, "double": .0014}


@dataclass(frozen=True)
class FundingEvent:
    time_ms: int
    rate: float


def verified_funding(path, symbol):
    """Reconstruct original ZIP rows and validate receipts/report exact equality.

    No fabricated rates, default zero observations or implicit interpolation.
    Returns archival settlement observations, NOT certified published-at events.
    """
    path = Path(path)
    raw = path.read_bytes()
    data = json.loads(raw)
    if (data.get("format") != "okx_archive_funding_v5"
            or data.get("symbol") != symbol
            or data.get("source") != "OKX_OFFICIAL_MONTHLY_ARCHIVE"
            or data.get("calendar_completeness_certified") is not False
            or data.get("account_realized_funding_verified") is not False
            or data.get("allow_trading") is not False):
        raise ValueError("Unrecognized or unsafe funding evidence")
    archives = data.get("source_archives")
    if not isinstance(archives, list) or not 1 <= len(archives) <= 24:
        raise ValueError("Missing archive provenance")
    observed = []
    months = []
    hashes = []
    for source in archives:
        if not isinstance(source, dict) or set(source) != {
            "month", "archive_path", "archive_sha256"
        }:
            raise ValueError("Unrecognized source archive record")
        month, digest = source["month"], source["archive_sha256"]
        if not isinstance(month, str) or len(month) != 7 or month[:4].isdigit() is False:
            raise ValueError("Invalid month")
        archive_path = Path(source["archive_path"])
        expected = f"{symbol}-fundingrates-{month}.zip"
        if archive_path.name != expected or not archive_path.is_file():
            raise ValueError("Funding archive mismatch")
        if archive_path.stat().st_size > 10_000_000:
            raise ValueError("Oversized archive")
        payload = archive_path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != digest:
            raise ValueError("Funding archive SHA mismatch")
        receipt = json.loads(Path(str(archive_path) + ".receipt.json").read_text(encoding="utf8"))
        if (receipt.get("protocol") != "okx_official_archive_v5"
                or receipt.get("module") != "3"
                or receipt.get("symbol") != symbol
                or receipt.get("month") != month
                or receipt.get("sha256") != digest
                or receipt.get("size_bytes") != len(payload)
                or not receipt.get("archive_url", "").startswith(
                    "https://static.okx.com/cdn/okex/traderecords/")):
            raise ValueError("Funding receipt mismatch")
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            members = z.infolist()
            if (len(members) != 1
                    or members[0].filename != f"{symbol}-fundingrates-{month}.csv"
                    or members[0].file_size > 10_000_000):
                raise ValueError("Unsafe funding ZIP")
            with z.open(members[0]) as stream:
                reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig"))
                if reader.fieldnames != ["instrument_name", "funding_rate", "funding_time"]:
                    raise ValueError("Unknown funding source schema")
                for row in reader:
                    if set(row) != {"instrument_name", "funding_rate", "funding_time"} or row["instrument_name"] != symbol:
                        raise ValueError("Invalid funding row")
                    t = int(row["funding_time"])
                    rate = float(row["funding_rate"])
                    if (not math.isfinite(rate) or abs(rate) > .1
                            or t <= 0 or (observed and t <= observed[-1].time_ms)):
                        raise ValueError("Unordered or invalid funding")
                    observed.append(FundingEvent(t, rate))
        months.append(month)
        hashes.append(digest)
    if months != sorted(set(months)) or data.get("downloaded_zip_sha256") != hashes:
        raise ValueError("Non-unique or unverified funding archives")
    expected_events = [{"time_ms": e.time_ms, "archive_funding_rate": e.rate} for e in observed]
    if (data.get("events") != expected_events
            or data.get("events_count") != len(observed)
            or not observed):
        raise ValueError("Funding report differs from verified source")
    return observed, hashlib.sha256(raw).hexdigest()


def available_pair(events, decision_ms, lag_bars):
    """Two historically settled events; both must have passed embargo.

    Snapshot reports lack real publication times: this is hypothetical
    availability and should not be described as verified point-in-time data.
    """
    if type(lag_bars) is not int or lag_bars not in EMBARGO_BARS:
        raise ValueError("Unregistered latency scenario")
    if type(decision_ms) is not int:
        raise ValueError("Invalid decision time")
    cut = decision_ms - lag_bars * BAR_MS
    previous = latest = None
    last_time = None
    for e in events:
        if last_time is not None and e.time_ms <= last_time:
            raise ValueError("Funding chronology broken")
        last_time = e.time_ms
        if not math.isfinite(e.rate) or abs(e.rate) > .1:
            raise ValueError("Funding value invalid")
        if e.time_ms > cut:
            break
        previous, latest = latest, e
    if previous is None or latest is None:
        return None
    if (decision_ms - latest.time_ms > MAX_AGE_MS
            or latest.time_ms - previous.time_ms > MAX_PREVIOUS_INTERVAL_MS):
        return None
    return previous, latest


def gate_decisions(bars, targets, events, gate, lag_bars):
    """Reject at initial target entry only; never enter midway through a lease."""
    if gate not in GATES:
        raise ValueError("Unknown funding hypothesis")
    if len(bars) != len(targets):
        raise ValueError("Candle/target length mismatch")
    result = []
    prev = 0
    permitted = False
    considered = eligible = accepted = missing = 0
    for bar, target in zip(bars, targets):
        if type(target) is not int or target not in (-1, 0, 1):
            raise ValueError("Invalid target")
        if target != 0 and target != prev:
            considered += 1
            t = bar.time
            if t.tzinfo is None or t.utcoffset() != timedelta(0):
                raise ValueError("Expected aware UTC candle")
            # Closed 15m candle at t+15 minutes, never t's opening instant.
            decision_ms = int(t.timestamp() * 1000) + BAR_MS
            pair = available_pair(events, decision_ms, lag_bars)
            eligible += int(pair is not None)
            missing += int(pair is None)
            permitted = False
            if pair:
                earlier, current = pair
                if gate == "price_coverage":
                    permitted = True
                elif gate == "carry_receive":
                    permitted = target * current.rate < 0
                else:
                    permitted = target * (current.rate - earlier.rate) < 0
            accepted += int(permitted)
        elif target == 0:
            permitted = False
        result.append(target if permitted else 0)
        prev = target
    return result, {"considered": considered, "coverage_eligible": eligible,
                    "missing_or_stale": missing, "accepted": accepted}


def score(bars, actions):
    return {
        label: {k: v for k, v in replay(bars, actions, side_cost=cost, allocation=.1).items()
                if k not in ("equity_path", "changes")}
        for label, cost in COSTS.items()
    }


def development(bars, funding, *,
                limit=None):
    """Use train60 and exposed20 only; final20 not passed into the evaluator."""
    n = len(bars)
    if n < 1200:
        raise ValueError("Insufficient candles")
    ceiling = int(n * .8)
    if limit is not None and limit != ceiling:
        raise ValueError("Cannot move reserved holdout boundary")
    rows = []
    for segment, first, last in (
        ("train", 0, int(n * .6)),
        ("exposed_development", int(n * .6), ceiling)
    ):
        sample = bars[first:last]
        for model in CANDIDATES:
            targets, _, _ = price_decisions(sample, model)
            rows.append({"id": model+"-price-original", "role": "ungated",
                         "segment": segment, "scores": score(sample, targets)})
            for lag in EMBARGO_BARS:
                for gate in GATES:
                    actions, metrics = gate_decisions(sample, targets, funding, gate, lag)
                    rows.append({"id": model+"-"+gate, "role": "assumed_latency_exploratory",
                                 "segment": segment, "embargo_bars": lag,
                                 "metrics": metrics, "scores": score(sample, actions)})
    return {"rows": rows, "reserved_range": [ceiling, n], "holdout_used": False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv", nargs="+", required=True, type=Path)
    p.add_argument("--funding", nargs="+", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    if args.out.exists():
        raise FileExistsError("Never overwrite a research report")
    if len(args.csv) != len(args.funding) or not 1 <= len(args.csv) <= 5:
        raise ValueError("Supply one matching funding file per market")
    markets = []
    seen = set()
    for csv_path, fund_path in zip(args.csv, args.funding):
        bars, manifest, candle_sha = verify_snapshot(csv_path, csv_path.with_suffix(".manifest.json"))
        symbol = manifest["symbol"]
        if symbol in seen:
            raise ValueError("Duplicate market")
        seen.add(symbol)
        events, funding_sha = verified_funding(fund_path, symbol)
        # Unavailable external fields MUST fail closed and cannot be synthesized.
        markets.append({"symbol": symbol, "bars": len(bars),
                        "candles_sha256": candle_sha, "funding_report_sha256": funding_sha,
                        "funding_observations": len(events), **development(bars, events)})
    result = {
        "schema": SCHEMA, "mode": "EXPLORATORY_DEVELOPMENT_ONLY",
        "markets": markets, "embargo_bars": list(EMBARGO_BARS),
        "unknown_actual_publication_latency": True,
        "historical_point_in_time_verified": False,
        "funding_cashflow_in_equity": False,
        "open_interest_verified": False, "historical_orderbook_verified": False,
        "timestamped_news_verified": False, "holdout_used": False,
        "can_submit_orders": False, "can_start_paper": False,
        "predictive_edge_proven": False, "scientific_novelty_proven": False,
        "independent_validation": "PENDING_NEW_FUTURE_WINDOW",
        "inference": "NO_PVALUES_EXPOSED_AND_PUBLICATION_TIME_UNKNOWN",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf8") as file:
        json.dump(result, file, indent=2, sort_keys=True, allow_nan=False)
        file.write("\n")
    print(json.dumps({"markets": len(markets), "holdout_used": False,
                      "historical_point_in_time_verified": False,
                      "can_submit_orders": False}))


if __name__ == "__main__":
    main()
