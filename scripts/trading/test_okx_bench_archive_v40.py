"""Deterministic offline tests for point-in-time OKX archive aggregation."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import okx_bench_archive_v40 as archive


def compressed(name: str, csv_text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zipfile_obj:
        zipfile_obj.writestr(name, csv_text)
    return buf.getvalue()


class TestArchiveBuilder(unittest.TestCase):
    def test_previous_thirty_calendar_days_only_and_funding(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            start, end = dt.date(2023, 10, 1), dt.date(2023, 11, 2)
            for day in archive.days(start, end):
                hour = dt.datetime.combine(day - dt.timedelta(days=1), dt.time(hour=16), dt.timezone.utc)
                ts = int(hour.timestamp() * 1000)
                cand = io.StringIO(newline="")
                w = csv.writer(cand)
                w.writerow(("instrument_name", "open", "high", "low", "close", "vol",
                            "vol_ccy", "vol_quote", "open_time", "confirm"))
                for sym, daily_usdt in (("HIGH-USDT-SWAP", 6_000_000), ("LOW-USDT-SWAP", 4_000_000)):
                    # An extreme same-day volume surge must NOT affect this day's eligibility.
                    if sym == "LOW-USDT-SWAP" and day == end:
                        daily_usdt = 100_000_000
                    for m in range(60):
                        w.writerow((sym, "1.0", "1.0", "1.0", "1.0", 1, 1, daily_usdt / 60,
                                    ts + m * 60_000, 0))
                funding = io.StringIO(newline="")
                w = csv.writer(funding)
                w.writerow(("instrument_name", "funding_rate", "funding_time"))
                for sym in ("HIGH-USDT-SWAP", "LOW-USDT-SWAP"):
                    if day == end and sym == "LOW-USDT-SWAP":
                        continue  # Missing funding coverage for one symbol/UTC day.
                    w.writerow((sym, "0.0001", ts + archive.HOUR))
                receipt = {}
                for kind, doc in (("candles", cand.getvalue()), ("funding", funding.getvalue())):
                    payload = compressed(f"{kind}.csv", doc)
                    path = archive.file_at(root, kind, day)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(payload)
                    receipt[kind] = {"sha256": hashlib.sha256(payload).hexdigest(), "zip_bytes": len(payload)}
                file = root / "receipts" / f"{day.isoformat()}.json"
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(json.dumps(receipt), encoding="utf-8")
            hour_rows, stats = archive.aggregate_day(root, end)
            self.assertEqual(stats["usable_hours"], 2)
            self.assertEqual(stats["funding_events"], 1)
            self.assertEqual(stats["incomplete_hours"], 0)
            self.assertEqual(hour_rows[0][7], 0.0001)
            panel = root / "hourly.csv"
            archive.build(root, start, end, dt.date(2023, 11, 1),
                          dt.date(2023, 11, 1), panel, 5_000_000)
            with panel.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 64)  # All traded bars, including 30-day warmup and ineligible symbols.
            eligible = [row for row in rows if row["eligible"] == "1"]
            self.assertEqual(len(eligible), 2)
            self.assertTrue(all(row["symbol"] == "HIGH-USDT-SWAP" for row in eligible))
            self.assertEqual(float(eligible[-1]["funding"]), 0.0001)
            self.assertEqual(float(eligible[-1]["volume"]), 6_000_000)
            self.assertEqual(rows[-1]["symbol"], "LOW-USDT-SWAP")
            self.assertEqual(rows[-1]["funding"], "NA")
            self.assertEqual(rows[-1]["eligible"], "0")
            audit = json.loads((root / "hourly.audit.json").read_text())
            self.assertEqual(audit["panel_rows"], 64)
            self.assertEqual(audit["eligible_rows"], 2)
            self.assertEqual(audit["funding_unknown_rows"], 1)
            self.assertEqual(audit["first_panel_utc"], "2023-10-01")
            self.assertEqual(audit["minute_confirm_flags"]["0"], (end-start).days*120 + 120)

    def test_sparse_hour_is_preserved_and_audited(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            day = dt.date(2023, 11, 2)
            ts = int(dt.datetime(2023, 11, 1, 16, tzinfo=dt.timezone.utc).timestamp() * 1000)
            header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            rows = "".join(f"X-USDT-SWAP,1,1,1,1,0,0,10,{ts + m * 60000},0\n"
                           for m in range(59))
            target = archive.file_at(root, "candles", day)
            target.parent.mkdir(parents=True)
            target.write_bytes(compressed("candles.csv", header + rows))
            archive.file_at(root, "funding", day).write_bytes(
                compressed("funding.csv", "instrument_name,funding_rate,funding_time\n"))
            hour_rows, stats = archive.aggregate_day(root, day)
            self.assertEqual(len(hour_rows), 1)
            self.assertEqual(hour_rows[0][8], 59)
            self.assertEqual(stats["incomplete_hours"], 1)
            self.assertEqual(stats["missing_source_minutes"], 1)

    def test_funding_settlement_is_paid_by_preceding_hour(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            day = dt.date(2023, 11, 2)
            ts = int(dt.datetime(2023, 11, 1, 16, tzinfo=dt.timezone.utc).timestamp() * 1000)
            header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            rows = "".join(f"X-USDT-SWAP,1,1,1,1,0,0,10,{ts + m * 60000},0\n"
                           for m in range(120))
            target = archive.file_at(root, "candles", day)
            target.parent.mkdir(parents=True)
            target.write_bytes(compressed("candles.csv", header + rows))
            archive.file_at(root, "funding", day).write_bytes(
                compressed("funding.csv",
                           "instrument_name,funding_rate,funding_time\n"
                           f"X-USDT-SWAP,0.0002,{ts + archive.HOUR}\n"))
            hour_rows, stats = archive.aggregate_day(root, day)
            self.assertEqual(len(hour_rows), 2)
            self.assertEqual(hour_rows[0][7], 0.0002)
            self.assertIsNone(hour_rows[1][7])
            self.assertEqual(stats["funding_events"], 1)

    def test_duplicate_minute_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            day = dt.date(2023, 11, 2)
            header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            repeated = "X-USDT-SWAP,1,1,1,1,0,0,0,1698854400000,0\n"
            target = archive.file_at(root, "candles", day)
            target.parent.mkdir(parents=True)
            target.write_bytes(compressed("candles.csv", header + repeated * 2))
            fund_target = archive.file_at(root, "funding", day)
            fund_target.write_bytes(compressed("funding.csv", "instrument_name,funding_rate,funding_time\n"))
            with self.assertRaisesRegex(ValueError, "Duplicate minute"):
                archive.aggregate_day(root, day)


if __name__ == "__main__":
    unittest.main()
