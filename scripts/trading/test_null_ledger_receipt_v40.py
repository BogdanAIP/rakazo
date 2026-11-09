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
import null_ledger_receipt_v40 as receipt

DAY = 86_400_000
EXPECT = {"library": "r3-f1", "search_end": None, "seed": 301, "population": 10, "generations": 2, "first_null": 6, "runs": 2}


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
        EXPECT["search_end"] = json.loads(acfg.read_text())["search_end_utc"]

    @classmethod
    def tearDownClass(cls):
        search.use_library("r2")
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def check(self, ledger, report, shas, **kw):
        return receipt.check(ledger, report, shas, dict(EXPECT, **kw))

    def lines(self):
        return self.L.split(b"\n")[:-1]

    def join(self, lines):
        return b"\n".join(lines) + b"\n"

    def test_pinned_null_output_passes(self):
        res = self.check(self.L, self.R, self.shas)
        self.assertEqual(res["verdict"], "RECEIPT_OK", res)
        runs = json.loads(self.R)["runs"]
        self.assertEqual(res["rows"], 2 * sum(r["evaluated"] for r in runs))
        self.assertEqual([s for s, _ in res["runs"]], [6, 7])

    def test_wrong_panel_order_or_sha(self):
        self.assertEqual(self.check(self.L, self.R, self.shas[::-1])["verdict"], "INVALID")
        self.assertEqual(self.check(self.L, self.R, [self.shas[0], "0" * 64])["verdict"], "INVALID")

    def test_deleted_complete_pair(self):
        ls = self.lines()
        self.assertEqual(self.check(self.join(ls[:4] + ls[6:]), self.R, self.shas)["verdict"], "INVALID")
        self.assertEqual(self.check(self.join(ls[:-2]), self.R, self.shas)["verdict"], "INVALID")

    def test_duplicate_genome_replacing_a_pair(self):
        # same row count: a repeated genome pair stands in for a different one
        ls = self.lines()
        res = self.check(self.join(ls[:4] + ls[2:4] + ls[6:]), self.R, self.shas)
        self.assertEqual(res["verdict"], "INVALID")
        self.assertIn("repeated", res["reason"])

    def test_foreign_seed_row(self):
        ls = self.lines()
        row = json.loads(ls[-1])
        row["author"] = "claude-null-71"
        res = self.check(self.join(ls[:-1] + [bench.canonical(row)]), self.R, self.shas)
        self.assertEqual(res["verdict"], "INVALID")
        extra = self.check(self.L + bench.canonical(row) + b"\n", self.R, self.shas)
        self.assertEqual(extra["verdict"], "INVALID")

    def test_genome_and_hypothesis_sha_bound(self):
        ls = self.lines()
        row = json.loads(ls[1])
        row["genome"] = dict(row["genome"], h=row["genome"]["h"] + 1)
        self.assertEqual(self.check(self.join(ls[:1] + [bench.canonical(row)] + ls[2:]), self.R, self.shas)["verdict"],
                         "INVALID")
        row = json.loads(ls[0])
        row["hypothesis_sha256"] = "0" * 64
        self.assertEqual(self.check(self.join([bench.canonical(row)] + ls[1:]), self.R, self.shas)["verdict"], "INVALID")

    def test_report_binds_library_and_counts(self):
        rep = json.loads(self.R)
        rep["library_sha256"] = "0" * 64
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")
        rep = json.loads(self.R)
        rep["runs"][0]["evaluated"] -= 1
        rep["runs"][1]["evaluated"] += 1
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")

    def test_fails_closed_on_bytes(self):
        self.assertEqual(self.check(self.L[:-1], self.R, self.shas)["verdict"], "INVALID")
        ls = self.lines()
        self.assertEqual(self.check(self.join(ls[:3] + [b"{bad"] + ls[4:]), self.R, self.shas)["verdict"], "INVALID")
        self.assertEqual(self.check(self.L, b"{", self.shas)["verdict"], "INVALID")
        self.assertEqual(self.check(self.L, self.R, [self.shas[0]] * 2)["verdict"], "INVALID")

    def test_library_state_restored(self):
        search.use_library("r2")
        before = search.TERMINALS
        self.check(self.L, self.R, self.shas)
        self.assertIs(search.TERMINALS, before)

    # GPT 2026-11-09 21:35 Moscow counterexamples, and the pooled-fitness bound
    def test_counterexamples_are_rejected(self):  # each returned RECEIPT_OK before
        ls = self.lines()
        dup = ls[0].replace(b'"fitness":', b'"fitness":0.0,"fitness":', 1)
        self.assertNotEqual(dup, ls[0])
        res = self.check(self.join([dup] + ls[1:]), self.R, self.shas)
        self.assertEqual(res["verdict"], "INVALID")
        self.assertIn("repeated key", res["reason"])
        row = json.loads(ls[0])
        for field, val in (("fitness", "1.5"), ("fitness", True), ("sharpe_annual_gate", "x"),
                           ("genome", []), ("panel_sha256", self.shas[0].upper())):
            bad = bench.canonical(dict(row, **{field: val}))
            self.assertEqual(self.check(self.join([bad] + ls[1:]), self.R, self.shas)["verdict"], "INVALID", field)
        nan = ls[0].replace(b'"fitness":', b'"fitness":NaN,"x":', 1)
        self.assertEqual(self.check(self.join([nan] + ls[1:]), self.R, self.shas)["verdict"], "INVALID")
        for key, val in (("seed", 302), ("population", 11), ("generations", 3), ("seed", 301.0)):
            rep = dict(json.loads(self.R), **{key: val})
            res = self.check(self.L, json.dumps(rep).encode(), self.shas)
            self.assertEqual(res["verdict"], "INVALID", key)
        rep = dict(json.loads(self.R), library=["r3-f1"])
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")
        rep = dict(json.loads(self.R), extra=1)
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")
        dup = self.R.replace(b'"seed":', b'"seed": 999, "seed":', 1)
        self.assertNotEqual(dup, self.R)
        self.assertEqual(self.check(self.L, dup, self.shas)["verdict"], "INVALID")

    def test_report_must_match_intended_invocation(self):
        for kw in ({"seed": 300}, {"population": 9}, {"generations": 1}, {"first_null": 5}, {"runs": 1}):
            self.assertEqual(self.check(self.L, self.R, self.shas, **kw)["verdict"], "INVALID", kw)

    def test_genuine_maxima_inside_bound_and_edits_outside_rejected(self):
        rows = [json.loads(x) for x in self.lines()]
        rep = json.loads(self.R)
        i = 0
        for run in rep["runs"]:
            bounds = []
            for _ in range(run["evaluated"]):
                bounds.append(receipt._interval(rows[i:i + 2]))
                i += 2
            hi = max(b[1] for b in bounds)
            lo = max(b[0] for b in bounds)
            self.assertTrue(lo - 1e-9 <= run["best_fitness"] <= hi + 1e-9)
            for name, val in (("best_fitness", hi + 0.01), ("best_fitness", lo - 0.01),
                              ("best_sharpe", 99.0), ("top_fitness", [hi + 0.01])):
                bad = json.loads(self.R)
                bad["runs"][rep["runs"].index(run)][name] = val
                res = self.check(self.L, json.dumps(bad).encode(), self.shas)
                self.assertEqual(res["verdict"], "INVALID", (name, val))

    # GPT 2026-11-09 22:21 Moscow: overflow in derived bounds, huge integers, unbound cutoff
    def test_oversized_numbers_rejected_before_arithmetic(self):
        ls = self.lines()
        a, b = json.loads(ls[0]), json.loads(ls[1])
        huge = [bench.canonical(dict(a, fitness=1.7e308, sharpe_annual_gate=-1.7e308)),
                bench.canonical(dict(b, fitness=1.7e308, sharpe_annual_gate=-1.7e308))]
        rep = json.loads(self.R)
        rep["runs"][0]["best_fitness"], rep["runs"][0]["top_fitness"] = 100.0, []
        res = self.check(self.join(huge + ls[2:]), json.dumps(rep).encode(), self.shas)
        self.assertEqual(res["verdict"], "INVALID")  # was RECEIPT_OK (bounds overflowed to +-inf)
        self.assertIn("row 1", res["reason"])
        big = ls[0].replace(b'"fitness":', b'"fitness":' + str(10 ** 400).encode() + b',"x":', 1)
        res = self.check(self.join([big] + ls[1:]), self.R, self.shas)  # raised OverflowError before
        self.assertEqual(res["verdict"], "INVALID")
        for val in (2e9, -2e9, 10 ** 400):
            bad = bench.canonical(dict(a, sharpe_annual_gate=val))
            self.assertEqual(self.check(self.join([bad] + ls[1:]), self.R, self.shas)["verdict"], "INVALID", val)
            rep = json.loads(self.R)
            rep["runs"][0]["best_fitness"] = val
            self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID", val)
        self.assertTrue(receipt._num(-9.0) and receipt._num(1e9) and not receipt._num(float("nan")))

    def test_library_and_cutoff_bound_to_run_plan(self):
        rep = dict(json.loads(self.R), search_end_utc="arbitrary")
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")
        rep = dict(json.loads(self.R), search_end_utc="2000-01-01T00:00:00Z")
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")
        for kw in ({"search_end": "2000-01-01T00:00:00Z"}, {"search_end": "arbitrary"}, {"search_end": None},
                   {"library": "r2"}):
            self.assertEqual(self.check(self.L, self.R, self.shas, **kw)["verdict"], "INVALID", kw)
        rep = dict(json.loads(self.R), library="r2", library_sha256=search.library_sha("r2"))
        self.assertEqual(self.check(self.L, json.dumps(rep).encode(), self.shas)["verdict"], "INVALID")

    def test_cli(self):
        d = self.tmp
        (d / "L.jsonl").write_bytes(self.L)
        (d / "R.json").write_bytes(self.R)
        argv = ["--ledger", str(d / "L.jsonl"), "--report", str(d / "R.json"), "--panel-sha", self.shas[0],
                "--panel-sha", self.shas[1]] + [x for k, v in EXPECT.items() for x in (f"--{k.replace('_', '-')}", str(v))]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(receipt.main(argv), 0)
        self.assertIn("RECEIPT_OK", out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(receipt.main(argv[:-1] + ["3"]), 1)


if __name__ == "__main__":
    unittest.main()
