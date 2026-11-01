"""Aggregate a finished hourly bench panel into UTC daily bars for fast research search.

Research only, stdlib only, streaming (memory grows only with contracts per day).
The daily file is small enough to share for an offline search run; it holds no
private data, but it is still market data: do not commit it to Git.

Per contract and UTC day D (bar ts = D 00:00 UTC):
- open: first observed hour's open; high/low: extremes; close: last observed hour's
  close; volume: sum of hourly quote volume.
- eligible: the hourly flag of that day. The builder computes it from the 30 previous
  UTC days only, so it is constant within a day; a day with mixed flags is an error.
- funding: sum of the day's settled rates; "NA" if any hourly cell is "NA"; empty when
  every hour is known and none settled.
- oi: last observed hour's value, empty if none.
A decision after the daily close at D therefore uses only information through D.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

HEADER = ["ts", "symbol", "open", "high", "low", "close", "volume", "eligible", "funding", "oi"]
DAY = 86_400_000


def _fmt(x: float) -> str:
    return repr(float(x))


def aggregate(src: Path, out: Path) -> dict:
    if out.exists():
        raise FileExistsError(out)
    open_days: dict = {}  # (day, symbol) -> [first_ts, open, high, low, last_ts, close, vol, elig, fsum, na, settled, oi_ts, oi, hours]
    newest = None
    written = hours_in = mixed = 0
    tmp = out.with_suffix(out.suffix + ".part")
    sha_in = hashlib.sha256()

    def flush(before, w):
        nonlocal written
        for key in sorted(k for k in open_days if k[0] < before):
            a = open_days.pop(key)
            if a[9]:
                fund = "NA"
            elif a[10]:
                fund = _fmt(a[8])
            else:
                fund = ""
            w.writerow((key[0], key[1], _fmt(a[1]), _fmt(a[2]), _fmt(a[3]), _fmt(a[5]), _fmt(a[6]), a[7], fund,
                        "" if a[12] is None else _fmt(a[12])))
            written += 1

    with open(src, "rb") as raw:
        for chunk in iter(lambda: raw.read(1 << 20), b""):
            sha_in.update(chunk)
    with open(src, newline="", encoding="utf-8") as fh, open(tmp, "w", newline="", encoding="utf-8") as fo:
        r, w = csv.reader(fh), csv.writer(fo, lineterminator="\n")
        if next(r, None) != HEADER:
            raise ValueError("source is not a bench hourly panel")
        w.writerow(HEADER)
        for row in r:
            ts, sym = int(row[0]), row[1]
            o, h, l, c, v = (float(x) for x in row[2:7])
            el, fund, oi = row[7], row[8], row[9]
            day = ts // DAY * DAY
            hours_in += 1
            if newest is None or day > newest:
                newest = day
                flush(day - DAY, w)  # a UTC day spans two exchange archive files
            a = open_days.get((day, sym))
            if a is None:
                a = open_days[(day, sym)] = [ts, o, h, l, ts, c, 0.0, el, 0.0, False, False, None, None, 0]
            else:
                if el != a[7]:
                    mixed += 1
                    raise ValueError(f"eligibility changes within a UTC day: {sym} {day}")
                if ts < a[0]:
                    a[0], a[1] = ts, o
                a[2], a[3] = max(a[2], h), min(a[3], l)
            if ts >= a[4]:
                a[4], a[5] = ts, c
            a[6] += v
            a[13] += 1
            if fund == "NA":
                a[9] = True
            elif fund != "":
                a[8] += float(fund)
                a[10] = True
            if oi != "" and (a[11] is None or ts >= a[11]):
                a[11], a[12] = ts, float(oi)
        flush(float("inf"), w)
    tmp.replace(out)
    sha_out = hashlib.sha256(out.read_bytes()).hexdigest()
    return {"source_panel_sha256": sha_in.hexdigest(), "daily_panel_sha256": sha_out,
            "hourly_rows": hours_in, "daily_rows": written}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Hourly bench panel -> UTC daily panel (research only)")
    ap.add_argument("--panel", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    if args.panel.suffix == ".part":
        raise SystemExit("source panel is not finished")
    print(json.dumps(aggregate(args.panel, args.out), indent=1))


if __name__ == "__main__":
    main()
