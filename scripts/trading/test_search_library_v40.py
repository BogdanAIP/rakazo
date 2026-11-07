"""Offline tests for search libraries: r2 unchanged, r3 family F1 (price-volume, liquidity)."""
from __future__ import annotations

import json
import random
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search

DAY = 86_400_000
R2_SHA = "8fc57b4b32ca7e25453d6f77b1e69d702488264a853fec99aa2edbe62a545219"
R3_F1_SHA = "f74bcd81e4f6efc31d9397efb67c8118e0a835716c9bed4c0b5386998946ad0f"


class LibraryCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bench-library-"))
        src = cls.tmp / "volume.csv"
        search.synthesize_regime_daily(src, symbols=30, days=900, seed=23, volume_plant=0.15)
        cls.panel = bench.load_panel(src)
        t0 = cls.panel.times[0]
        cls.cfg = bench.freeze_config(cls.panel, 0.25, cls.tmp / "cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                      holdout_start_ts=t0 + 675 * DAY, search_end_ts=t0 + 400 * DAY)
        _, cls.boundary = bench.load_config(cls.tmp / "cfg.json", cls.panel)

    @classmethod
    def tearDownClass(cls):
        search.use_library("r2")
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def tearDown(self):
        search.use_library("r2")


class TestLibraries(LibraryCase):
    def test_r2_is_the_default_and_pinned(self):
        self.assertIs(search.TERMINALS, search.LIBRARIES["r2"])
        self.assertEqual(search.required_terms, frozenset())
        self.assertIn("fund3", search.TERMINALS)
        self.assertEqual(search.library_sha("r2"), R2_SHA)

    def test_r3_drops_funding_and_requires_f1(self):
        self.assertEqual(search.use_library("r3-f1"), R3_F1_SHA)
        self.assertFalse([n for n in search.TERMINALS if n.startswith("fund")])
        self.assertEqual(search.required_terms, frozenset(search.F1))
        self.assertTrue(set(search.F1) <= search.TERMINALS.keys())

    def test_repair_draws_nothing_under_r2(self):
        rng = random.Random(5)
        g = {"blend": [[1, "ret10"]], "h": 5, "w": "equal"}
        state = rng.getstate()
        self.assertIs(search.repair(rng, g), g)
        self.assertEqual(rng.getstate(), state)

    def test_repair_enforces_the_family_and_rejects_foreign_terms(self):
        search.use_library("r3-f1")
        rng = random.Random(5)
        for _ in range(200):
            g = search.repair(rng, search.random_genome(rng))
            self.assertTrue({n for b in search._blends(g) for _, n in b} & search.required_terms)
            search.to_hypothesis(g, "x")
        with self.assertRaises(ValueError):
            search.repair(rng, {"blend": [[-1, "fund3"]], "h": 7, "w": "inverse_vol"})

    def test_largest_genomes_fit_the_dsl_limits(self):
        search.use_library("r3-f1")
        deep = sorted(search.F1, key=lambda n: -len(json.dumps(search.F1[n])))[:3]
        g = {"regime": "mdisp_high", "on": [[1, n] for n in deep], "off": [[-1, n] for n in deep], "h": 1,
             "w": "inverse_vol"}
        search.to_hypothesis(g, "deepest")  # raises if too deep or too many nodes


class TestF1Terms(LibraryCase):
    def test_terms_are_causal(self):
        """A value at bar t must not change when every bar after t is removed."""
        cut = 300
        short = self.panel.truncated(cut)
        for name, expr in search.F1.items():
            full, part = bench.evaluate_expression(expr, self.panel), bench.evaluate_expression(expr, short)
            for s in self.panel.symbols:
                self.assertEqual(full[s][:cut].tobytes(), part[s].tobytes(), name)
            self.assertTrue(any(v == v for v in full[self.panel.symbols[0]]), name)

    def test_cached_scores_equal_compiled_dsl(self):
        search.use_library("r3-f1")
        ev = search.Evaluator(self.panel, self.cfg, self.tmp / "c.jsonl")
        g = {"regime": "mvol_high", "on": [[1, "vrev5"], [-1, "illiq20"]], "off": [[1, "pvcorr20"], [-1, "dilliq"]],
             "h": 3, "w": "equal"}
        direct = bench.evaluate_expression(search.compile_genome(g), ev.panel)
        cached = ev.score(g)
        self.assertTrue(all(direct[s].tobytes() == cached[s].tobytes() for s in ev.panel.symbols))


class TestF1Discovery(LibraryCase):
    def test_planted_volume_effect_needs_f1(self):
        """Returns continue after heavy and reverse after light abnormal volume; volume is
        independent of returns. The r2 library cannot see it; r3-f1 must find it, beat every
        null run of the same library, and pass the separate validation segment."""
        search.use_library("r2")
        ev2, _ = search.search(self.panel, self.cfg, self.tmp / "r2.jsonl", population=30, generations=6, seed=7)
        search.use_library("r3-f1")
        ev3, _ = search.search(self.panel, self.cfg, self.tmp / "r3.jsonl", population=30, generations=6, seed=7)
        best2 = max(r["fitness"] for r in ev2.seen.values())
        best3 = max(r["fitness"] for r in ev3.seen.values())
        self.assertGreater(best3, best2 + 2.0)
        nulls = search.null_calibration(self.panel, self.cfg, self.tmp / "n3.jsonl", 3, population=30,
                                        generations=6, seed=7)
        self.assertGreater(best3, max(r["best_fitness"] for r in nulls))
        g, _ = search.diverse_top(ev3, 1)[0]
        self.assertIn((1, "vrev1"), [tuple(x) for b in search._blends(g) for x in b], search.describe(g))
        h = search.to_hypothesis(g, "f1-1")
        v = bench.evaluate_validation(self.panel, self.cfg, self.boundary, h, self.tmp / "ledger.jsonl",
                                      [bench.hypothesis_sha(h)])
        self.assertEqual(v["verdict"], "PASS_VALIDATION")


if __name__ == "__main__":
    unittest.main()
