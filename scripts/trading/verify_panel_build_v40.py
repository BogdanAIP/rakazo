"""Post-build verification of a finished OKX hourly panel, before bench audit and freeze.

Research only, stdlib only, streaming: memory stays small whatever the panel size.
Run it only after the builder has atomically renamed the .part file and written the
.audit.json next to the panel. Exit code 0 means PROCEED, 2 means STOP (reasons listed).

Checks
- the panel file SHA, row count and eligible-row count match the builder's audit JSON;
- the header is exactly the bench schema;
- eligible-row funding NA share, overall and split into contracts flagged for varying
  funding cadence versus the rest, against the owner's 5% gate;
- audit funding-clock counters (off-hour unavailable markers, outside-window events);
- missing source minutes as a share of panel minutes, against the owner's 0.1% gate.

Flagged contracts: pass --flagged-symbols FILE (one symbol per line), or let the
verifier recompute them from the panel: a contract is flagged when its count of settled
bars differs across UTC days on which it has 24 bars and no NA funding cell.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

HEADER = ["ts", "symbol", "open", "high", "low", "close", "volume", "eligible", "funding", "oi"]
DAY = 86_400_000


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan(panel: Path):
    """One pass. Returns totals and per-contract eligible NA counts plus cadence flags."""
    rows = eligible = 0
    na_by_symbol, eligible_by_symbol = defaultdict(int), defaultdict(int)
    open_days = {}  # (day, symbol) -> [bars, settled, any_na]
    counts_by_symbol = defaultdict(set)
    newest_day = None

    def close_days(before):
        for key in [k for k in open_days if k[0] < before]:
            bars, settled, any_na = open_days.pop(key)
            if bars == 24 and not any_na:
                counts_by_symbol[key[1]].add(settled)

    with open(panel, newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if header != HEADER:
            raise ValueError(f"unexpected header {header}")
        for row in reader:
            ts, sym, el, fund = int(row[0]), row[1], row[7], row[8]
            rows += 1
            day = ts // DAY
            if newest_day is None or day > newest_day:
                newest_day = day
                close_days(day - 1)  # a UTC day spans two exchange archive days
            acc = open_days.setdefault((day, sym), [0, 0, False])
            acc[0] += 1
            if fund == "NA":
                acc[2] = True
            elif fund != "":
                acc[1] += 1
            if el == "1":
                eligible += 1
                eligible_by_symbol[sym] += 1
                if fund == "NA":
                    na_by_symbol[sym] += 1
    close_days(float("inf"))
    flagged = {s for s, c in counts_by_symbol.items() if len(c) > 1}
    return rows, eligible, na_by_symbol, eligible_by_symbol, flagged


def share(num, den):
    return num / den if den else 0.0


def verify(panel: Path, audit_path: Path, flagged_file: Path | None, max_na: float, max_missing: float,
           expect_off_hour: int | None, expect_outside: int | None) -> dict:
    audit = json.loads(audit_path.read_text())
    reasons = []
    digest = sha256_file(panel)
    if digest != audit.get("panel_sha256"):
        reasons.append("panel SHA differs from the builder audit")
    rows, eligible, na_by, el_by, recomputed = scan(panel)
    if rows != audit.get("panel_rows"):
        reasons.append(f"panel rows {rows} != audit {audit.get('panel_rows')}")
    if eligible != audit.get("eligible_rows"):
        reasons.append(f"eligible rows {eligible} != audit {audit.get('eligible_rows')}")
    if flagged_file is not None:
        flagged = {line.strip() for line in flagged_file.read_text().splitlines() if line.strip()}
        source = "file"
    else:
        flagged, source = recomputed, "recomputed from panel"
    na_all = sum(na_by.values())
    na_f = sum(v for s, v in na_by.items() if s in flagged)
    el_f = sum(v for s, v in el_by.items() if s in flagged)
    out = {
        "panel_sha256": digest,
        "panel_rows": rows,
        "eligible_rows": eligible,
        "eligible_funding_na_rows": na_all,
        "eligible_funding_na_share": share(na_all, eligible),
        "flagged_source": source,
        "flagged_contracts": len(flagged),
        "flagged_recomputed_from_panel": len(recomputed),
        "flagged_eligible_rows": el_f,
        "flagged_eligible_na_share": share(na_f, el_f),
        "other_eligible_rows": eligible - el_f,
        "other_eligible_na_share": share(na_all - na_f, eligible - el_f),
        "worst_contracts_by_eligible_na": sorted(
            ((s, na_by[s], el_by[s]) for s in na_by), key=lambda x: -x[1])[:10],
    }
    if out["eligible_funding_na_share"] > max_na:
        reasons.append(f"eligible funding NA share {out['eligible_funding_na_share']:.4%} > {max_na:.2%}")
    clock = audit.get("funding_clock", {})
    out["unavailable_off_hour_markers"] = clock.get("unavailable_off_hour_markers")
    out["outside_window_events"] = clock.get("outside_window_events")
    if expect_off_hour is not None and clock.get("unavailable_off_hour_markers") != expect_off_hour:
        reasons.append(f"off-hour markers {clock.get('unavailable_off_hour_markers')} != expected {expect_off_hour}")
    if expect_outside is not None and clock.get("outside_window_events") != expect_outside:
        reasons.append(f"outside-window events {clock.get('outside_window_events')} != expected {expect_outside}")
    missing = audit.get("missing_source_minutes", 0)
    out["missing_minute_share_of_panel"] = share(missing, rows * 60)
    if out["missing_minute_share_of_panel"] > max_missing:
        reasons.append(f"missing minutes {out['missing_minute_share_of_panel']:.4%} > {max_missing:.2%}")
    out["verdict"] = "STOP" if reasons else "PROCEED"
    out["reasons"] = reasons
    out["checked_at_utc"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Verify a finished hourly panel before audit and freeze (research only)")
    ap.add_argument("--panel", type=Path, required=True)
    ap.add_argument("--audit", type=Path, help="builder audit JSON (default: PANEL with .audit.json)")
    ap.add_argument("--flagged-symbols", type=Path)
    ap.add_argument("--max-eligible-na", type=float, default=0.05)
    ap.add_argument("--max-missing-minutes", type=float, default=0.001)
    ap.add_argument("--expect-off-hour-markers", type=int, default=3)
    ap.add_argument("--expect-outside-window", type=int, default=3)
    args = ap.parse_args(argv)
    if args.panel.suffix == ".part" or not args.panel.exists():
        raise SystemExit("panel is not a finished file")
    audit = args.audit or args.panel.with_suffix(".audit.json")
    result = verify(args.panel, audit, args.flagged_symbols, args.max_eligible_na, args.max_missing_minutes,
                    args.expect_off_hour_markers, args.expect_outside_window)
    print(json.dumps(result, indent=1))
    sys.exit(0 if result["verdict"] == "PROCEED" else 2)


if __name__ == "__main__":
    main()
