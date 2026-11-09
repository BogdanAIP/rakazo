"""Offline tests for the full-ledger null receipt around the pinned `null` CLI (synthetic data only)."""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search
from null_ledger_receipt_v40 import check

DAY = 86_400_000


class NullReceipt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="null-receipt-"))
        panels = []
        for name, seed in (("a", 7), ("b", 8)):
            src = cls.tmp / f"{name}.csv"
            search.synthesize_regime_daily(src, symbols=24, days=650, seed=seed, volume_plant=0.15)
            panel = bench.load_panel(src)
            t0 = panel.times[0]
            bench.freeze_config(panel, 0.25, cls.tmp / f"{name}.cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                holdout_start_ts=t0 + 550 * DAY, search_end_ts=t0 + 400 * DAY)
            panels.append((src, cls.tmp / f"{name}.cfg.json", t0))
        cls.shas = [bench.sha256_file(p) for p, _, _ in panels]
        (a, acfg, _), (b, bcfg, t0) = panels
        start = dt.datetime.fromtimestamp((t0 + 150 * DAY) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        cls.ledger, cls.report = cls.tmp / "null.jsonl", cls.tmp / "null.json"
        argv = ["null", "--library", "r3-f1", "--panel", str(a), "--config", str(acfg), "--extra-panel", str(b),
                "--extra-config", str(bcfg), "--extra-folds", "3", "--extra-start", start, "--population", "10",
                "--generations", "2", "--seed", "301", "--first-null", "6", "--runs", "2",
                "--explore-ledger", str(cls.ledger), "--out", str(cls.report)]
        with contextlib.redirect_stdout(io.StringIO()):
            search.main(argv)
        cls.L, cls.R = cls.ledger.read_bytes(), cls.report.read_bytes()

    @classmethod
    def tearDownClass(cls):
        search.use_library("r2")
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def lines(self):
        return self.L.split(b"\n")[:-1]

    def join(self, lines):
        return b"\n".join(lines) + b"\n"

    def test_pinned_null_output_passes(self):
        res = check(self.L, self.R, self.shas)
        self.assertEqual(res["verdict"], "RECEIPT_OK", res)
        runs = json.loads(self.R)["runs"]
        self.assertEqual(res["rows"], 2 * sum(r["evaluated"] for r in runs))
        self.assertEqual([s for s, _ in res["runs"]], [6, 7])

    def test_wrong_panel_order_or_sha(self):
        self.assertEqual(check(self.L, self.R, self.shas[::-1])["verdict"], "INVALID")
        self.assertEqual(check(self.L, self.R, [self.shas[0], "0" * 64])["verdict"], "INVALID")

    def test_deleted_complete_pair(self):
        ls = self.lines()
        self.assertEqual(check(self.join(ls[:4] + ls[6:]), self.R, self.shas)["verdict"], "INVALID")
        self.assertEqual(check(self.join(ls[:-2]), self.R, self.shas)["verdict"], "INVALID")

    def test_duplicate_genome_replacing_a_pair(self):
        # same row count: a repeated genome pair stands in for a different one
        ls = self.lines()
        res = check(self.join(ls[:4] + ls[2:4] + ls[6:]), self.R, self.shas)
        self.assertEqual(res["verdict"], "INVALID")
        self.assertIn("repeated", res["reason"])

    def test_foreign_seed_row(self):
        ls = self.lines()
        row = json.loads(ls[-1])
        row["author"] = "claude-null-71"
        res = check(self.join(ls[:-1] + [bench.canonical(row)]), self.R, self.shas)
        self.assertEqual(res["verdict"], "INVALID")
        extra = check(self.L + bench.canonical(row) + b"\n", self.R, self.shas)
        self.assertEqual(extra["verdict"], "INVALID")

    def test_genome_and_hypothesis_sha_bound(self):
        ls = self.lines()
        row = json.loads(ls[1])
        row["genome"] = dict(row["genome"], h=row["genome"]["h"] + 1)
        self.assertEqual(check(self.join(ls[:1] + [bench.canonical(row)] + ls[2:]), self.R, self.shas)["verdict"],
                         "INVALID")
        row = json.loads(ls[0])
        row["hypothesis_sha256"] = "0" * 64
        self.assertEqual(check(self.join([bench.canonical(row)] + ls[1:]), self.R, self.shas)["verdict"], "INVALID")

    def test_report_binds_library_and_counts(self):
        rep = json.loads(self.R)
        rep["library_sha256"] = "0" * 64
        self.assertEqual(check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")
        rep = json.loads(self.R)
        rep["runs"][0]["evaluated"] -= 1
        rep["runs"][1]["evaluated"] += 1
        self.assertEqual(check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")

    def test_fails_closed_on_bytes(self):
        self.assertEqual(check(self.L[:-1], self.R, self.shas)["verdict"], "INVALID")
        ls = self.lines()
        self.assertEqual(check(self.join(ls[:3] + [b"{bad"] + ls[4:]), self.R, self.shas)["verdict"], "INVALID")
        self.assertEqual(check(self.L, b"{", self.shas)["verdict"], "INVALID")
        self.assertEqual(check(self.L, self.R, [self.shas[0]] * 2)["verdict"], "INVALID")

    def test_library_state_restored(self):
        search.use_library("r2")
        before = search.TERMINALS
        check(self.L, self.R, self.shas)
        self.assertIs(search.TERMINALS, before)


if __name__ == "__main__":
    unittest.main()
