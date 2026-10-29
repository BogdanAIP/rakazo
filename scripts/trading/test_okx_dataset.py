"""Offline tests for official-format pagination, integrity and single-use holdout."""
import csv
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from okx_dataset import collect, export_snapshot, parse_pages
from run_alpha_audited import audited_run, verify_snapshot

UTC = timezone.utc
START = datetime(2025, 1, 1, tzinfo=UTC)
SYMBOL = "BTC-USDT-SWAP"

def fixtures(count=600):
    rows = []
    for i in range(count):
        t = int((START + timedelta(minutes=15 * i)).timestamp() * 1000)
        op = 100 + i * 0.01
        cl = op + (0.4 if i % 8 < 4 else -0.4)
        hi, lo = max(op, cl) + 0.05, min(op, cl) - 0.05
        rows.append([str(t), str(op), str(hi), str(lo), str(cl),
                     "5", "0", "10000", "1"])
    rows.reverse()
    return [{"code": "0", "msg": "", "data": rows[i:i + 100]}
            for i in range(0, len(rows), 100)]

class SnapshotTests(unittest.TestCase):
    def test_pagination_cursor_and_full_coverage(self):
        pages = fixtures()
        cursors = []
        def fetch(symbol, cursor, limit):
            self.assertEqual(symbol, SYMBOL)
            self.assertEqual(limit, 100)
            cursors.append(cursor)
            return pages[len(cursors) - 1]
        bars, receipts = collect(SYMBOL, datetime(2025, 2, 1, tzinfo=UTC),
                                 page_count=6, fetcher=fetch)
        self.assertEqual(len(bars), 600)
        self.assertEqual(len(receipts), 6)
        self.assertEqual(cursors[0], None)
        self.assertEqual(cursors[1], pages[0]["data"][-1][0])
        self.assertEqual(bars[0][0], int(pages[-1]["data"][-1][0]))
        self.assertEqual(bars[-1][0], int(pages[0]["data"][0][0]))

    def test_refuses_overlap_gaps_and_future_confirm(self):
        pages = fixtures()
        bad = json.loads(json.dumps(pages))
        bad[1]["data"][0] = bad[0]["data"][-1]
        with self.assertRaises(ValueError):
            parse_pages(bad, SYMBOL, datetime(2025, 2, 1, tzinfo=UTC), 100)
        bad = json.loads(json.dumps(pages))
        del bad[0]["data"][20]
        with self.assertRaises(ValueError):
            parse_pages(bad, SYMBOL, datetime(2025, 2, 1, tzinfo=UTC), 100)
        with self.assertRaises(ValueError):
            parse_pages(pages, SYMBOL, START, 100)

    def test_closed_only_and_fixture_blocked_by_default(self):
        pages = fixtures()
        pages[0]["data"][0][8] = "0"
        bars, receipts = parse_pages(pages, SYMBOL,
                                      datetime(2025, 2, 1, tzinfo=UTC), 100)
        self.assertEqual(len(bars), 599)
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "study.csv"
            manifest = export_snapshot(
                bars, receipts, SYMBOL, datetime(2025, 2, 1, tzinfo=UTC),
                file, source="offline_fixture")
            self.assertEqual(len(manifest["csv_sha256"]), 64)
            with self.assertRaises(ValueError):
                verify_snapshot(file, file.with_suffix(".manifest.json"))
            verified, _, _ = verify_snapshot(
                file, file.with_suffix(".manifest.json"), allow_fixture=True)
            self.assertEqual(len(verified), 599)
            # Tampered data must never be evaluated.
            with file.open("a", encoding="utf-8") as f:
                f.write("garbage\n")
            with self.assertRaises(ValueError):
                verify_snapshot(file, file.with_suffix(".manifest.json"),
                                allow_fixture=True)

    def test_audited_holdout_is_used_once(self):
        bars, receipts = parse_pages(fixtures(), SYMBOL,
                                      datetime(2025, 2, 1, tzinfo=UTC), 100)
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            csv_file = folder / "fixture.csv"
            export_snapshot(bars, receipts, SYMBOL, datetime(2025, 2, 1, tzinfo=UTC),
                            csv_file, "offline_fixture")
            registry = folder / "registry"
            report_path = folder / "report.json"
            result = audited_run(csv_file, csv_file.with_suffix(".manifest.json"),
                                 registry, report_path, rounds=2, allow_fixture=True)
            self.assertTrue(report_path.exists())
            self.assertFalse(result["audited_snapshot"]["holdout_reuse_allowed"])
            self.assertEqual(len(list(registry.glob("*.claim.json"))), 1)
            with self.assertRaises(FileExistsError):
                audited_run(csv_file, csv_file.with_suffix(".manifest.json"),
                            registry, folder / "second.json", rounds=2,
                            allow_fixture=True)

    def test_reject_wrong_symbol(self):
        with self.assertRaises(ValueError):
            collect("BTC-USDT;DELETE", datetime.now(UTC), offline_pages=fixtures())
        with self.assertRaises(ValueError):
            collect("BTC-USDT", datetime.now(UTC), offline_pages=fixtures())

if __name__ == "__main__":
    unittest.main()
