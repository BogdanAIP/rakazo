"""Offline tests for the J15 early-fail comparison around the pinned `run` and `null` CLI (synthetic data only)."""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import math
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search
import j15_precheck_v40 as j15

DAY = 86_400_000
EXPECT = {"library": "r3-f1", "search_end": None, "seed": 302, "population": 10, "generations": 3, "nulls": 3}


class J15Precheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="j15-"))
        panels = []
        for name, seed in (("a", 7), ("b", 8)):
            src = cls.tmp / f"{name}.csv"
            search.synthesize_regime_daily(src, symbols=24, days=650, seed=seed, volume_plant=0.15)
            panel = bench.load_panel(src)
            t0 = panel.times[0]
            bench.freeze_config(panel, 0.25, cls.tmp / f"{name}.cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                holdout_start_ts=t0 + 550 * DAY, search_end_ts=t0 + 400 * DAY)
            panels.append((src, cls.tmp / f"{name}.cfg.json", t0))
        (a, acfg, _), (b, bcfg, t0) = panels
        start = dt.datetime.fromtimestamp((t0 + 150 * DAY) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        common = ["--library", "r3-f1", "--panel", str(a), "--config", str(acfg), "--extra-panel", str(b),
                  "--extra-config", str(bcfg), "--extra-folds", "3", "--extra-start", start, "--population", "10",
                  "--generations", "3", "--seed", "302"]
        captured, original = [], search.search

        def spy(*a, **kw):
            ev, hist = original(*a, **kw)
            captured.append(ev)
            return ev, hist

        search.search = spy
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                search.main(["run", *common, "--explore-ledger", str(cls.tmp / "run.jsonl"), "--report",
                             str(cls.tmp / "run.json"), "--promote-out", str(cls.tmp / "promote.json"), "--round", "t"])
        finally:
            search.search = original
        cls.seen_max = max(r["fitness"] for r in captured[0].seen.values())
        with contextlib.redirect_stdout(io.StringIO()):
            search.main(["null", *common, "--first-null", "0", "--runs", "2", "--explore-ledger",
                         str(cls.tmp / "n0.jsonl"), "--out", str(cls.tmp / "n0.json")])
            search.main(["null", *common, "--first-null", "2", "--runs", "1", "--explore-ledger",
                         str(cls.tmp / "n2.jsonl"), "--out", str(cls.tmp / "n2.json")])
        cls.R = (cls.tmp / "run.json").read_bytes()
        cls.N = [(cls.tmp / "n0.json").read_bytes(), (cls.tmp / "n2.json").read_bytes()]
        EXPECT["search_end"] = json.loads(acfg.read_text())["search_end_utc"]

    @classmethod
    def tearDownClass(cls):
        search.use_library("r2")
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def check(self, run=None, nulls=None, **kw):
        return j15.check(self.R if run is None else run, self.N if nulls is None else nulls, dict(EXPECT, **kw))

    def with_null_best(self, seed, value):
        reps = [json.loads(b) for b in self.N]
        for rep in reps:
            for r in rep["runs"]:
                if r["null_seed"] == seed:
                    r["best_fitness"] = value
        return [json.dumps(r).encode() for r in reps]

    def real(self):
        return max(h["best_fitness"] for h in json.loads(self.R)["history"])

    def test_pinned_outputs_give_a_verdict(self):
        res = self.check()
        self.assertIn(res["verdict"], ("EARLY_FAIL", "NO_EARLY_FAIL"), res)
        self.assertEqual(res["real_best"], self.real())
        nulls = [r["best_fitness"] for b in self.N for r in json.loads(b)["runs"]]
        self.assertEqual(res["null_max"], max(nulls))
        self.assertEqual(res["verdict"] == "EARLY_FAIL", self.real() <= max(nulls))

    def test_history_max_is_the_evaluator_max(self):
        # the unfiltered real best J3 compares is max over every evaluated genome; bitwise equal here
        self.assertEqual(self.real().hex(), self.seen_max.hex())

    def test_tie_is_early_fail_and_blocks(self):
        res = self.check(nulls=self.with_null_best(1, self.real()))
        self.assertEqual(res["verdict"], "EARLY_FAIL", res)
        self.assertIn(1, res["blocking"])

    def test_neighbouring_floats(self):
        x = self.real()
        above = self.with_null_best(2, math.nextafter(x, math.inf))
        self.assertEqual(self.check(nulls=above)["blocking"][-1], 2)
        low = [json.loads(b) for b in self.N]
        for rep in low:
            for r in rep["runs"]:
                r["best_fitness"] = math.nextafter(x, -math.inf)
        res = self.check(nulls=[json.dumps(r).encode() for r in low])
        self.assertEqual(res["verdict"], "NO_EARLY_FAIL", res)

    def test_missing_or_duplicate_or_extra_seed(self):
        self.assertEqual(self.check(nulls=self.N[:1])["verdict"], "INVALID")
        self.assertEqual(self.check(nulls=[self.N[0], self.N[0], self.N[1]])["verdict"], "INVALID")
        self.assertEqual(j15.check(self.R, self.N, dict(EXPECT, nulls=2))["verdict"], "INVALID")

    def test_settings_must_match_plan(self):
        for key, val in (("seed", 303), ("population", 11), ("generations", 2), ("library", "r2"),
                         ("search_end", "2000-01-01T00:00:00Z"), ("search_end", "bad")):
            self.assertEqual(j15.check(self.R, self.N, dict(EXPECT, **{key: val}))["verdict"], "INVALID", key)

    def test_malformed_run_report(self):
        rep = json.loads(self.R)
        cases = []
        r = json.loads(self.R); r["history"] = r["history"][:-1]; cases.append(r)
        r = json.loads(self.R); r["history"][1]["best_fitness"] = r["history"][0]["best_fitness"] - 1; cases.append(r)
        r = json.loads(self.R); r["history"][0], r["history"][1] = r["history"][1], r["history"][0]; cases.append(r)
        r = json.loads(self.R); r["evaluated"] += 1; cases.append(r)
        r = json.loads(self.R); r["extra"] = 1; cases.append(r)
        r = json.loads(self.R); r["library_sha256"] = "0" * 64; cases.append(r)
        r = json.loads(self.R); r["history"][0]["evaluated_total"] = 11; cases.append(r)
        for c in cases:
            self.assertEqual(self.check(run=json.dumps(c).encode())["verdict"], "INVALID", c)
        self.assertEqual(rep, json.loads(self.R))
        nan = self.R.replace(b'"best_fitness": ', b'"best_fitness": NaN, "x": ', 1)
        self.assertEqual(self.check(run=nan)["verdict"], "INVALID")
        self.assertEqual(self.check(run=b'{"round": 1, "round": 2}')["verdict"], "INVALID")

    def test_malformed_null_report(self):
        r = json.loads(self.N[0]); r["runs"][0]["evaluated"] = 31
        self.assertEqual(self.check(nulls=[json.dumps(r).encode(), self.N[1]])["verdict"], "INVALID")
        r = json.loads(self.N[0]); r["runs"][0]["null_seed"] = True
        self.assertEqual(self.check(nulls=[json.dumps(r).encode(), self.N[1]])["verdict"], "INVALID")
        r = json.loads(self.N[0]); r["population"] = 10.0
        self.assertEqual(self.check(nulls=[json.dumps(r).encode(), self.N[1]])["verdict"], "INVALID")
        self.assertEqual(self.check(nulls=self.with_null_best(0, 1e10))["verdict"], "INVALID")

    def test_cli_exit_codes(self):
        argv = ["--run-report", str(self.tmp / "run.json"), "--null-report", str(self.tmp / "n0.json"),
                "--null-report", str(self.tmp / "n2.json"), "--library", "r3-f1", "--search-end",
                EXPECT["search_end"], "--seed", "302", "--population", "10", "--generations", "3", "--nulls", "3"]
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            code = j15.main(argv)
        res = json.loads(buf.getvalue())
        self.assertEqual(code, {"EARLY_FAIL": 0, "NO_EARLY_FAIL": 2}[res["verdict"]])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(j15.main(argv[:-1] + ["4"]), 1)


if __name__ == "__main__":
    unittest.main()
