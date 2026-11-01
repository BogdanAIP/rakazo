"""Offline tests for the search / validation / holdout split (bench v40.9)."""
from __future__ import annotations

import csv
import random
import shutil
import tempfile
import unittest
from pathlib import Path

import aggregate_panel_daily_v40 as daily
import algorithm_bench_v40 as bench
from test_algorithm_bench_v40 import FUNDING_CONTRARIAN, random_hypothesis, rows_panel

HOUR = 3_600_000


class SplitCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bench-split-"))
        cls.src = cls.tmp / "planted.csv"
        bench.synthesize(cls.src, symbols=20, bars=2400, seed=12, plant=0.03)
        cls.panel = bench.load_panel(cls.src, tradable_only=True)
        t0 = cls.panel.times[0]
        cls.search_end = t0 + 1200 * HOUR
        cls.holdout = t0 + 1800 * HOUR
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh(self, panel=None, src=None):
        type(self).n += 1
        d = self.tmp / f"case{self.n}"
        d.mkdir()
        panel = panel or self.panel
        cfg = bench.freeze_config(panel, 0.25, d / "cfg.json", {"prior_trials": 0}, holdout_start_ts=self.holdout,
                                  search_end_ts=self.search_end)
        _, b = bench.load_config(d / "cfg.json", panel)
        return d, cfg, b


class TestFreeze(SplitCase):
    def test_calendar_boundaries(self):
        d, cfg, b = self.fresh()
        self.assertEqual((cfg["holdout_start_ts"], cfg["search_end_ts"]), (self.holdout, self.search_end))
        self.assertEqual(b, 1800)
        self.assertEqual(bench.search_index(cfg, self.panel), 1200)
        with self.assertRaises(ValueError):
            bench.freeze_config(self.panel, 0.25, d / "bad.json", holdout_start_ts=self.search_end,
                                search_end_ts=self.holdout)
        with self.assertRaises(ValueError):
            bench.freeze_config(self.panel, 0.25, d / "bad2.json", holdout_start_ts=self.holdout + 1)


class TestLeaks(SplitCase):
    def rewrite_after(self, cut_ts, name):
        rng = random.Random(7)
        with open(self.src) as fh:
            rows = list(csv.reader(fh))
        for row in rows[1:]:
            if int(row[0]) >= cut_ts:
                k = 1 + rng.random()
                for j in (2, 3, 4, 5):
                    row[j] = f"{float(row[j]) * k:.8g}"
        return bench.load_panel(rows_panel(self.tmp, name, rows[1:]) and self.tmp / name, tradable_only=True)

    def test_exploration_ignores_validation_and_holdout(self):
        other = self.rewrite_after(self.search_end, "after-search.csv")
        d1, cfg1, _ = self.fresh()
        d2, cfg2, _ = self.fresh(other)
        rng = random.Random(3)
        for i in range(5):
            h = random_hypothesis(rng, i)
            a = bench.evaluate_exploration(self.panel, cfg1, h, d1 / "x.jsonl")
            b = bench.evaluate_exploration(other, cfg2, h, d2 / "x.jsonl")
            self.assertEqual(a["summary"], b["summary"])

    def test_validation_ignores_holdout_and_starts_at_search_end(self):
        other = self.rewrite_after(self.holdout, "after-holdout.csv")
        d1, cfg1, b1 = self.fresh()
        d2, cfg2, b2 = self.fresh(other)
        h = bench.validate_hypothesis(FUNDING_CONTRARIAN)
        a = bench.evaluate_validation(self.panel, cfg1, b1, h, d1 / "l.jsonl")
        b = bench.evaluate_validation(other, cfg2, b2, h, d2 / "l.jsonl")
        self.assertEqual(a["summary"], b["summary"])
        sim = bench.simulate(self.panel.truncated(b1), h, 1200, b1 - 1, [10])
        self.assertTrue(all(p["t"] >= 1199 for p in sim["periods"]))


