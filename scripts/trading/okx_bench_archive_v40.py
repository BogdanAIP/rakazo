"""Acquire official OKX all-swap daily archives for an offline, point-in-time hourly research panel.

Research only. No accounts, trades, orders or keys. Python 3.10+ stdlib.
Raw data and receipts MUST live outside the Git repository. Do not commit panel CSV.
Archive labels follow UTC+08:00 exchange days; candle open timestamps are UTC ms.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import shutil
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

HOUR = 3_600_000
DAY = 86_400_000
HOST = "https://app.okx.com"
MODULES = {"candles": "2", "funding": "3"}
UA = {"User-Agent": "Mozilla/5.0 (compatible; historical research audit)"}
DATE = dt.date.fromisoformat
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_MEMBER_BYTES = 512 * 1024 * 1024
DEFAULT_NEW_BYTES = 512 * 1024 * 1024
MIN_FREE_BYTES = 10 * 1024 ** 3


def days(first, last):
    day = first
    while day <= last:
        yield day
        day += dt.timedelta(days=1)


def request_bytes(url: str, *, max_bytes: int = MAX_RESPONSE_BYTES) -> bytes:
    if max_bytes <= 0:
        raise ValueError("Response byte budget must be positive")
    for attempt in range(7):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45) as response:
                length = response.headers.get("Content-Length")
                if length is not None and int(length) > max_bytes:
                    raise ValueError("Response exceeds finite byte budget")
                body = bytearray()
                while True:
                    chunk = response.read(min(1024 * 1024, max_bytes - len(body) + 1))
                    if not chunk:
                        return bytes(body)
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise ValueError("Response exceeds finite byte budget")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in (429, 500, 502, 503, 504):
                raise
            if attempt == 6:
                raise
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("request failed")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_bytes(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + ".part")
    with open(part, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(part, path)


def index_url(module: str, day: dt.date) -> str:
    ms = int(dt.datetime.combine(day, dt.time(), dt.timezone.utc).timestamp() * 1000)
    params = {
        "module": MODULES[module],
        "instType": "SWAP",
        "instFamilyList": "ANY",
        "dateAggrType": "daily",
        "begin": ms,
        "end": ms,
    }
    return HOST + "/api/v5/public/market-data-history?" + urllib.parse.urlencode(params)


def source_url(module: str, day: dt.date) -> str:
    payload = json.loads(request_bytes(index_url(module, day)))
    if payload.get("code") != "0":
        raise RuntimeError(f"OKX index error {module} {day}: {payload.get('code')} {payload.get('msg')}")
    groups = [g for x in payload.get("data", []) for det in x.get("details", [])
              for g in det.get("groupDetails", [])]
    expected = ("allswap-candlesticks-" if module == "candles" else "allswap-fundingrates-") + day.isoformat() + ".zip"
    matches = [g["url"] for g in groups if g.get("filename") == expected]
    if len(matches) != 1 or not matches[0].startswith("https://static.okx.com/"):
        raise RuntimeError(f"Expected ONE official {module} archive for {day}, got {matches}")
    return matches[0]


def file_at(root: Path, module: str, day: dt.date) -> Path:
    return root / "raw" / f"{module}-{day.isoformat()}.zip"


def sync(root: Path, start: dt.date, end: dt.date, max_days: int,
         *, max_new_bytes: int = DEFAULT_NEW_BYTES, min_free_bytes: int = MIN_FREE_BYTES):
    if start > end or max_days <= 0 or max_new_bytes <= 0 or min_free_bytes < 0:
        raise ValueError("Invalid finite acquisition budget or date interval")
    root.mkdir(parents=True, exist_ok=True)
    processed = 0
    new_bytes = 0
    for day in days(start, end):
        receipt = root / "receipts" / (day.isoformat() + ".json")
        current = json.loads(receipt.read_text()) if receipt.exists() else {}
        missing = [name for name in MODULES if not file_at(root, name, day).exists()]
        for name in MODULES:
            path = file_at(root, name, day)
            if path.exists():
                info = current.get(name, {})
                if info.get("sha256") != sha_file(path) or info.get("zip_bytes") != path.stat().st_size:
                    raise ValueError(f"Existing original/receipt mismatch: {name} {day}")
        if not missing:
            continue
        if processed >= max_days:
            break
        for name in missing:
            free = shutil.disk_usage(root).free
            remaining = min(MAX_RESPONSE_BYTES, max_new_bytes - new_bytes, free - min_free_bytes)
            if remaining <= 0:
                raise RuntimeError("Finite acquisition byte/disk budget exhausted")
            url = source_url(name, day)
            data = request_bytes(url, max_bytes=remaining)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if len(archive.namelist()) != 1 or not archive.namelist()[0].endswith(".csv"):
                    raise ValueError(f"Unexpected ZIP contents: {name} {day}")
                if archive.infolist()[0].file_size > MAX_ARCHIVE_MEMBER_BYTES:
                    raise ValueError("Uncompressed archive member exceeds finite budget")
                if archive.testzip() is not None:
                    raise ValueError(f"Corrupted archive: {name} {day}")
            if shutil.disk_usage(root).free - len(data) < min_free_bytes:
                raise RuntimeError("Free disk would fall below the acquisition floor")
            atomic_bytes(file_at(root, name, day), data)
            new_bytes += len(data)
            current[name] = {"official_url": url, "sha256": sha(data), "zip_bytes": len(data)}
            atomic_bytes(receipt, (json.dumps(current, sort_keys=True, indent=2) + "\n").encode())
            time.sleep(0.55)  # Stay below OKX index rate cap (5 requests per 2 seconds).
        processed += 1
        print(json.dumps({"archive_day": day.isoformat(), "modules": list(current), "status": "downloaded"}), flush=True)
    total = sum(1 for d in days(start, end) if all(file_at(root, x, d).exists() for x in MODULES))
    result = {"complete_archive_days": total, "required_archive_days": (end - start).days + 1,
              "new_archive_days": processed, "new_bytes": new_bytes,
              "max_new_bytes": max_new_bytes, "min_free_bytes": min_free_bytes}
    print(json.dumps(result, indent=2))
    return result


def read_zip_rows(path: Path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != 1 or not names[0].endswith(".csv"):
            raise ValueError(f"Unexpected source layout: {path.name}")
        with archive.open(names[0]) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            yield from reader


def nominal_funding_hour(timestamp):
    hour = timestamp // HOUR * HOUR
    if not 0 <= timestamp - hour < 60000:
        raise ValueError("Funding clock outside reviewed [H,H+60s) window")
    return hour


def billing_day_patterns(events):
    """Map (billing UTC day, symbol) to its complete interval in {1,2,4,8} h, else None."""
    hours = collections.defaultdict(set)
    for (bar_open, symbol) in events:
        if bar_open % HOUR:
            raise ValueError("Funding billing bar is not hourly aligned")
        day = dt.datetime.fromtimestamp(bar_open / 1000, tz=dt.timezone.utc).date()
        hours[day, symbol].add((bar_open % DAY) // HOUR)
    expected = {frozenset(range(i - 1, 24, i)): i for i in (1, 2, 4, 8)}
    return {key: expected.get(frozenset(observed)) for key, observed in hours.items()}


def interval_consistent_funding_days(events, audit=None):
    """Conservative archive coverage inference, NOT a historical schedule certificate.

    Group by BILLING bar UTC day: a settlement at 00:00 bills 23:00
    of the previous day. For interval I its expected billing hours are
    I-1, 2I-1, ..., 23. Require both adjacent calendar days to have the
    same complete pattern; do not bridge missing days or recurse through
    the accepted set. Observed settlements remain usable even on unknown
    days; only absence-of-settlement cells depend on this inference.
    """
    candidates = billing_day_patterns(events)
    known = set()
    reasons = collections.Counter()
    intervals = collections.Counter()
    for (day, symbol), interval in candidates.items():
        if interval is None:
            reasons["incomplete_or_irregular_pattern"] += 1
            continue
        before = candidates.get((day - dt.timedelta(days=1), symbol))
        after = candidates.get((day + dt.timedelta(days=1), symbol))
        if before != interval or after != interval:
            reasons["adjacent_pattern_missing_or_different"] += 1
            continue
        known.add((day, symbol))
        intervals[str(interval)] += 1
    if audit is not None:
        audit.update(
            coverage_rule="complete billing-day pattern I in {1,2,4,8}h; same pattern on both adjacent calendar days",
            observed_billing_contract_days=len(candidates),
            known_billing_contract_days=len(known),
            unknown_observed_billing_contract_days=len(candidates) - len(known),
            unknown_day_reasons=dict(sorted(reasons.items())),
            known_days_by_interval_hours=dict(sorted(intervals.items())),
            schedule_provenance_certified=False,
            coverage_inference_uses_adjacent_days=True,
            coverage_caveat="Retrospective integrity inference only; systematic omitted settlements can mimic a slower schedule; historical availability and schedule changes need provenance before freeze",
        )
    return known


def parse_funding_rate(raw):
    """Only the observed archive sentinel 'None' means unavailable, never zero."""
    if raw == "None":
        return None
    try:
        value = float(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid original funding rate") from exc
    if not math.isfinite(value):
        raise ValueError("Nonfinite original funding rate")
    return value


def funding_billing_day_key(bar_open, symbol):
    return (dt.datetime.fromtimestamp(bar_open / 1000, tz=dt.timezone.utc).date(), symbol)


def load_funding(root: Path, archive_dates, clock_audit=None, unknown_rate_days=None):
    """Settlement-time rates; events belong to the hour ENDING at settlement T."""
    events = {}
    counters = clock_audit if clock_audit is not None else {}
    counters.update(snapped_events=0, maximum_offset_ms=0, outside_window_events=0)
    unknown_days = unknown_rate_days if unknown_rate_days is not None else set()
    unknown_days.clear()
    unknown_keys = []
    off_hour_unknown = set()
    count = 0
    for day in archive_dates:
        for row in read_zip_rows(file_at(root, "funding", day)):
            symbol = sys.intern(row["instrument_name"])
            if not symbol.endswith("-USDT-SWAP"):
                continue
            settlement = int(row["funding_time"])
            rate = parse_funding_rate(row["funding_rate"])
            try:
                nominal = nominal_funding_hour(settlement)
            except ValueError:
                counters["outside_window_events"] += 1
                if rate is not None:
                    raise
                # A missing-rate marker is not a billable settlement. Do not
                # round it into a payment or widen the numeric clock policy.
                marker = (settlement, symbol)
                if marker in off_hour_unknown:
                    raise ValueError("Duplicate settlement marker")
                off_hour_unknown.add(marker)
                hour = settlement // HOUR * HOUR
                # Without a valid settlement clock, neither adjacent billing
                # interpretation can certify no payment (covers midnight too).
                for bar in (hour - HOUR, hour):
                    unknown_days.add(funding_billing_day_key(bar, symbol))
                count += 1
                continue
            offset = settlement - nominal
            counters["snapped_events"] += int(offset != 0)
            counters["maximum_offset_ms"] = max(counters["maximum_offset_ms"], offset)
            bar_open = nominal - HOUR
            key = (bar_open, symbol)
            if key in events:
                raise ValueError(f"Duplicate settlement for {symbol} at {settlement}")
            events[key] = rate
            if events[key] is None:
                unknown_keys.append(key)
                unknown_days.add(funding_billing_day_key(*key))
            count += 1
    # An explicit unavailable rate must not masquerade as an absent/zero payment
    # or create a slower complete schedule after dropping every other record.
    for key in unknown_keys:
        del events[key]
    coverage_keys = (key for key in events if funding_billing_day_key(*key) not in unknown_days)
    known_days = interval_consistent_funding_days(coverage_keys, counters)
    counters.update(unknown_rate_events=len(unknown_keys) + len(off_hour_unknown),
                    unavailable_off_hour_markers=len(off_hour_unknown), unknown_rate_billing_days=len(unknown_days),
                    numeric_rate_events=len(events), source_rate_records=count)
    return events, known_days, count


def aggregate_day(root: Path, day: dt.date, funding=None):
    """Every observed trading hour is retained; count missing source minutes."""
    if funding is None:
        funding, _, local_funding_events = load_funding(root, [day])
    else:
        local_funding_events = 0
    by_hour = {}
    minutes_seen = {}
    identical_duplicates = 0
    confirm = collections.Counter()
    for row in read_zip_rows(file_at(root, "candles", day)):
        symbol = sys.intern(row["instrument_name"])
        if not symbol.endswith("-USDT-SWAP"):
            continue
        minute = int(row["open_time"])
        if minute % 60_000:
            raise ValueError(f"Not minute aligned: {symbol} {minute}")
        key_min = (minute, symbol)
        fingerprint = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if key_min in minutes_seen:
            if minutes_seen[key_min] != fingerprint:
                raise ValueError(f"Duplicate minute conflicting fields: {symbol} {minute}")
            identical_duplicates += 1
            continue
        minutes_seen[key_min] = fingerprint
        key = (minute // HOUR * HOUR, symbol)
        op, hi, lo, cl, vol = map(float, (row["open"], row["high"], row["low"], row["close"], row["vol_quote"]))
        if min(op, hi, lo, cl) <= 0 or vol < 0 or hi < max(op, cl, lo) or lo > min(op, cl, hi):
            raise ValueError(f"Bad OHLCV: {symbol} {minute}")
        confirm[row["confirm"]] += 1
        if key not in by_hour:
            by_hour[key] = [minute, minute, op, hi, lo, cl, vol, 1]
        else:
            acc = by_hour[key]
            acc[3] = max(acc[3], hi)
            acc[4] = min(acc[4], lo)
            acc[6] += vol
            acc[7] += 1
            if minute < acc[0]:
                acc[0], acc[2] = minute, op
            if minute >= acc[1]:
                acc[1], acc[5] = minute, cl
    incomplete = 0
    missing_minutes = 0
    out = []
    for (hour, sym), acc in sorted(by_hour.items()):
        # A sparse archive could mean no trades or data loss. Preserve OHLC
        # based on observed minutes and disclose incomplete hours; NEVER
        # silently describe them as complete market observations.
        if acc[7] != 60 or acc[0] != hour or acc[1] != hour + 59 * 60_000:
            incomplete += 1
            missing_minutes += 60 - acc[7]
        out.append((hour, sym, acc[2], acc[3], acc[4], acc[5], acc[6],
                    funding.get((hour, sym)), acc[7]))
    return out, {"archive_date": day.isoformat(), "usable_hours": len(out),
                 "incomplete_hours": incomplete, "missing_source_minutes": missing_minutes,
                 "identical_duplicate_rows_collapsed": identical_duplicates,
                 "confirm_counts": dict(confirm), "funding_events": local_funding_events}


def build(root: Path, archive_start: dt.date, archive_end: dt.date, panel_start: dt.date,
          panel_end: dt.date, out: Path, min_daily_quote_usd: float):
    if out.exists():
        raise FileExistsError(out)
    if archive_start > panel_start - dt.timedelta(days=31):
        raise ValueError("Need at least 31 days of pre-window archives for a strict prior-30-day median")
    # Funding absence on a billing day is known only when the following
    # billing day is also complete, and that day's last settlement (00:00
    # UTC two days after panel_end) lives in archive day panel_end + 2.
    if archive_end < panel_end + dt.timedelta(days=2):
        raise ValueError("Two later UTC+8 archive days required: one closes the final UTC day, "
                         "one completes its funding-coverage neighbour")
    missing = [(d.isoformat(), name) for d in days(archive_start, archive_end)
               for name in MODULES if not file_at(root, name, d).exists()]
    if missing:
        raise FileNotFoundError(f"Archive sources missing: {len(missing)}; first {missing[:4]}")
    for d in days(archive_start, archive_end):
        receipt = json.loads((root / "receipts" / (d.isoformat() + ".json")).read_text())
        for name in MODULES:
            if sha_file(file_at(root, name, d)) != receipt[name]["sha256"]:
                raise ValueError(f"Source SHA differs from download receipt: {name} {d}")

    # A funding record in archive-day D+1 can settle the last UTC hour
    # of archive-day D. Pre-indexing avoids assigning it to the wrong bar.
    funding_clock_audit = {}
    funding, funding_known_days, funding_count = load_funding(
        root, days(archive_start, archive_end), funding_clock_audit)
    history = collections.defaultdict(lambda: collections.deque(maxlen=30))
    first_seen = {}
    current_day = None
    daily_volume = collections.defaultdict(float)
    output_count = 0
    eligible_rows = 0
    all_hours = 0
    audit = {"source_archive_days": (archive_end - archive_start).days + 1,
             "missing_archives": 0, "source_hourly_rows": 0, "incomplete_source_hours": 0,
             "missing_source_minutes": 0, "funding_events_observed": funding_count,
             "funding_unknown_rows": 0, "minute_confirm_flags": {},
             "funding_clock": funding_clock_audit, "funding_interval_coverage_certified": False,
             "identical_duplicate_rows_collapsed": 0,
             "quote_volume_unit": "USDT vol_quote",
             "historical_oi": "UNKNOWN: CSV oi left empty",
             "trailing_liquidity_rule": "median of 30 complete earlier UTC calendar days; zeros for absent days since first archive observation",
             "first_panel_utc": archive_start.isoformat(),
             "first_possible_eligible_utc": (archive_start + dt.timedelta(days=30)).isoformat(),
             "requested_main_window_utc": panel_start.isoformat(),
             "last_panel_utc": panel_end.isoformat(),
             "incomplete_hour_caveat": "Source gaps are counted, not classified as zero trades; investigate before freezing if material"}

    partial = out.with_suffix(out.suffix + ".part")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(partial, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(("ts", "symbol", "open", "high", "low", "close", "volume",
                        "eligible", "funding", "oi"))
            for archive_date in days(archive_start, archive_end):
                records, stats = aggregate_day(root, archive_date, funding)
                audit["identical_duplicate_rows_collapsed"] += stats["identical_duplicate_rows_collapsed"]
                audit["incomplete_source_hours"] += stats["incomplete_hours"]
                audit["missing_source_minutes"] += stats["missing_source_minutes"]
                for flag, count in stats["confirm_counts"].items():
                    audit["minute_confirm_flags"][flag] = audit["minute_confirm_flags"].get(flag, 0) + count
                for hour, sym, op, hi, lo, cl, vol, fr, minute_count in records:
                    day = dt.datetime.fromtimestamp(hour / 1000, tz=dt.timezone.utc).date()
                    # The exchange archive opens 16:00 UTC on the preceding
                    # calendar day. Discard that partial UTC pre-history day.
                    if not archive_start <= day <= panel_end:
                        continue
                    if current_day is None:
                        current_day = day
                    if day != current_day:
                        days_elapsed = (day - current_day).days
                        for k in range(days_elapsed):
                            for symbol in first_seen:
                                history[symbol].append(daily_volume.get(symbol, 0.0) if k == 0 else 0.0)
                            daily_volume.clear()
                        current_day = day
                    if sym not in first_seen:
                        first_seen[sym] = day
                    all_hours += 1
                    prev = history[sym]
                    enough = (day - first_seen[sym]).days >= 30 and len(prev) == 30
                    eligible = int(enough and statistics.median(prev) >= min_daily_quote_usd)
                    if eligible:
                        eligible_rows += 1
                    if fr is not None:
                        funding_cell = fr
                    elif (day, sym) in funding_known_days:
                        funding_cell = ""   # known: no settlement in this bar
                    else:
                        funding_cell = "NA" # absence unverified under the interval-consistency rule
                        audit["funding_unknown_rows"] += 1
                    w.writerow((hour, sym, op, hi, lo, cl, vol, eligible, funding_cell, ""))
                    output_count += 1
                    daily_volume[sym] += vol
        if output_count == 0:
            raise ValueError("No panel rows; check archive range")
        os.replace(partial, out)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    audit["source_hourly_rows"] = all_hours
    audit["panel_rows"] = output_count
    audit["eligible_rows"] = eligible_rows
    audit["panel_sha256"] = sha_file(out)
    audit["panel_bytes"] = out.stat().st_size
    atomic_bytes(out.with_suffix(".audit.json"), (json.dumps(audit, sort_keys=True, indent=2) + "\n").encode())
    print(json.dumps(audit, indent=2))

def main():
    p = argparse.ArgumentParser(description="OKX archive-to-hourly panel, research-only")
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("sync", "build"):
        sp = sub.add_parser(cmd)
        sp.add_argument("--root", type=Path, required=True, help="PRIVATE directory, outside Git")
        sp.add_argument("--archive-start", type=DATE, required=True)
        sp.add_argument("--archive-end", type=DATE, required=True)
        if cmd == "sync":
            sp.add_argument("--max-days", type=int, default=3)
            sp.add_argument("--max-new-bytes", type=int, default=DEFAULT_NEW_BYTES)
            sp.add_argument("--min-free-bytes", type=int, default=MIN_FREE_BYTES)
        else:
            sp.add_argument("--panel-start", type=DATE, required=True)
            sp.add_argument("--panel-end", type=DATE, required=True)
            sp.add_argument("--out", type=Path, required=True)
            sp.add_argument("--min-daily-quote-usd", type=float, default=5_000_000)
    args = p.parse_args()
    if args.cmd == "sync":
        sync(args.root, args.archive_start, args.archive_end, args.max_days,
             max_new_bytes=args.max_new_bytes, min_free_bytes=args.min_free_bytes)
    else:
        build(args.root, args.archive_start, args.archive_end, args.panel_start, args.panel_end,
              args.out, args.min_daily_quote_usd)


if __name__ == "__main__":
    main()
