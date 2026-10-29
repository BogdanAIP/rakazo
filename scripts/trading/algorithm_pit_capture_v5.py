#!/usr/bin/env python3
"""Manually capture provenance-bound public OKX OI and forecast funding.

STRICTLY research-only. No API keys, account state, orders, scheduling,
auto-polling, private endpoints or trading calls. A local receive timestamp
proves acquisition by this computer, NOT the earliest exchange publication.
Only newly captured observations are point-in-time candidates; neither
settlement ZIP timestamps nor today's live snapshots backfill old OI values.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

BASE = "https://www.okx.com/api/v5/public/"
SYMBOL = re.compile(r"(?:[A-Z0-9]{2,20})-USDT-SWAP\Z")
SCHEMA = "algorithm_pit_public_capture_v5"
MAX_RAW = 65_536
MAX_CLOCK_SKEW_MS = 60_000
MAX_REQUEST_MS = 20_000
MAX_FEATURE_AGE_MS = 3_600_000
MIN_OI_SEPARATION_MS = 900_000


def local_ms():
    return time.time_ns() // 1_000_000


def public_get(url: str):
    if not url.startswith(BASE) or not (
        url == BASE+"time" or
        re.fullmatch(re.escape(BASE)+r"open-interest\?instType=SWAP&instId=[A-Z0-9]{2,20}-USDT-SWAP", url) or
        re.fullmatch(re.escape(BASE)+r"funding-rate\?instId=[A-Z0-9]{2,20}-USDT-SWAP", url)
    ):
        raise ValueError("Only allowlisted public market endpoints")
    req = Request(url, headers={"Accept": "application/json",
                                "User-Agent": "Rakazo-PIT-research-readonly/1"})
    with urlopen(req, timeout=8) as response:
        if response.status != 200:
            raise ValueError("Unexpected public HTTP response")
        raw = response.read(MAX_RAW + 1)
    if not raw or len(raw) > MAX_RAW:
        raise ValueError("Public response size rejected")
    return raw


def strict_json(raw):
    def unique(pairs):
        data = {}
        for key, value in pairs:
            if key in data:
                raise ValueError("Duplicate JSON field")
            data[key] = value
        return data

    def invalid(value):
        raise ValueError("Nonfinite JSON token")

    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_RAW:
        raise ValueError("Invalid response bytes")
    return json.loads(raw.decode("utf8"), object_pairs_hook=unique,
                      parse_constant=invalid)


def finite_decimal(s, *, signed=False):
    if not isinstance(s, str) or not s.strip():
        raise ValueError("Decimal string required")
    try:
        d = Decimal(s)
    except InvalidOperation as e:
        raise ValueError("Invalid market decimal") from e
    if not d.is_finite() or (d < 0 and not signed):
        raise ValueError("Nonfinite or negative unsigned field")
    if abs(d) > Decimal("1000000000000000000"):
        raise ValueError("Implausible market magnitude")
    return d


def epoch_ms(s):
    if not isinstance(s, str) or not re.fullmatch(r"\d{13}", s):
        raise ValueError("Expected exchange millisecond epoch string")
    return int(s)


def interpret(kind, symbol, data, received_ms):
    if not isinstance(data, dict) or data.get("code") != "0" or not isinstance(data.get("data"), list) or len(data["data"]) != 1:
        raise ValueError("Unexpected OKX public response")
    row = data["data"][0]
    if not isinstance(row, dict):
        raise ValueError("Invalid result row")
    if kind == "time":
        stamp = epoch_ms(row.get("ts"))
        if abs(stamp - received_ms) > MAX_CLOCK_SKEW_MS:
            raise ValueError("Computer and OKX server clocks disagree")
        return {"server_time_ms": stamp}
    if row.get("instId") != symbol or row.get("instType") != "SWAP":
        raise ValueError("Foreign instrument")
    generated = epoch_ms(row.get("ts"))
    if generated > received_ms + 1000 or generated < received_ms - MAX_FEATURE_AGE_MS:
        raise ValueError("Stale or future exchange observation")
    if kind == "oi":
        for key in ("oi", "oiCcy", "oiUsd"):
            if finite_decimal(row.get(key)) <= 0:
                raise ValueError("Nonpositive OI")
        return {"exchange_generated_ms": generated, "oi": row["oi"],
                "oiCcy": row["oiCcy"], "oiUsd": row["oiUsd"]}
    if kind == "funding":
        finite_decimal(row.get("fundingRate"), signed=True)
        settlement = epoch_ms(row.get("fundingTime"))
        if not generated - 86_400_000 <= settlement <= generated + 86_400_000:
            raise ValueError("Implausible funding period")
        previous = row.get("prevFundingTime")
        if previous not in (None, ""):
            epoch_ms(previous)
        settled = row.get("settFundingRate")
        if settled not in (None, ""):
            finite_decimal(settled, signed=True)
        return {"exchange_generated_ms": generated,
                "forecast_funding_rate": row["fundingRate"],
                "forecast_settlement_time_ms": settlement,
                "previous_settlement_time_ms": epoch_ms(previous) if previous not in (None, "") else None,
                "reported_previous_settled_rate": settled,
                "historical_publication_time_known": False,
                "future_forecast_is_realized_rate": False}
    raise ValueError("Unknown public evidence kind")


def capture(symbols, *, get=public_get, now=local_ms):
    if (not isinstance(symbols, list) or not 1 <= len(symbols) <= 5
            or any(not isinstance(s, str) or not SYMBOL.fullmatch(s) for s in symbols)
            or len(set(symbols)) != len(symbols)):
        raise ValueError("Need 1..5 distinct public USDT swap symbols")
    records = []
    def take(kind, symbol, url):
        sent = now()
        raw = get(url)
        received = now()
        if type(sent) is not int or type(received) is not int or not 0 <= received-sent <= MAX_REQUEST_MS:
            raise ValueError("Invalid capture timing")
        parsed = interpret(kind, symbol, strict_json(raw), received)
        record = {
            "kind": kind, "symbol": symbol, "url": url,
            "request_sent_ms": sent, "received_complete_ms": received,
            "available_to_research_not_before_ms": received,
            "body_sha256": hashlib.sha256(raw).hexdigest(),
            "raw_file": f"{len(records):02d}-{kind}-{symbol or 'server'}.json",
            "observed": parsed,
        }
        records.append((record, raw))
    take("time", None, BASE+"time")
    for symbol in symbols:
        take("oi", symbol, BASE+f"open-interest?instType=SWAP&instId={symbol}")
        take("funding", symbol, BASE+f"funding-rate?instId={symbol}")
    take("time", None, BASE+"time")
    manifest = {
        "schema": SCHEMA,
        "symbols": list(symbols),
        "public_read_only": True,
        "no_scheduler": True,
        "no_credentials": True,
        "historical_publication_time_certified": False,
        "forecast_funding_not_settled_cashflow": True,
        "snapshot_not_historical_backfill": True,
        "can_trade": False,
        "records": [record for record, _ in records],
    }
    return manifest, records


def save_capture(folder, manifest, records):
    folder = Path(folder)
    if folder.exists():
        raise FileExistsError("Capture output must be new; never overwrite evidence")
    if not folder.parent.is_dir():
        raise FileNotFoundError("Existing parent folder required")
    # Perform all capture/validation first; only then create a destination.
    folder.mkdir()
    for item, raw in records:
        (folder / item["raw_file"]).write_bytes(raw)
    encoded = (json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf8")
    (folder / "manifest.json").write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


def verify_capture(folder):
    folder = Path(folder)
    raw = (folder/"manifest.json").read_bytes()
    data = strict_json(raw)
    if (data.get("schema") != SCHEMA
            or data.get("public_read_only") is not True
            or data.get("can_trade") is not False
            or data.get("historical_publication_time_certified") is not False
            or data.get("forecast_funding_not_settled_cashflow") is not True
            or data.get("snapshot_not_historical_backfill") is not True):
        raise ValueError("Invalid capture policy")
    symbols = data.get("symbols")
    records = data.get("records")
    if (not isinstance(symbols, list) or not 1 <= len(symbols) <= 5
            or len(symbols) != len(set(symbols))
            or any(not isinstance(s, str) or not SYMBOL.fullmatch(s) for s in symbols)
            or not isinstance(records, list) or len(records) != 2*len(symbols)+2):
        raise ValueError("Unexpected capture inventory")
    expected = [("time", None)]
    for symbol in symbols:
        expected.extend([("oi", symbol), ("funding", symbol)])
    expected.append(("time", None))
    for index, record in enumerate(records):
        if (not isinstance(record, dict)
                or (record.get("kind"), record.get("symbol")) != expected[index]
                or record.get("raw_file") != f"{index:02d}-{record['kind']}-{record.get('symbol') or 'server'}.json"
                or record.get("url") != (BASE+"time" if record["kind"] == "time"
                    else BASE+(f"open-interest?instType=SWAP&instId={record['symbol']}" if record["kind"] == "oi"
                    else f"funding-rate?instId={record['symbol']}"))):
            raise ValueError("Manifest route mismatch")
        send, received = record.get("request_sent_ms"), record.get("received_complete_ms")
        if (type(send) is not int or type(received) is not int
                or not 0 <= received-send <= MAX_REQUEST_MS
                or record.get("available_to_research_not_before_ms") != received):
            raise ValueError("Manifest timestamps invalid")
        raw_row = (folder / record["raw_file"]).read_bytes()
        if hashlib.sha256(raw_row).hexdigest() != record.get("body_sha256"):
            raise ValueError("Tampered public response")
        observed = interpret(record["kind"], record["symbol"], strict_json(raw_row), received)
        if observed != record.get("observed"):
            raise ValueError("Manifest observed fields differ from actual response")
        if index > 0 and send < records[index-1]["received_complete_ms"]:
            raise ValueError("Nonchronological capture")
    return data, hashlib.sha256(raw).hexdigest()


def point_in_time_oi_delta(captures, symbol, decision_ms):
    """Return a 2-point OI delta only after BOTH responses were received.

    Two different capture directories, >=15 minutes apart, required. This is
    not a backtest and cannot be applied retroactively to 2026 Jul-Sep.
    """
    if not isinstance(decision_ms, int) or not SYMBOL.fullmatch(symbol):
        raise ValueError("Invalid query")
    values = []
    for manifest in captures:
        for rec in manifest["records"]:
            if rec["kind"] == "oi" and rec["symbol"] == symbol:
                if rec["received_complete_ms"] <= decision_ms:
                    values.append(rec)
    values.sort(key=lambda x: x["received_complete_ms"])
    if len(values) < 2:
        return None
    earlier, later = values[-2:]
    if (later["received_complete_ms"]-earlier["received_complete_ms"] < MIN_OI_SEPARATION_MS
            or decision_ms-later["received_complete_ms"] > MAX_FEATURE_AGE_MS):
        return None
    past = finite_decimal(earlier["observed"]["oiCcy"])
    current = finite_decimal(later["observed"]["oiCcy"])
    return {
        "instrument": symbol,
        "past_received_ms": earlier["received_complete_ms"],
        "latest_received_ms": later["received_complete_ms"],
        "oiCcy_delta_fraction": str(current/past-1),
        "trading_approved": False,
    }


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--symbols", nargs="+", required=True)
    cli.add_argument("--out-dir", type=Path, required=True)
    args = cli.parse_args()
    if args.out_dir.exists():
        raise FileExistsError("Output directory already exists")
    manifest, records = capture(args.symbols)
    digest = save_capture(args.out_dir, manifest, records)
    verify_capture(args.out_dir)
    print(json.dumps({
        "schema": SCHEMA, "symbols": manifest["symbols"],
        "records": len(records), "manifest_sha256": digest,
        "historical_publication_time_certified": False,
        "point_in_time_features_ready": False, "can_trade": False,
    }))


if __name__ == "__main__":
    main()
