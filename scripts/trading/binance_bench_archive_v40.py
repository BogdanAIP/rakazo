"""Binance USD-M public monthly archives -> bench hourly panel (research only, stdlib only).

Second, independent exchange for Algorithm Discovery: its 2020-2023 years are an
earlier period the OKX search never saw. Same output schema and rules as the OKX
builder: every traded hour kept, `eligible` from the median daily quote volume of the
30 previous UTC days (and at least 30 days since the contract's first bar), funding
billed to the bar that ends at the settlement time, `NA` where absence of a settlement
cannot be inferred. Raw archives and receipts stay outside Git; never commit the panel.

Layout under --root (mirrors data.binance.vision):
  klines/<SYM>/<SYM>-1h-YYYY-MM.zip         + .CHECKSUM
  fundingRate/<SYM>/<SYM>-fundingRate-YYYY-MM.zip + .CHECKSUM
Only USDT perpetuals (symbol letters/digits ending in USDT, no delivery suffix).

Memory stays small: pass 1 handles one contract at a time and appends its rows to
monthly bucket files; pass 2 sorts one month at a time into the final CSV.
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
import re
import statistics
import zipfile
from pathlib import Path

import okx_bench_archive_v40 as okx

HOUR, DAY = okx.HOUR, okx.DAY
BASE = "https://data.binance.vision/data/futures/um/monthly"
SYMBOL = re.compile(r"[A-Z0-9]{1,30}USDT")
HEADER = ("ts", "symbol", "open", "high", "low", "close", "volume", "eligible", "funding", "oi")


def months(first: str, last: str):
    y, m = map(int, first.split("-"))
    ly, lm = map(int, last.split("-"))
    while (y, m) <= (ly, lm):
        yield f"{y:04d}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def archive_path(root: Path, kind: str, sym: str, month: str) -> Path:
    name = f"{sym}-1h-{month}.zip" if kind == "klines" else f"{sym}-fundingRate-{month}.zip"
    return root / kind / sym / name


def archive_url(kind: str, sym: str, month: str) -> str:
    if kind == "klines":
        return f"{BASE}/klines/{sym}/1h/{sym}-1h-{month}.zip"
    return f"{BASE}/fundingRate/{sym}/{sym}-fundingRate-{month}.zip"


def verify_checksum(zip_path: Path) -> str:
    """Official .CHECKSUM next to the ZIP: '<sha256>  <file name>'."""
    check = zip_path.with_name(zip_path.name + ".CHECKSUM")
    expected = check.read_text(encoding="utf-8").split()[0].lower()
    actual = okx.sha_file(zip_path)
    if actual != expected:
        raise ValueError(f"SHA mismatch against official checksum: {zip_path.name}")
    return actual


def sync(root: Path, symbols, first: str, last: str, fetch=okx.request_bytes, max_files: int = 10_000):
    """Download klines and funding ZIPs with their official checksums; skip files that
    already verify; record missing months (HTTP 404) without failing."""
    done = missing = 0
    log = []
    for sym in symbols:
        if not SYMBOL.fullmatch(sym):
            continue
        for month in months(first, last):
            for kind in ("klines", "fundingRate"):
                path = archive_path(root, kind, sym, month)
                if path.exists() and path.with_name(path.name + ".CHECKSUM").exists():
                    verify_checksum(path)
                    continue
                if done >= max_files:
                    return {"downloaded": done, "missing": missing, "stopped_at_cap": True, "log": log[-20:]}
                try:
                    payload = fetch(archive_url(kind, sym, month))
                    checksum = fetch(archive_url(kind, sym, month) + ".CHECKSUM")
                except Exception as exc:  # 404 for months before listing or after delisting
                    if "404" in str(exc):
                        missing += 1
                        continue
                    raise
                path.parent.mkdir(parents=True, exist_ok=True)
                okx.atomic_bytes(path.with_name(path.name + ".CHECKSUM"), checksum)
                okx.atomic_bytes(path, payload)
                verify_checksum(path)
                done += 1
                log.append(f"{kind} {sym} {month}")
    return {"downloaded": done, "missing": missing, "stopped_at_cap": False, "log": log[-20:]}


def _csv_rows(zip_path: Path):
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.endswith(".csv")]
        if len(names) != 1:
            raise ValueError(f"unexpected archive layout: {zip_path.name}")
        with z.open(names[0]) as raw:
            yield from csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def _ms(value: str) -> int:
    t = int(float(value))
    return t // 1000 if t > 10 ** 14 else t  # newer archives may use microseconds


def read_klines(zip_path: Path):
    """Yield (open_ms, o, h, l, c, quote_volume). Files with and without a header row."""
    for row in _csv_rows(zip_path):
        if not row or not row[0].strip().lstrip("-").replace(".", "").isdigit():
            continue  # header
        t = _ms(row[0])
        if t % HOUR:
            raise ValueError(f"kline not on the hour: {zip_path.name} {t}")
        o, h, l, c, qv = (float(row[i]) for i in (1, 2, 3, 4, 7))
        if min(o, h, l, c) <= 0 or qv < 0 or h < max(o, c, l) or l > min(o, c, h):
            raise ValueError(f"bad kline: {zip_path.name} {t}")
        yield t, o, h, l, c, qv


def read_funding(zip_path: Path):
    """Yield (settlement_ms, rate). Header names vary by era; detect columns by name."""
    it = _csv_rows(zip_path)
    header = next(it, None)
    if header is None:
        return
    names = [h.strip().lower() for h in header]
    if names and names[0].replace(".", "").isdigit():
        t_col, r_col, rows = 0, len(header) - 1, [header]
    else:
        t_col = next(i for i, n in enumerate(names) if "time" in n)
        r_col = next(i for i, n in enumerate(names) if "rate" in n)
        rows = []
    for row in rows + list(it):
        if not row:
            continue
        rate = float(row[r_col])
        if not math.isfinite(rate):
            raise ValueError(f"non-finite funding rate: {zip_path.name}")
        yield _ms(row[t_col]), rate


def contract_rows(root: Path, sym: str, first: str, last: str, usd: float, audit: dict):
    """All hourly rows for one contract, in time order, with eligibility and funding cells."""
    bars = {}
    for month in months(first, last):
        p = archive_path(root, "klines", sym, month)
        if p.exists():
            verify_checksum(p)
            for t, o, h, l, c, qv in read_klines(p):
                if t in bars:
                    if bars[t] != (o, h, l, c, qv):
                        raise ValueError(f"conflicting duplicate kline {sym} {t}")
                    audit["identical_duplicate_rows"] += 1
                    continue
                bars[t] = (o, h, l, c, qv)
    if not bars:
        return []
    events, off_clock, unsure_days = {}, 0, set()
    for month in months(first, last):
        p = archive_path(root, "fundingRate", sym, month)
        if p.exists():
            verify_checksum(p)
            for t, rate in read_funding(p):
                try:
                    bar = okx.nominal_funding_hour(t) - HOUR
                except ValueError:
                    # An off-clock record cannot be billed to a bar; neither neighbouring
                    # billing day may then claim "known: no settlement".
                    off_clock += 1
                    hour = t // HOUR * HOUR
                    for b in (hour - HOUR, hour):
                        unsure_days.add(dt.datetime.fromtimestamp(b / 1000, tz=dt.timezone.utc).date())
                    continue
                if bar in events and events[bar] != rate:
                    raise ValueError(f"conflicting funding settlement {sym} {t}")
                events[bar] = rate
    audit["funding_off_clock_events"] += off_clock
    audit["funding_events"] += len(events)
    known = {day for day, _ in okx.interval_consistent_funding_days(((b, sym) for b in events))} - unsure_days
    out = []
    daily = collections.defaultdict(float)
    for t, (_, _, _, _, qv) in bars.items():
        daily[t // DAY] += qv
    first_day = min(bars) // DAY
    for t in sorted(bars):
        o, h, l, c, qv = bars[t]
        day = t // DAY
        prev = [daily.get(d, 0.0) for d in range(day - 30, day)]
        eligible = int(day - first_day >= 30 and statistics.median(prev) >= usd)
        if t in events:
            fund = repr(events[t])
        elif dt.datetime.fromtimestamp(t / 1000, tz=dt.timezone.utc).date() in known:
            fund = ""
        else:
            fund = "NA"
            audit["funding_na_rows"] += 1
        audit["eligible_rows"] += eligible
        out.append((t, sym, repr(o), repr(h), repr(l), repr(c), repr(qv), eligible, fund, ""))
    return out


def build(root: Path, symbols, first: str, last: str, out: Path, usd: float = 5_000_000) -> dict:
    if out.exists():
        raise FileExistsError(out)
    work = out.with_name(out.name + ".buckets")
    work.mkdir(parents=True, exist_ok=False)
    audit = collections.Counter()
    contracts = 0
    for sym in sorted(s for s in symbols if SYMBOL.fullmatch(s)):
        rows = contract_rows(root, sym, first, last, usd, audit)
        if not rows:
            continue
        contracts += 1
        by_month = collections.defaultdict(list)
        for r in rows:
            by_month[dt.datetime.fromtimestamp(r[0] / 1000, tz=dt.timezone.utc).strftime("%Y-%m")].append(r)
        for month, chunk in by_month.items():
            with open(work / f"{month}.csv", "a", newline="", encoding="utf-8") as fh:
                csv.writer(fh, lineterminator="\n").writerows(chunk)
    part = out.with_name(out.name + ".part")
    rows = 0
    with open(part, "w", newline="", encoding="utf-8") as fo:
        w = csv.writer(fo, lineterminator="\n")
        w.writerow(HEADER)
        for month in months(first, last):
            bucket = work / f"{month}.csv"
            if not bucket.exists():
                continue
            with open(bucket, newline="", encoding="utf-8") as fh:
                chunk = sorted(csv.reader(fh), key=lambda r: (int(r[0]), r[1]))
            for a, b in zip(chunk, chunk[1:]):
                if a[0] == b[0] and a[1] == b[1]:
                    raise ValueError(f"duplicate bar {a[1]} {a[0]}")
            w.writerows(chunk)
            rows += len(chunk)
            bucket.unlink()
    work.rmdir()
    os.replace(part, out)
    result = {"contracts": contracts, "panel_rows": rows, "panel_sha256": okx.sha_file(out),
              "first_month": first, "last_month": last, "eligibility_usd": usd,
              "quote_volume_unit": "USDT quote volume (kline column 8)", **dict(audit)}
    okx.atomic_bytes(out.with_suffix(".audit.json"), (json.dumps(result, indent=2, sort_keys=True) + "\n").encode())
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description="Binance USD-M archives -> bench hourly panel (research only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("sync", "build"):
        p = sub.add_parser(name)
        p.add_argument("--root", type=Path, required=True, help="PRIVATE directory outside Git")
        p.add_argument("--symbols-file", type=Path, required=True, help="one historical USDT perpetual per line")
        p.add_argument("--first-month", required=True)
        p.add_argument("--last-month", required=True)
        if name == "sync":
            p.add_argument("--max-files", type=int, default=10_000)
        else:
            p.add_argument("--out", type=Path, required=True)
            p.add_argument("--min-daily-quote-usd", type=float, default=5_000_000)
    args = ap.parse_args(argv)
    symbols = [s.strip() for s in args.symbols_file.read_text().splitlines() if s.strip()]
    if args.cmd == "sync":
        print(json.dumps(sync(args.root, symbols, args.first_month, args.last_month, max_files=args.max_files), indent=1))
    else:
        print(json.dumps(build(args.root, symbols, args.first_month, args.last_month, args.out,
                               args.min_daily_quote_usd), indent=1))


if __name__ == "__main__":
    main()
