#!/usr/bin/env python3
"""Alpha Discovery v4: bounded, resumable OKX public-history backfill.

Only one explicit operator-invoked bounded batch. No automated retries,
scheduler, private keys, authenticated endpoints, PAPER or real orders.
Downloaded pages are immutable and checked at each resume. Fail closed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from okx_dataset import INTERVAL_MS, SYMBOL, export_snapshot, parse_pages

SCHEMA = "alpha_public_backfill_v4"
MAX_NEW_PAGES = 5
PAGE_LIMIT = 100
MIN_SPACING_SECONDS = 2.5
MIN_REQUIRED_BARS = 8640
MAX_TOTAL_PAGES = 120


class RateLimited(Exception):
    """A single 429 stops this manual batch without retrying."""


def packed(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode("utf-8")


def sha(obj):
    return hashlib.sha256(packed(obj)).hexdigest()


def request_public(symbol, cursor, limit):
    if not SYMBOL.fullmatch(symbol) or not 1 <= limit <= PAGE_LIMIT:
        raise ValueError("Invalid public data request")
    if cursor is not None and not re.fullmatch(r"\d{13}", cursor):
        raise ValueError("Invalid history cursor")
    helper = Path(__file__).with_name("okx_public_page.mjs")
    result = subprocess.run(
        ["node", str(helper), symbol, cursor if cursor else "-", str(limit)],
        capture_output=True, text=True, timeout=15, check=False
    )
    if result.returncode:
        if "HTTP_429" in result.stderr:
            raise RateLimited("HTTP 429: rate-limited; do not retry during this batch")
        raise ValueError("OKX public request failed: " + result.stderr.strip()[:120])
    if len(result.stdout.encode("utf-8")) > 262_144:
        raise ValueError("History response too large")
    return json.loads(result.stdout)


def validate_page(payload, cursor, as_of):
    if not isinstance(payload, dict) or payload.get("code") != "0":
        raise ValueError("Unexpected OKX API status")
    rows = payload.get("data")
    if not isinstance(rows, list) or not 1 <= len(rows) <= PAGE_LIMIT:
        raise ValueError("Invalid page count")
    previous_stamp = None
    closed = 0
    seen = set()
    as_of_ms = int(datetime.fromisoformat(as_of).timestamp() * 1000)
    for row in rows:
        if not isinstance(row, list) or len(row) != 9:
            raise ValueError("Wrong OKX candle structure")
        if not isinstance(row[0], str) or not re.fullmatch(r"\d{13}", row[0]):
            raise ValueError("Invalid opening timestamp")
        stamp = int(row[0])
        if stamp % INTERVAL_MS or (previous_stamp is not None and stamp >= previous_stamp):
            raise ValueError("Unaligned or unsorted page")
        if cursor is not None and stamp >= int(cursor):
            raise ValueError("Page did not advance backwards")
        previous_stamp = stamp
        if row[8] not in ("0", "1"):
            raise ValueError("Invalid bar confirmation")
        if row[8] == "1" and stamp + INTERVAL_MS > as_of_ms:
            raise ValueError("Closed bar later than capture time")
        import math
        values = [float(row[x]) for x in (1, 2, 3, 4, 7)]
        if not all(math.isfinite(v) for v in values):
            raise ValueError("Non-finite candle price/volume")
        op, hi, lo, close, vol = values
        if min(op, hi, lo, close) <= 0 or vol < 0 or not lo <= min(op, close) <= max(op, close) <= hi:
            raise ValueError("Invalid candle values")
        if stamp in seen:
            raise ValueError("Duplicate timestamp")
        seen.add(stamp)
        closed += (row[8] == "1")
    return {"oldest": rows[-1][0], "newest": rows[0][0],
            "rows": len(rows), "closed": closed}


def read_session(directory):
    file = directory / "session.json"
    session = json.loads(file.read_text(encoding="utf-8"))
    if (session.get("schema") != SCHEMA or
            not SYMBOL.fullmatch(session.get("symbol", "")) or
            session.get("limit") != PAGE_LIMIT or
            session.get("capture_as_of") is None):
        raise ValueError("Invalid backfill session")
    clock = datetime.fromisoformat(session["capture_as_of"])
    if clock.tzinfo is None or clock.utcoffset() != timedelta(0):
        raise ValueError("Capture time is not UTC")
    return session


def initialize(directory, symbol, as_of=None):
    directory = Path(directory)
    if not SYMBOL.fullmatch(symbol):
        raise ValueError("Invalid USDT-SWAP symbol")
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / "session.json"
    if file.exists():
        session = read_session(directory)
        if session["symbol"] != symbol:
            raise ValueError("Session belongs to a different instrument")
        return session
    # Refuse creating a new session inside an unexplained directory.
    if list(directory.iterdir()):
        raise ValueError("Refusing to start in a non-empty directory")
    as_of = as_of or datetime.now(timezone.utc)
    if as_of.tzinfo is None or as_of.utcoffset() != timedelta(0):
        raise ValueError("Capture clock must be UTC")
    session = {"schema": SCHEMA, "symbol": symbol, "limit": PAGE_LIMIT,
               "capture_as_of": as_of.isoformat(),
               "source": "OKX_PUBLIC_GET", "requires_manual_invocation": True}
    with file.open("x", encoding="utf-8") as handle:
        json.dump(session, handle, sort_keys=True, indent=2)
        handle.write("\n")
    return session


def scan(directory, session):
    """Recompute all cursor positions and byte digests; no trust in cached state."""
    files = sorted(directory.glob("page-*.json"))
    if len(files) > MAX_TOTAL_PAGES:
        raise ValueError("Too many pages")
    expected = [f"page-{i:04d}.json" for i in range(len(files))]
    if [p.name for p in files] != expected:
        raise ValueError("Incomplete or modified page sequence")
    # Anchor even the first request to the original immutable capture time.
    # A retry after 429 must NOT silently change the historical universe.
    cursor = str(int(datetime.fromisoformat(session["capture_as_of"]).timestamp() * 1000))
    pages, receipts = [], []
    all_confirmed = []
    for idx, file in enumerate(files):
        envelope = json.loads(file.read_text(encoding="utf-8"))
        if envelope.get("page_no") != idx:
            raise ValueError("Page index mismatch")
        payload = envelope.get("payload")
        if sha(payload) != envelope.get("payload_sha256"):
            raise ValueError("Historical page checksum mismatch")
        meta = validate_page(payload, cursor, session["capture_as_of"])
        if meta != envelope.get("meta"):
            raise ValueError("Page receipt altered")
        cursor = meta["oldest"]
        pages.append(payload)
        receipts.append({"page": idx, **meta, "sha256": envelope["payload_sha256"]})
        all_confirmed.extend(int(row[0]) for row in payload["data"] if row[8] == "1")
    if len(all_confirmed) != len(set(all_confirmed)):
        raise ValueError("Duplicate confirmed candles")
    # Deliberately refuse missing candles, not silently fill with an estimate.
    ordered = sorted(all_confirmed)
    if any(b - a != INTERVAL_MS for a, b in zip(ordered, ordered[1:])):
        raise ValueError("Historical candles contain gaps")
    return pages, receipts, cursor, len(all_confirmed)


def backfill(directory, symbol, max_new_pages=1, fetcher=request_public,
             sleeper=time.sleep, min_spacing=MIN_SPACING_SECONDS, as_of=None):
    if not 1 <= max_new_pages <= MAX_NEW_PAGES:
        raise ValueError("Manual batch must be 1..5 pages")
    if min_spacing < MIN_SPACING_SECONDS:
        raise ValueError("Below published conservative delay; refusing")
    directory = Path(directory)
    session = initialize(directory, symbol, as_of)
    pages, receipts, cursor, closed_bars = scan(directory, session)
    new_pages = 0
    status = "BATCH_COMPLETE"
    if len(pages) >= MAX_TOTAL_PAGES:
        status = "MAX_PAGE_LIMIT"
    else:
        for k in range(min(max_new_pages, MAX_TOTAL_PAGES-len(pages))):
            if k:
                sleeper(min_spacing)
            try:
                payload = fetcher(symbol, cursor, PAGE_LIMIT)
            except RateLimited:
                status = "RATE_LIMITED_STOPPED_NO_RETRY"
                break
            meta = validate_page(payload, cursor, session["capture_as_of"])
            idx = len(pages)
            envelope = {"page_no": idx, "payload": payload,
                        "payload_sha256": sha(payload), "meta": meta}
            file = directory / f"page-{idx:04d}.json"
            with file.open("x", encoding="utf-8") as handle:
                json.dump(envelope, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
            pages.append(payload)
            cursor = meta["oldest"]
            new_pages += 1
            closed_bars += meta["closed"]
    # Full verification on completion of every batch, not just first load.
    pages, receipts, cursor, closed_bars = scan(directory, session)
    return {"status": status, "symbol": symbol, "pages_saved": len(pages),
            "new_pages_saved": new_pages, "closed_bars": closed_bars,
            "required_bars": MIN_REQUIRED_BARS,
            "ready_to_finalize": closed_bars >= MIN_REQUIRED_BARS,
            "oldest_cursor": cursor, "research_only": True}


def finalize(directory, symbol, output):
    directory, output = Path(directory), Path(output)
    session = read_session(directory)
    if session["symbol"] != symbol:
        raise ValueError("Finalizer symbol mismatch")
    pages, receipts, _, count = scan(directory, session)
    if count < MIN_REQUIRED_BARS:
        raise ValueError("Not enough verified closed bars; cannot finalize")
    candles, original_receipts = parse_pages(
        pages, symbol, datetime.fromisoformat(session["capture_as_of"]), PAGE_LIMIT
    )
    if len(candles) != count:
        raise ValueError("Final validation mismatch")
    return export_snapshot(
        candles, original_receipts, symbol,
        datetime.fromisoformat(session["capture_as_of"]), output,
        source="public_get"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--session", type=Path, required=True)
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--finalize", type=Path, help="New immutable CSV path; offline only")
    args = ap.parse_args()
    if args.finalize:
        m = finalize(args.session, args.symbol, args.finalize)
        result = {"status": "IMMUTABLE_SNAPSHOT_FINALIZED", "symbol": args.symbol,
                  "bars": m["closed_bars"], "sha256": m["csv_sha256"]}
    else:
        result = backfill(args.session, args.symbol, max_new_pages=args.pages)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
