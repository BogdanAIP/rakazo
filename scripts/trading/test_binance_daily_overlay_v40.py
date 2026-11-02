"""Synthetic J6 daily-source overlay regressions; no market files or network."""
import collections
import csv
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import binance_bench_archive_v40 as bn
from test_binance_bench_archive_v40 import kline_rows, put


class TestDailyOverlay(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.daily = self.root / "daily"
        self.rows = kline_rows("2020-01", 400000)
        self.day = "2020-01-16"
        self.target = self.rows[15 * 24:16 * 24]
        # One full missing UTC day, with monthly bars both before and after it.
        put(self.root, "klines", "TUSDT", "2020-01",
            self.rows[:15 * 24] + self.rows[16 * 24:])
        self.source(self.target)
        self.manifest()

    def source(self, rows):
        p = self.daily / "TUSDT" / ("TUSDT-1h-" + self.day + ".zip")
        p.parent.mkdir(parents=True, exist_ok=True)
        stream = io.StringIO()
        csv.writer(stream, lineterminator="\n").writerows(rows)
        with zipfile.ZipFile(p, "w") as z:
            z.writestr(p.stem + ".csv", stream.getvalue())
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        p.with_name(p.name + ".CHECKSUM").write_text(digest + "  " + p.name + "\n")
        self.path, self.digest = p, digest

    def manifest(self, fills=24, overlaps=0, entries=None):
        self.doc = {
            "request_list_sha256": "a" * 64,
            "entries": entries if entries is not None else [
                {"symbol": "TUSDT", "day": self.day, "status": "available", "sha256": self.digest},
                {"symbol": "TUSDT", "day": "2020-01-17", "status": "absent404"}],
            "expected_counts": {"daily_source_files": 1, "daily_filled_rows": fills,
                                "daily_overlap_identical": overlaps}}
        self.save()

    def save(self):
        self.m = self.root / "manifest.json"
        self.m.write_text(json.dumps(self.doc))
        self.sha = hashlib.sha256(self.m.read_bytes()).hexdigest()

    def build(self):
        return bn.build(self.root, ["TUSDT"], "2020-01", "2020-01", self.root / "panel.csv",
                        daily_manifest=self.m, daily_root=self.daily,
                        daily_manifest_sha256=self.sha)

    def test_exact_fill_and_absent_receipt(self):
        result = self.build()
        self.assertEqual(result["panel_rows"], 31 * 24)
        self.assertEqual(result["daily_filled_rows"], 24)
        self.assertEqual(result["daily_absent404"], 1)
        # Funding and eligibility are recomputed; no settlement source invented.
        with (self.root / "panel.csv").open() as f:
            rows = list(csv.DictReader(f))
        self.assertTrue(all(r["funding"] == "NA" for r in rows))
        self.assertTrue(all(r["eligible"] == "0" for r in rows[:30 * 24]))

    def test_monthly_precedence_exact_overlap(self):
        put(self.root, "klines", "TUSDT", "2020-01", self.rows[:15 * 24 + 1] + self.rows[16 * 24:])
        self.manifest(fills=23, overlaps=1)
        result = self.build()
        self.assertEqual(result["daily_overlap_identical"], 1)
        self.assertEqual(result["daily_filled_rows"], 23)

    def test_conflict_stops(self):
        put(self.root, "klines", "TUSDT", "2020-01", self.rows)
        bad = [r.copy() for r in self.target]
        bad[0][7] += 1
        self.source(bad)
        self.manifest(fills=0, overlaps=24)
        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            self.build()
        self.assertFalse((self.root / "panel.csv").exists())

    def test_missing_listed_file_stops(self):
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.build()

    def test_out_of_span_stops(self):
        put(self.root, "klines", "TUSDT", "2020-01", self.rows[:15 * 24])
        with self.assertRaisesRegex(ValueError, "outside declared day/monthly span"):
            self.build()

    def test_bad_count_stops_before_publish(self):
        self.doc["expected_counts"]["daily_filled_rows"] = 23
        self.save()
        with self.assertRaisesRegex(ValueError, "daily audit count"):
            self.build()
        self.assertFalse((self.root / "panel.csv").exists())

    def test_manifest_and_source_sha_tamper_stop(self):
        self.sha = "0" * 64
        with self.assertRaisesRegex(ValueError, "manifest SHA"):
            self.build()
        self.sha = hashlib.sha256(self.m.read_bytes()).hexdigest()
        self.doc["entries"][0]["sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "pinned manifest"):
            self.build()

    def test_unlisted_files_ignored_and_known404_not_retried(self):
        extra = self.daily / "TUSDT" / "TUSDT-1h-2020-01-17.zip"
        extra.write_bytes(b"unlisted content must never be opened")
        self.assertEqual(self.build()["daily_source_files"], 1)

    def test_duplicate_manifest_and_wrong_day_stop(self):
        self.doc["entries"].append(self.doc["entries"][0].copy())
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate daily manifest"):
            self.build()
        self.doc["entries"].pop()
        self.doc["entries"][0]["day"] = "2020-01-15"
        self.save()
        # Expected canonical filename is absent, even though a different day exists.
        with self.assertRaises(FileNotFoundError):
            self.build()


    def test_eligibility_recomputed_from_recovered_prior_days(self):
        rows = [r.copy() for r in self.rows]
        for r in rows[16 * 24:]:
            r[7] = 0  # 14 low days versus 15 high days in the original warmup
        put(self.root, "klines", "TUSDT", "2020-01", rows[:15 * 24] + rows[16 * 24:])
        baseline = self.root / "baseline.csv"
        bn.build(self.root, ["TUSDT"], "2020-01", "2020-01", baseline)
        self.build()
        with baseline.open() as f:
            old = list(csv.DictReader(f))
        with (self.root / "panel.csv").open() as f:
            new = list(csv.DictReader(f))
        self.assertEqual(old[-1]["eligible"], "0")  # median prior volume 4.8m
        self.assertEqual(new[-1]["eligible"], "1")  # restored day makes it 9.6m
        self.assertEqual(old[-1]["funding"], new[-1]["funding"])

    def test_duplicate_daily_row_stops(self):
        self.source(self.target + [self.target[0]])
        self.manifest()
        with self.assertRaisesRegex(ValueError, "duplicate daily row"):
            self.build()

    def test_checksum_filename_and_nonfinite_value_stop(self):
        checksum = self.path.with_name(self.path.name + ".CHECKSUM")
        checksum.write_text(self.digest + "  wrong-name.zip\n")
        with self.assertRaisesRegex(ValueError, "checksum filename"):
            self.build()
        bad = [r.copy() for r in self.target]
        bad[0][7] = float("nan")
        self.source(bad)
        self.manifest()
        with self.assertRaisesRegex(ValueError, "non-finite daily"):
            self.build()


if __name__ == "__main__":
    unittest.main()
