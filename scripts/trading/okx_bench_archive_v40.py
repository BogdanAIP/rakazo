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
import os
import statistics
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


def days(first, last):
    day = first
    while day <= last:
        yield day
        day += dt.timedelta(days=1)


def request_bytes(url: str) -> bytes:
    for attempt in range(7):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45) as response:
                return response.read()
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


def sync(root: Path, start: dt.date, end: dt.date, max_days: int):
    root.mkdir(parents=True, exist_ok=True)
    processed = 0
    for day in days(start, end):
        receipt = root / "receipts" / (day.isoformat() + ".json")
        current = json.loads(receipt.read_text()) if receipt.exists() else {}
        missing = [name for name in MODULES if not file_at(root, name, day).exists()]
        if not missing:
            continue
        if processed >= max_days:
            break
        for name in missing:
            url = source_url(name, day)
            data = request_bytes(url)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if len(archive.namelist()) != 1 or not archive.namelist()[0].endswith(".csv"):
                    raise ValueError(f"Unexpected ZIP contents: {name} {day}")
                if archive.testzip() is not None:
                    raise ValueError(f"Corrupted archive: {name} {day}")
            atomic_bytes(file_at(root, name, day), data)
            current[name] = {"official_url": url, "sha256": sha(data), "zip_bytes": len(data)}
            atomic_bytes(receipt, (json.dumps(current, sort_keys=True, indent=2) + "\n").encode())
            time.sleep(0.55)  # Stay below OKX index rate cap (5 requests per 2 seconds).
        processed += 1
        print(json.dumps({"archive_day": day.isoformat(), "modules": list(current), "status": "downloaded"}), flush=True)
    total = sum(1 for d in days(start, end) if all(file_at(root, x, d).exists() for x in MODULES))
    print(json.dumps({"complete_archive_days": total, "required_archive_days": (end - start).days + 1}, indent=2))


def read_zip_rows(path: Path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != 1 or not names[0].endswith(".csv"):
            raise ValueError(f"Unexpected source layout: {path.name}")
        with archive.open(names[0]) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            yield from reader


def aggregate_day(root: Path, day: dt.date):
    by_hour = {}
    minutes_seen = set()
    confirm = collections.Counter()
    for row in read_zip_rows(file_at(root, "candles", day)):
        symbol = row["instrument_name"]
        if not symbol.endswith("-USDT-SWAP"):
            continue
        minute = int(row["open_time"])
        if minute % 60_000:
            raise ValueError(f"Not minute aligned: {symbol} {minute}")
        key_min = (minute, symbol)
        if key_min in minutes_seen:
            raise ValueError(f"Duplicate minute {symbol} {minute}")
        minutes_seen.add(key_min)
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
    funding = collections.defaultdict(float)
    for row in read_zip_rows(file_at(root, "funding", day)):
        symbol = row["instrument_name"]
        if symbol.endswith("-USDT-SWAP"):
            timestamp = int(row["funding_time"])
            funding[(timestamp // HOUR * HOUR, symbol)] += float(row["funding_rate"])
    incomplete = 0
    out = []
    for (hour, sym), acc in sorted(by_hour.items()):
        if acc[7] != 60 or acc[0] != hour or acc[1] != hour + 59 * 60_000:
            incomplete += 1
            continue
        out.append((hour, sym, acc[2], acc[3], acc[4], acc[5], acc[6], funding.get((hour, sym))))
    return out, {"archive_date": day.isoformat(), "usable_hours": len(out),
                 "incomplete_hours": incomplete, "confirm_counts": dict(confirm),
                 "funding_events": len(funding)}


def build(root: Path, archive_start: dt.date, archive_end: dt.date, panel_start: dt.date,
          panel_end: dt.date, out: Path, min_daily_quote_usd: float):
    if out.exists():
        raise FileExistsError(out)
    if archive_start > panel_start - dt.timedelta(days=31):
        raise ValueError("Need at least 31 days of pre-window archives for a strict prior-30-day median")
    if archive_end < panel_end + dt.timedelta(days=1):
        raise ValueError("One later UTC+8 archive day required to close the final UTC calendar day")
    missing = [(d.isoformat(), name) for d in days(archive_start, archive_end)
               for name in MODULES if not file_at(root, name, d).exists()]
    if missing:
        raise FileNotFoundError(f"Archive sources missing: {len(missing)}; first {missing[:4]}")
    for d in days(archive_start, archive_end):
        receipt = json.loads((root / "receipts" / (d.isoformat() + ".json")).read_text())
        for name in MODULES:
            if sha_file(file_at(root, name, d)) != receipt[name]["sha256"]:
                raise ValueError(f"Source SHA differs from download receipt: {name} {d}")
    history = collections.defaultdict(lambda: collections.deque(maxlen=30))
    first_seen = {}
    current_day = None
    daily_volume = collections.defaultdict(float)
    output_count = 0
    all_hours = 0
    audit = {"source_archive_days": (archive_end - archive_start).days + 1,
             "missing_archives": 0, "source_hourly_rows": 0, "incomplete_source_hours": 0,
             "funding_events_observed": 0, "minute_confirm_flags": {}, "quote_volume_unit": "USDT vol_quote",
             "historical_oi": "UNKNOWN: CSV oi left empty",
             "trailing_liquidity_rule": "median of 30 complete earlier UTC calendar days; zeros for missing days after first listing",
             "first_eligible_utc": panel_start.isoformat(), "last_eligible_utc": panel_end.isoformat()}
    partial = out.with_suffix(out.suffix + ".part")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(partial, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(("ts", "symbol", "open", "high", "low", "close", "volume", "funding", "oi"))
            for archive_date in days(archive_start, archive_end):
                records, stats = aggregate_day(root, archive_date)
                audit["incomplete_source_hours"] += stats["incomplete_hours"]
                audit["funding_events_observed"] += stats["funding_events"]
                for flag, count in stats["confirm_counts"].items():
                    audit["minute_confirm_flags"][flag] = audit["minute_confirm_flags"].get(flag, 0) + count
                for hour, sym, op, hi, lo, cl, vol, fr in records:
                    day = dt.datetime.fromtimestamp(hour / 1000, tz=dt.timezone.utc).date()
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
                    if panel_start <= day <= panel_end:
                        prev = history[sym]
                        enough_history = (day - first_seen[sym]).days >= 30 and len(prev) == 30
                        if enough_history and statistics.median(prev) >= min_daily_quote_usd:
                            w.writerow((hour, sym, op, hi, lo, cl, vol, "" if fr is None else fr, ""))
                            output_count += 1
                    daily_volume[sym] += vol
        if audit["incomplete_source_hours"]:
            raise ValueError(f"Missing minute data in {audit['incomplete_source_hours']} hourly bars; refuse freeze")
        if output_count == 0:
            raise ValueError("No eligible panel rows; check dates and liquidity rule")
        os.replace(partial, out)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    audit["source_hourly_rows"] = all_hours
    audit["panel_rows"] = output_count
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
        else:
            sp.add_argument("--panel-start", type=DATE, required=True)
            sp.add_argument("--panel-end", type=DATE, required=True)
            sp.add_argument("--out", type=Path, required=True)
            sp.add_argument("--min-daily-quote-usd", type=float, default=5_000_000)
    args = p.parse_args()
    if args.cmd == "sync":
        sync(args.root, args.archive_start, args.archive_end, args.max_days)
    else:
        build(args.root, args.archive_start, args.archive_end, args.panel_start, args.panel_end,
              args.out, args.min_daily_quote_usd)


if __name__ == "__main__":
    main()
