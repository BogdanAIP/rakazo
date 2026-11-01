"""Finite original-source quality audit. No signals, strategy evaluation or holdout commands."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import datetime as dt
import json
import math
from pathlib import Path

import okx_bench_archive_v40 as source


def utc_day(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).date().isoformat()


def inspect_candles(root, day):
    """Count every original record; never choose a price from duplicate variants."""
    span = int(dt.datetime.combine(day, dt.time(), dt.timezone.utc).timestamp() * 1000) - 8 * source.HOUR
    seen, hours, flags, differing = {}, defaultdict(set), Counter(), Counter()
    duplicates = identical = variants = invalid = total = 0
    for row in source.read_zip_rows(source.file_at(root, "candles", day)):
        if None in row or None in row.values():
            raise ValueError("Ragged original candle row")
        symbol = row["instrument_name"]
        if not symbol.endswith("-USDT-SWAP"):
            continue
        t = int(row["open_time"])
        if not span <= t < span + source.DAY or t % 60000:
            raise ValueError("Original minute outside full archive span or grid")
        total += 1
        flags[row["confirm"]] += 1
        op, hi, lo, cl, vol = (float(row[f]) for f in ("open", "high", "low", "close", "vol_quote"))
        if (not all(math.isfinite(v) for v in (op, hi, lo, cl, vol))
                or min(op, hi, lo, cl) <= 0 or vol < 0 or hi < max(op, cl, lo) or lo > min(op, cl, hi)):
            invalid += 1
        key = (t, symbol)
        # One exact JSON string per minute: injective like the tuple, about four times smaller.
        fingerprint = json.dumps(sorted(row.items()), ensure_ascii=False, separators=(",", ":"))
        if key in seen:
            duplicates += 1
            if seen[key] == fingerprint:
                identical += 1
            else:
                variants += 1
                old = dict(json.loads(seen[key]))
                differing.update(k for k, v in row.items() if old.get(k) != v)
        else:
            seen[key] = fingerprint
            hours[(t // source.HOUR * source.HOUR, symbol)].add(t // 60000 % 60)
    stats = {"archive_date": day.isoformat(), "source_minutes": len(seen), "original_minute_rows": total,
             "usable_hours": len(hours), "incomplete_hours": sum(len(v) != 60 for v in hours.values()),
             "missing_source_minutes": sum(60 - len(v) for v in hours.values()),
             "confirm_counts": dict(flags), "symbols": len({s for _, s in seen}),
             "duplicate_minute_rows": duplicates, "duplicate_identical_fields": identical,
             "duplicate_nonidentical_fields": variants, "duplicate_differing_fields": dict(differing),
             "invalid_ohlcv_rows": invalid, "duplicate_price_selection_performed": False}
    return stats, hours


def funding_diagnostics(events, full_days):
    counts = Counter((utc_day(t), symbol) for t, symbol in events)
    values = defaultdict(list)
    for day, symbol in sorted(full_days):
        values[symbol].append(counts[(day, symbol)])
    gaps = []
    by_symbol = defaultdict(list)
    for t, symbol in events:
        by_symbol[symbol].append(t)
    for stamps in by_symbol.values():
        ordered = sorted(stamps)
        gaps.extend((b - a) / source.HOUR for a, b in zip(ordered, ordered[1:]))
    return {
        "observed_events": len(events),
        "numeric_rate_events": sum(rate is not None for rate in events.values()),
        "unknown_rate_events": sum(rate is None for rate in events.values()),
        "symbols_with_unknown_rate": sorted({symbol for (_, symbol), rate in events.items() if rate is None}),
        "settlement_count_basis": "timestamped source records including unavailable-rate markers; not certified cash payments",
        "full_observed_hour_contract_days": len(full_days),
        "settlement_count_histogram_full_days": dict(sorted(Counter(counts[p] for p in full_days).items())),
        "zero_observed_settlement_full_days": sum(counts[p] == 0 for p in full_days),
        "symbols_with_varying_full_day_counts": sorted(s for s, v in values.items() if len(set(v)) > 1),
        "largest_observed_gap_hours": max(gaps) if gaps else None,
        "gaps_greater_than_eight_hours": sum(g > 8 for g in gaps),
        # Settlement clocks lag the hour by seconds, so an 8h schedule yields raw gaps of
        # 8.0003h. Nominal (nearest-hour) gaps separate schedule changes from that jitter.
        "nominal_gap_hours_histogram": dict(sorted(Counter(round(g) for g in gaps).items())),
        "gaps_greater_than_eight_nominal_hours": sum(round(g) > 8 for g in gaps),
        "original_event_time_preserved": True,
        "non_hour_aligned_events": sum(t % source.HOUR != 0 for t, _ in events),
        "hour_offset_histogram_ms": dict(sorted(Counter(t % source.HOUR for t, _ in events).items())),
        "hour_bucket_rounding_performed": False,
        "historical_settlement_schedule_verified": False,
        "coverage_certified": False,
        "interpretation": "Counts/gaps are diagnostics, not proof of missing events or known zero funding; historical schedules and listing edges require provenance."
    }


def audit(root, start, end, manifest_out, out):
    if start > end:
        raise ValueError("Invalid date interval")
    if manifest_out.exists() or out.exists():
        raise FileExistsError("Preserve first manifest and audit outputs")
    manifest, per_day, events, observed_hours, symbols = [], [], {}, defaultdict(int), set()
    for day in source.days(start, end):
        receipt = json.loads((root / "receipts" / f"{day}.json").read_text())
        span_start = int(dt.datetime.combine(day, dt.time(), dt.timezone.utc).timestamp() * 1000) - 8 * source.HOUR
        for kind in source.MODULES:
            p = source.file_at(root, kind, day)
            info = receipt[kind]
            if source.sha_file(p) != info["sha256"] or p.stat().st_size != info["zip_bytes"]:
                raise ValueError(f"Original receipt mismatch: {kind} {day}")
            if not info["official_url"].startswith("https://static.okx.com/"):
                raise ValueError("Unexpected original host")
            manifest.append({"day": day.isoformat(), "module": kind, **info})
        events_before_day = len(events)
        for row in source.read_zip_rows(source.file_at(root, "funding", day)):
            symbol = row["instrument_name"]
            if not symbol.endswith("-USDT-SWAP"):
                continue
            t, rate = int(row["funding_time"]), source.parse_funding_rate(row["funding_rate"])
            if not span_start <= t < span_start + source.DAY:
                raise ValueError(f"Invalid funding clock/rate: {day} {symbol}")
            # Keep the original event clock. Off-hour settlement records are
            # an audit finding, never silently rounded to satisfy the builder.
            key = (t, symbol)
            if key in events:
                raise ValueError("Duplicate original settlement")
            events[key] = rate
        stats, hour_coverage = inspect_candles(root, day)
        for hour, symbol in hour_coverage:
            if not span_start <= hour < span_start + source.DAY:
                raise ValueError("Original candle outside its full UTC+8 archive span")
            symbols.add(symbol)
            observed_hours[(utc_day(hour), symbol)] |= 1 << (hour % source.DAY // source.HOUR)
        per_day.append({**stats, "original_funding_events": len(events) - events_before_day})
    full_days = {p for p, mask in observed_hours.items()
                 if mask == (1 << 24) - 1 and start.isoformat() <= p[0] < end.isoformat()}
    manifest_out.parent.mkdir(parents=True, exist_ok=True)
    with manifest_out.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    result = {
        "schema": "rakazo_bench_source_quality_v1", "mode": "DATA_QUALITY_ONLY",
        "archive_start": start.isoformat(), "archive_end": end.isoformat(),
        "archive_days": len(per_day), "original_files": len(manifest),
        "source_bytes": sum(x["zip_bytes"] for x in manifest),
        "private_source_manifest_sha256": source.sha_file(manifest_out),
        "originals_and_receipts_verified": True,
        "observed_historical_usdt_symbols": len(symbols),
        "survivorship_completeness_certified": False,
        "source_minutes": sum(x["source_minutes"] for x in per_day),
        "original_minute_rows": sum(x["original_minute_rows"] for x in per_day),
        "duplicate_minute_rows": sum(x["duplicate_minute_rows"] for x in per_day),
        "duplicate_identical_fields": sum(x["duplicate_identical_fields"] for x in per_day),
        "duplicate_nonidentical_fields": sum(x["duplicate_nonidentical_fields"] for x in per_day),
        "invalid_ohlcv_rows": sum(x["invalid_ohlcv_rows"] for x in per_day),
        "duplicate_price_selection_performed": False,
        "observed_hours": sum(x["usable_hours"] for x in per_day),
        "incomplete_source_hours": sum(x["incomplete_hours"] for x in per_day),
        "missing_minutes_in_observed_hours": sum(x["missing_source_minutes"] for x in per_day),
        "missing_minute_causes": "UNKNOWN",
        "whole_missing_hours_or_unobserved_contracts_certified_absent": False,
        "funding": funding_diagnostics(events, full_days),
        "per_archive_quality": per_day,
        "historical_oi": "UNKNOWN", "strategy_evaluations": 0, "freeze_approved": False
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(result, sort_keys=True, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--archive-start", type=source.DATE, required=True)
    parser.add_argument("--archive-end", type=source.DATE, required=True)
    parser.add_argument("--manifest-out", type=Path, required=True, help="PRIVATE: individual source SHA receipts")
    parser.add_argument("--out", type=Path, required=True, help="PRIVATE first aggregate audit output")
    args = parser.parse_args()
    print(json.dumps(audit(args.root, args.archive_start, args.archive_end, args.manifest_out, args.out), sort_keys=True))
