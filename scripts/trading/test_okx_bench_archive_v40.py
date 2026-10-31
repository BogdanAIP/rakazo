"""Deterministic offline tests for point-in-time OKX archive aggregation."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import tempfile
import unittest
from unittest import mock
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
            import algorithm_bench_v40 as bench
            independent = bench.audit_panel(bench.load_panel(panel), expect_bar_ms=archive.HOUR,
                                             eligibility_usd=5_000_000)
            self.assertEqual(independent["eligibility_check"]["mismatched_rows"], 0)
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


class TestAcquisitionBudgets(unittest.TestCase):
    def test_response_bound_with_and_without_content_length(self):
        for headers in ({"Content-Length": "6"}, {}):
            response = io.BytesIO(b"123456")
            response.headers = headers
            with mock.patch.object(archive.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, "byte budget"):
                    archive.request_bytes("https://static.okx.com/example.zip", max_bytes=5)
        response = io.BytesIO(b"12345")
        response.headers = {}
        with mock.patch.object(archive.urllib.request, "urlopen", return_value=response):
            self.assertEqual(archive.request_bytes("https://static.okx.com/example.zip", max_bytes=5), b"12345")

    def test_disk_floor_stops_before_network(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(archive.shutil, "disk_usage", return_value=mock.Mock(free=100)):
                with mock.patch.object(archive, "source_url") as lookup:
                    with self.assertRaisesRegex(RuntimeError, "byte/disk budget"):
                        archive.sync(Path(td), dt.date(2023, 10, 8), dt.date(2023, 10, 8), 1,
                                     min_free_bytes=100)
                    lookup.assert_not_called()

    def test_new_bytes_quota_leaves_verified_checkpoint(self):
        with tempfile.TemporaryDirectory() as td:
            root, day = Path(td), dt.date(2023, 10, 8)
            payload = compressed("source.csv", "a,b\n1,2\n")
            def download(url, *, max_bytes):
                self.assertEqual(max_bytes, len(payload))
                return payload
            with mock.patch.object(archive, "source_url", return_value="https://static.okx.com/example.zip"):
                with mock.patch.object(archive, "request_bytes", side_effect=download) as read:
                    with mock.patch.object(archive.time, "sleep"):
                        with self.assertRaisesRegex(RuntimeError, "byte/disk budget"):
                            archive.sync(root, day, day, 1, max_new_bytes=len(payload), min_free_bytes=0)
                    self.assertEqual(read.call_count, 1)
            self.assertTrue(archive.file_at(root, "candles", day).exists())
            self.assertFalse(archive.file_at(root, "funding", day).exists())
            receipt = json.loads((root / "receipts" / f"{day}.json").read_text())
            self.assertEqual(receipt["candles"]["sha256"], hashlib.sha256(payload).hexdigest())

    def test_existing_original_receipt_mismatch_is_not_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            root, day = Path(td), dt.date(2023, 10, 8)
            path = archive.file_at(root, "candles", day)
            path.parent.mkdir(parents=True)
            path.write_bytes(compressed("source.csv", "a,b\n1,2\n"))
            with mock.patch.object(archive, "source_url") as lookup:
                with self.assertRaisesRegex(ValueError, "original/receipt mismatch"):
                    archive.sync(root, day, day, 1, min_free_bytes=0)
                lookup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