class TestCounting(SplitCase):
    def test_only_promoted_rules_count(self):
        d, cfg, b = self.fresh()
        rng = random.Random(5)
        for i in range(30):  # heavy exploration
            bench.evaluate_exploration(self.panel, cfg, random_hypothesis(rng, i), d / "explore.jsonl")
        h = bench.validate_hypothesis(FUNDING_CONTRARIAN)
        rep = bench.evaluate_validation(self.panel, cfg, b, h, d / "ledger.jsonl")
        self.assertEqual(rep["selection"]["trials_counted"], 1)
        self.assertEqual(rep["verdict"], "PASS_VALIDATION")
        other = bench.validate_hypothesis(dict(FUNDING_CONTRARIAN, id="other", horizon_bars=4))
        rep2 = bench.evaluate_validation(self.panel, cfg, b, other, d / "ledger.jsonl")
        self.assertEqual(rep2["selection"]["trials_counted"], 2)

    def test_validation_pass_unlocks_holdout_with_signoff(self):
        d, cfg, b = self.fresh()
        h = bench.validate_hypothesis(FUNDING_CONTRARIAN)
        rep = bench.evaluate_validation(self.panel, cfg, b, h, d / "ledger.jsonl")
        self.assertEqual(rep["verdict"], "PASS_VALIDATION")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.panel, cfg, b, h, d / "ledger.jsonl", d / "claims", d / "signoffs")
        bench.write_signoff(d / "signoffs", rep["hypothesis_sha256"], self.panel.sha, "gpt")
        out = bench.evaluate_holdout(self.panel, cfg, b, h, d / "ledger.jsonl", d / "claims", d / "signoffs")
        self.assertEqual(out["verdict"], "PASS_HOLDOUT")

    def test_exploration_alone_never_unlocks_holdout(self):
        d, cfg, b = self.fresh()
        h = bench.validate_hypothesis(FUNDING_CONTRARIAN)
        bench.evaluate_exploration(self.panel, cfg, h, d / "ledger.jsonl")
        bench.write_signoff(d / "signoffs", bench.hypothesis_sha(h), self.panel.sha, "gpt")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.panel, cfg, b, h, d / "ledger.jsonl", d / "claims", d / "signoffs")


class TestCli(SplitCase):
    def test_explore_and_promote_commands(self):
        d = self.tmp / "cli"
        d.mkdir()
        hyp = d / "h.json"
        hyp.write_text('{"schema":"rakazo_bench_hypothesis_v1","hypotheses":[' +
                       '{"id":"fc","author":"claude","score":["neg",["csrank",["field","funding"]]],'
                       '"horizon_bars":8,"min_symbols":8}]}')
        day = lambda ts: bench.datetime.fromtimestamp(ts / 1000, tz=bench.timezone.utc).strftime("%Y-%m-%d")
        t0 = self.panel.times[0]
        holdout, search = t0 + 75 * 24 * HOUR, t0 + 50 * 24 * HOUR
        bench.main(["freeze", "--panel", str(self.src), "--out", str(d / "cfg.json"), "--prior-trials", "0",
                    "--registered-hyp", str(hyp), "--holdout-start", day(holdout), "--search-end", day(search)])
        bench.main(["explore", "--panel", str(self.src), "--config", str(d / "cfg.json"), "--hyp", str(hyp),
                    "--ledger", str(d / "explore.jsonl"), "--out", str(d / "x.json")])
        bench.main(["promote", "--panel", str(self.src), "--config", str(d / "cfg.json"), "--hyp", str(hyp),
                    "--ledger", str(d / "ledger.jsonl"), "--out", str(d / "v.json")])
        self.assertEqual(bench.read_ledger(d / "explore.jsonl")[0]["region"], "exploration")
        self.assertEqual(bench.read_ledger(d / "ledger.jsonl")[0]["region"], "validation")


class TestDailyAggregate(unittest.TestCase):
    def test_daily_bars_and_funding_states(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            rows = []
            for hh in range(48):
                ts = hh * HOUR
                px = 100 + hh
                fa = "0.001" if hh % 8 == 7 else ""
                fb = "NA" if hh == 30 else ""
                rows.append([ts, "A", px, px + 1, px - 1, px + 0.5, 10, 1, fa, ""])
                rows.append([ts, "B", 5, 5, 5, 5, 2, 0, fb, ""])
            src = td / "h.csv"
            rows_panel(td, "h.csv", rows)
            out = td / "d.csv"
            info = daily.aggregate(src, out)
            self.assertEqual((info["hourly_rows"], info["daily_rows"]), (96, 4))
            p = bench.load_panel(out)
            self.assertEqual((p.bar_ms, p.T), (86_400_000, 2))
            self.assertEqual([p.series["open"]["A"][i] for i in range(2)], [100.0, 124.0])
            self.assertAlmostEqual(p.series["close"]["A"][1], 147.5, places=3)
            self.assertAlmostEqual(p.series["high"]["A"][0], 124.0, places=3)
            self.assertEqual(p.series["volume"]["A"][0], 240.0)
            self.assertAlmostEqual(p.series["funding"]["A"][0], 0.003)
            self.assertEqual(p.settled["A"][0], 1)
            self.assertEqual(p.series["funding"]["B"][0], 0.0)
            self.assertNotEqual(p.series["funding"]["B"][1], p.series["funding"]["B"][1])  # NA day
            self.assertEqual((p.eligible["A"][0], p.eligible["B"][0]), (1, 0))

    def test_rejects_mixed_eligibility_within_a_day(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            rows_panel(td, "h.csv", [[0, "A", 1, 1, 1, 1, 1, 1, "", ""], [HOUR, "A", 1, 1, 1, 1, 1, 0, "", ""],
                                     [24 * HOUR, "A", 1, 1, 1, 1, 1, 0, "", ""]])
            with self.assertRaises(ValueError):
                daily.aggregate(td / "h.csv", td / "d.csv")


if __name__ == "__main__":
    unittest.main()
