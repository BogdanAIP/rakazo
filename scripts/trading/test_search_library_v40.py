"""Offline tests for search libraries: r2 unchanged, r3 family F1 (price-volume, liquidity)."""
from __future__ import annotations

import json
import math
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


class TestJ8Replay(LibraryCase):
    CARRY = {"blend": [[-1, "fund3"]], "h": 7, "w": "inverse_vol"}

    def panels(self):
        cls = type(self)
        if not hasattr(cls, "_panels"):
            src = self.tmp / "second.csv"
            search.synthesize_regime_daily(src, symbols=25, days=900, seed=29, volume_plant=0.15)
            second = bench.load_panel(src)
            t0 = second.times[0]
            bench.freeze_config(second, 0.25, self.tmp / "cfg2.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                holdout_start_ts=t0 + 675 * DAY, search_end_ts=t0 + 400 * DAY)
            cfg, _ = bench.load_config(self.tmp / "cfg2.json", second)
            cls._panels = [(self.panel, self.cfg, 2, None), (second, cfg, 3, t0 + 150 * DAY)]
        return cls._panels

    def test_carry_under_r2_against_f1_candidate_under_r3(self):
        """GPT 11-07: the carry reference is not in r3-f1, so each genome is compiled under its
        own library in fresh evaluators; the caller's library is restored afterwards."""
        search.use_library("r3-f1")
        cand = {"blend": [[1, "vrev1"]], "h": 1, "w": "inverse_vol"}
        out = search.j8_replay(self.panels(), self.tmp / "j8.jsonl", self.CARRY, cand, "r3-f1")
        self.assertIs(search.TERMINALS, search.LIBRARIES["r3-f1"])
        self.assertEqual(out["reference"]["library_sha256"], R2_SHA)
        self.assertEqual(out["candidate"]["library_sha256"], R3_F1_SHA)
        for x in out["panels"]:  # staggered tranches: one step per bar whatever the hold
            self.assertEqual(x["matched"], x["reference_steps"])
            self.assertEqual(x["matched"], x["candidate_steps"])
            self.assertGreater(x["matched"], 100)
        self.assertEqual(out["pooled"]["matched"], sum(x["matched"] for x in out["panels"]))
        self.assertEqual(out["verdict"], "NEW")
        self.assertLess(abs(out["pooled"]["rho"]), 0.7)

    def test_a_copy_is_not_new_and_foreign_terms_fail_closed(self):
        same = search.j8_replay(self.panels(), self.tmp / "j8b.jsonl", self.CARRY, self.CARRY, "r2")
        self.assertEqual(same["verdict"], "NOT_NEW")
        self.assertAlmostEqual(same["pooled"]["rho"], 1.0, places=12)
        with self.assertRaises(ValueError):
            search.j8_replay(self.panels(), self.tmp / "j8c.jsonl", self.CARRY, self.CARRY, "r3-f1")
        self.assertIs(search.TERMINALS, search.LIBRARIES["r2"])

    def _patched(self, steps_for):
        """Replaces Evaluator.evaluate with fixed step series (GPT's 11-07 probe)."""
        from unittest import mock

        def fake(ev, genome):
            role = "candidate" if genome != self.CARRY else "reference"
            t, r = steps_for(role)
            return {"fitness": 0.0, "steps_t": t, "returns": r, "sharpe": 0.0, "halves": [0.0], "ic": 0.0,
                    "turnover": 0.0, "periods": len(r)}
        return mock.patch.object(search.Evaluator, "evaluate", fake)

    def test_nonfinite_or_degenerate_series_are_undefined(self):
        """GPT 11-07: one NaN in 12 matched steps gave rho NaN and verdict NEW; must be UNDEFINED."""
        cand = {"blend": [[1, "vrev1"]], "h": 1, "w": "inverse_vol"}
        base = [float(i) for i in range(12)]
        cases = {"nan": base[:3] + [math.nan] + base[4:], "inf": base[:5] + [math.inf] + base[6:],
                 "constant": [1.0] * 12, "constant_inexact": [0.1] * 12,
                 "variance_overflow": [1e300 * (-1) ** i for i in range(12)]}
        for name, cand_r in cases.items():
            with self.subTest(name), self._patched(
                    lambda role, c=cand_r: (list(range(12)), c if role == "candidate" else base)):
                out = search.j8_replay(self.panels(), self.tmp / f"j8-{name}.jsonl", self.CARRY, cand, "r3-f1")
                self.assertEqual(out["verdict"], "UNDEFINED")
                self.assertIsNone(out["pooled"]["rho"])
                self.assertTrue(all(x["rho"] is None for x in out["panels"]))
        # GPT 11-07 12:47: fsum([0.1] * 12) / 12 != 0.1, so only an exact check before centering
        # catches it; the reference side must fail closed too.
        self.assertNotEqual(math.fsum([0.1] * 12) / 12, 0.1)
        with self._patched(lambda role: (list(range(12)), [0.1] * 12 if role == "reference" else base)):
            out = search.j8_replay(self.panels(), self.tmp / "j8-const-ref.jsonl", self.CARRY, cand, "r3-f1")
            self.assertEqual(out["verdict"], "UNDEFINED")
        with self._patched(lambda role: (list(range(12)), base if role == "reference" else base[::-1])):
            out = search.j8_replay(self.panels(), self.tmp / "j8-finite.jsonl", self.CARRY, cand, "r3-f1")
            self.assertAlmostEqual(out["pooled"]["rho"], -1.0, places=12)
            self.assertEqual(out["verdict"], "NOT_NEW")
        big = [x * 1e150 for x in base]  # va * vb overflows; the correlation is still exactly defined
        with self._patched(lambda role: (list(range(12)), big)):
            out = search.j8_replay(self.panels(), self.tmp / "j8-big.jsonl", self.CARRY, cand, "r3-f1")
            self.assertAlmostEqual(out["pooled"]["rho"], 1.0, places=12)
            self.assertEqual(out["verdict"], "NOT_NEW")
        self.assertIs(search.TERMINALS, search.LIBRARIES["r2"])

    def test_unpaired_or_repeated_decision_bars_raise(self):
        cand = {"blend": [[1, "vrev1"]], "h": 1, "w": "inverse_vol"}
        base = [float(i) for i in range(12)]
        for name, steps in {"short": (list(range(11)), base), "repeat": ([0] + list(range(11)), base)}.items():
            with self.subTest(name), self._patched(lambda role, s=steps: s), self.assertRaises(ValueError):
                search.j8_replay(self.panels(), self.tmp / f"j8-{name}.jsonl", self.CARRY, cand, "r3-f1")
        self.assertIs(search.TERMINALS, search.LIBRARIES["r2"])


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
