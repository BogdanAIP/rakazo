#!/usr/bin/env python3
"""Read-only OKX 15m research snapshot collector (public GET or offline fixture).

No private endpoints, keys, order writes, automated recurrence or PAPER access.
This is a data-preparation utility, NOT a futures execution simulator.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

ORIGIN = "https://www.okx.com"
PATH = "/api/v5/market/history-candles"
INTERVAL_MS = 900_000
MAX_BODY = 262_144
MAX_PAGES = 30
MAX_LIMIT = 100
SYMBOL = re.compile(r"^[A-Z0-9]+-USDT-SWAP$")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ValueError("Redirects forbidden in public data collector")


def public_page(inst_id: str, cursor: str | None, limit: int):
    if not SYMBOL.fullmatch(inst_id):
        raise ValueError("Only USDT perpetual instruments are supported")
    if not 1 <= limit <= MAX_LIMIT:
        raise ValueError("Invalid page limit")
    query = {"instId": inst_id, "bar": "15m", "limit": str(limit)}
    if cursor is not None:
        if not cursor.isdecimal():
            raise ValueError("Non-numeric history cursor")
        query["after"] = cursor
    url = ORIGIN + PATH + "?" + urlencode(query)
    opener = build_opener(NoRedirect())
    with opener.open(Request(url, headers={"Accept": "application/json"},
                                    method="GET"), timeout=10) as response:
        if response.status != 200 or response.geturl().split("?")[0] != ORIGIN + PATH:
            raise ValueError("Unexpected public API response")
        data = response.read(MAX_BODY + 1)
        if len(data) > MAX_BODY:
            raise ValueError("Oversized history page")
    return json.loads(data.decode("utf-8"))


def parse_pages(pages, inst_id: str, as_of: datetime, limit: int):
    """Validate OKX pages, pagination and completed bars; reject gaps/collisions."""
    if not SYMBOL.fullmatch(inst_id):
        raise ValueError("Invalid perpetual instrument")
    if as_of.tzinfo is None or as_of.utcoffset() != timedelta(0):
        raise ValueError("as_of must be UTC")
    as_of_ms = int(as_of.timestamp() * 1000)
    candles: dict[int, tuple] = {}
    provenance = []
    previous_oldest = None
    for idx, payload in enumerate(pages):
        if not isinstance(payload, dict) or payload.get("code") != "0" or not isinstance(payload.get("data"), list):
            raise ValueError("Invalid OKX status/data")
        page = payload["data"]
        if not page or len(page) > limit:
            raise ValueError("Empty or oversized page")
        payload_digest = hashlib.sha256(json.dumps(payload, sort_keys=True,
                        separators=(",", ":")).encode()).hexdigest()
        stamps = []
        confirmed = 0
        for row in page:
            if not isinstance(row, list) or len(row) != 9 or row[8] not in ("0", "1"):
                raise ValueError("Unexpected OKX 9-field candle")
            if not isinstance(row[0], str) or not re.fullmatch(r"\d{13}", row[0]):
                raise ValueError("Bad epoch")
            stamp = int(row[0])
            if stamp % INTERVAL_MS:
                raise ValueError("Misaligned 15m candle")
            if stamps and stamp >= stamps[-1]:
                raise ValueError("OKX page not newest-first")
            if previous_oldest is not None and stamp >= previous_oldest:
                raise ValueError("Page overlap or bad after cursor")
            stamps.append(stamp)
            price_values = [float(x) for x in row[1:5]]
            volume = float(row[7])  # volCcyQuote, NOT contracts (vol)
            op, hi, lo, cl = price_values
            if not all(math.isfinite(v) for v in price_values + [volume]):
                raise ValueError("Non-finite market values")
            if min(price_values) <= 0 or volume < 0 or not lo <= min(op, cl) <= max(op, cl) <= hi:
                raise ValueError("Invalid OHLCV")
            if row[8] == "0":
                continue
            if stamp + INTERVAL_MS > as_of_ms:
                raise ValueError("Prematurely confirmed candle")
            if stamp in candles:
                raise ValueError("Duplicate closed candle")
            candles[stamp] = (stamp, op, hi, lo, cl, volume, inst_id)
            confirmed += 1
        previous_oldest = stamps[-1]
        provenance.append({"page": idx + 1, "rows": len(page), "confirmed": confirmed,
                           "newest_open_ms": stamps[0], "oldest_open_ms": stamps[-1],
                           "payload_sha256": payload_digest})
    ordered = [candles[s] for s in sorted(candles)]
    if len(ordered) < 480:
        raise ValueError("Insufficient confirmed continuous 15m candles (<480)")
    for prior, following in zip(ordered, ordered[1:]):
        if following[0] - prior[0] != INTERVAL_MS:
            raise ValueError("Gap in historical candles; refuse inaccurate backtest")
    return ordered, provenance


def collect(inst_id, as_of, page_limit=100, page_count=8, fetcher=public_page,
            offline_pages=None):
    if not 1 <= page_count <= MAX_PAGES or not 1 <= page_limit <= MAX_LIMIT:
        raise ValueError("Invalid request bounds")
    if not SYMBOL.fullmatch(inst_id):
        raise ValueError("Invalid market")
    pages, cursor = [], None
    if offline_pages is not None:
        if not isinstance(offline_pages, list) or not 1 <= len(offline_pages) <= page_count:
            raise ValueError("Fixture pages mismatch")
        pages = offline_pages
    else:
        for i in range(page_count):
            page = fetcher(inst_id, cursor, page_limit)
            if not isinstance(page, dict) or not page.get("data"):
                break
            pages.append(page)
            last_row = page["data"][-1]
            if not isinstance(last_row, list) or not last_row:
                raise ValueError("Invalid cursor response")
            previous = cursor
            cursor = last_row[0]
            if previous is not None and int(cursor) >= int(previous):
                raise ValueError("Cursor failed to advance backwards")
            if len(page["data"]) < page_limit:
                break
            if i + 1 < page_count:
                time.sleep(0.15)
    if not pages:
        raise ValueError("No history pages")
    candles, receipts = parse_pages(pages, inst_id, as_of, page_limit)
    return candles, receipts


def export_snapshot(candles, receipts, inst_id, as_of, output_csv: Path,
                    source: str):
    """Two files created exclusively, with independent byte-identity receipt."""
    output_csv = Path(output_csv)
    if output_csv.suffix.lower() != ".csv":
        raise ValueError("Output must be .csv")
    metadata_file = output_csv.with_suffix(".manifest.json")
    if output_csv.exists() or metadata_file.exists():
        raise FileExistsError("Snapshots are immutable; use a new output name")
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["timestamp", "open", "high", "low", "close", "volume", "symbol"])
    for stamp, op, hi, lo, close, vol, symbol in candles:
        writer.writerow([datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat(),
                         op, hi, lo, close, vol, symbol])
    data = buffer.getvalue().encode("utf-8")
    manifest = {
        "format": "okx_public_15m_research_v1",
        "source": source,
        "source_attestation": "unverified public HTTP response" if source == "public_get" else "OFFLINE_FIXTURE_NOT_EXCHANGE_DATA",
        "symbol": inst_id, "candle_interval_minutes": 15,
        "captured_as_of_utc": as_of.isoformat(),
        "first_open_ms": candles[0][0], "last_open_ms": candles[-1][0],
        "closed_bars": len(candles), "pages": receipts,
        "csv_sha256": hashlib.sha256(data).hexdigest(),
        "note": "Opening timestamps. Confirm=1, UTC as_of check; no funding, liquidation, book, or fill model.",
    }
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("xb") as handle:
        handle.write(data)
    try:
        with metadata_file.open("x", encoding="utf-8") as handle:
            json.dump(manifest, handle, sort_keys=True, indent=2)
            handle.write("\n")
    except Exception:
        output_csv.unlink()
        raise
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--pages", type=int, default=8)
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--offline-fixture", type=Path,
                    help="JSON array of recorded API page objects (no network)")
    args = ap.parse_args()
    as_of = datetime.now(timezone.utc)
    offline_pages = None
    if args.offline_fixture is not None:
        offline_pages = json.loads(args.offline_fixture.read_text(encoding="utf-8"))
    candles, receipts = collect(args.symbol, as_of, args.limit, args.pages,
                                offline_pages=offline_pages)
    manifest = export_snapshot(candles, receipts, args.symbol, as_of, args.out,
                               "offline_fixture" if offline_pages is not None else "public_get")
    print(json.dumps({"csv_sha256": manifest["csv_sha256"],
                      "bars": manifest["closed_bars"],
                      "source": manifest["source"], "output": str(args.out)}))


if __name__ == "__main__":
    main()
