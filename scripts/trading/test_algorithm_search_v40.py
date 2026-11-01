"""Offline tests for the failure-guided search engine (bench v40.9). No network."""
from __future__ import annotations

import csv
import json
import random
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search

DAY = 86_400_000


class SearchCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bench-search-"))
        cls.src = cls.tmp / "planted.csv"
        search.synthesize_regime_daily(cls.src, symbols=30, days=900, seed=17, plant=0.1)
        cls.panel = bench.load_panel(cls.src)
        t0 = cls.panel.times[0]
        cls.cfg = bench.freeze_config(cls.panel, 0.25, cls.tmp / "cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                      holdout_start_ts=t0 + 675 * DAY, search_end_ts=t0 + 400 * DAY)
        _, cls.boundary = bench.load_config(cls.tmp / "cfg.json", cls.panel)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)


class TestCompilation(SearchCase):
    def test_cached_scores_equal_compiled_dsl(self):
        ev = search.Evaluator(self.panel, self.cfg, self.tmp / "x.jsonl")
        rng = random.Random(3)
        for _ in range(12):
            g = search.random_genome(rng)
            hyp = search.to_hypothesis(g, "x")
            direct = bench.evaluate_expression(hyp["score"], ev.panel)
            cached = ev.score(g)
            for s in ev.panel.symbols:
                self.assertEqual(direct[s].tobytes(), cached[s].tobytes(), search.describe(g))

    def test_mutations_stay_valid(self):
        rng = random.Random(5)
        g = search.random_genome(rng)
        for _ in range(300):
            g = search.mutate(rng, g) if rng.random() < 0.8 else search.crossover(rng, g, search.random_genome(rng))
            search.to_hypothesis(g, "x")  # validates depth, nodes and fields


class TestIsolation(SearchCase):
    def test_search_never_reads_past_search_end(self):
        rng = random.Random(9)
        with open(self.src) as fh:
            rows = list(csv.reader(fh))
        for row in rows[1:]:
            if int(row[0]) >= self.cfg["search_end_ts"]:
                k = 1 + rng.random()
                for j in (2, 3, 4, 5):
                    row[j] = f"{float(row[j]) * k:.8g}"
        other_path = self.tmp / "other.csv"
        with open(other_path, "w", newline="") as fh:
            csv.writer(fh, lineterminator="\n").writerows(rows)
        other = bench.load_panel(other_path)
        cfg2 = bench.freeze_config(other, 0.25, self.tmp / "cfg2.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                   holdout_start_ts=self.cfg["holdout_start_ts"], search_end_ts=self.cfg["search_end_ts"])
        a = search.Evaluator(self.panel, self.cfg, self.tmp / "a.jsonl")
        b = search.Evaluator(other, cfg2, self.tmp / "b.jsonl")
        for _ in range(6):
            g = search.random_genome(rng)
            self.assertEqual(a.evaluate(g)["returns"], b.evaluate(g)["returns"])

    def test_beta_neutral_book_has_zero_ex_ante_beta(self):
        w = {"A": 0.25, "B": 0.25, "C": -0.25, "D": -0.25}
        beta = {"A": 1.5, "B": 1.3, "C": 0.8, "D": 0.9}
        out = search.bench.beta_neutralize(w, beta)
        self.assertAlmostEqual(sum(x * beta[s] for s, x in out.items()), 0.0)
        self.assertAlmostEqual(sum(abs(x) for x in out.values()), 1.0)


class TestDiscovery(SearchCase):
    def test_finds_planted_regime_switch_and_it_validates(self):
        """The planted rule (reversal in high market volatility, momentum otherwise) is
        invisible to plain momentum or reversal; the search must find it on the search
        segment alone, and the promoted rule must pass the separate validation segment."""
        known = bench.validate_hypothesis({"id": "rev5", "score": ["neg", ["csrank", ["sum", ["field", "ret"], 5]]],
                                           "horizon_bars": 1})
        k = bench.evaluate_validation(self.panel, self.cfg, self.boundary, known, self.tmp / "known.jsonl")
        self.assertNotEqual(k["verdict"], "PASS_VALIDATION")
        ev, _ = search.search(self.panel, self.cfg, self.tmp / "explore.jsonl", population=40, generations=12, seed=7)
        top = search.diverse_top(ev, 3)
        self.assertTrue(top)
        hyps = [search.to_hypothesis(g, f"r1-{i}") for i, (g, _) in enumerate(top)]
        shas = [bench.hypothesis_sha(h) for h in hyps]
        verdicts = [bench.evaluate_validation(self.panel, self.cfg, self.boundary, h, self.tmp / "ledger.jsonl", shas)
                    ["verdict"] for h in hyps]
        winners = [g for (g, _), v in zip(top, verdicts) if v == "PASS_VALIDATION"]
        self.assertTrue(winners, [search.describe(g) for g, _ in top])
        self.assertTrue(any(g.get("regime") == "mvol_high" for g in winners))
        self.assertGreater(len(bench.read_ledger(self.tmp / "explore.jsonl")), 50)


class TestNullCalibration(SearchCase):
    def test_null_shuffles_only_across_eligible_contracts(self):
        ev = search.Evaluator(self.panel, self.cfg, self.tmp / "n.jsonl", null_seed=3)
        g = {"blend": [[1, "ret10"]], "h": 5, "w": "equal"}
        real, null = ev._score(g), ev.score(g)
        moved = 0
        for t in range(ev.panel.T):
            elig = [s for s in ev.panel.symbols if ev.panel.eligible[s][t]]
            a = sorted(repr(real[s][t]) for s in elig)
            b = sorted(repr(null[s][t]) for s in elig)
            self.assertEqual(a, b)
            moved += sum(1 for s in elig if repr(real[s][t]) != repr(null[s][t]))
            for s in ev.panel.symbols:
                if not ev.panel.eligible[s][t]:
                    self.assertEqual(repr(real[s][t]), repr(null[s][t]))
        self.assertGreater(moved, 0)
        again = search.Evaluator(self.panel, self.cfg, self.tmp / "n2.jsonl", null_seed=3).score(g)
        self.assertTrue(all(again[s].tobytes() == null[s].tobytes() for s in ev.panel.symbols))

    def test_planted_rule_beats_every_null_run(self):
        ev, _ = search.search(self.panel, self.cfg, self.tmp / "real.jsonl", population=30, generations=6, seed=7)
        real = max(r["fitness"] for r in ev.seen.values())
        nulls = search.null_calibration(self.panel, self.cfg, self.tmp / "null.jsonl", 3, population=30,
                                        generations=6, seed=7)
        self.assertGreater(real, max(r["best_fitness"] for r in nulls))
        authors = {e["author"] for e in bench.read_ledger(self.tmp / "null.jsonl")}
        self.assertEqual(authors, {"claude-null-0", "claude-null-1", "claude-null-2"})


class TestPooledPanels(SearchCase):
    def _panel(self, name, seed, plant):
        path = self.tmp / f"{name}.csv"
        search.synthesize_regime_daily(path, symbols=30, days=900, seed=seed, plant=plant)
        panel = bench.load_panel(path)
        t0 = panel.times[0]
        cfg = bench.freeze_config(panel, 0.25, self.tmp / f"{name}-cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                  holdout_start_ts=t0 + 675 * DAY, search_end_ts=t0 + 400 * DAY)
        return panel, cfg, t0

    def test_persistence_across_panels(self):
        b, bcfg, b0 = self._panel("b", 18, 0.1)
        c, ccfg, c0 = self._panel("c", 19, 0.0)
        kw = dict(population=30, generations=6, seed=7)
        single, _ = search.search(self.panel, self.cfg, self.tmp / "s.jsonl", **kw)
        both, _ = search.search(self.panel, self.cfg, self.tmp / "ab.jsonl", extra=[(b, bcfg, 3, b0 + 60 * DAY)], **kw)
        noise, _ = search.search(self.panel, self.cfg, self.tmp / "ac.jsonl", extra=[(c, ccfg, 3, c0 + 60 * DAY)], **kw)
        best = lambda ev: max(r["fitness"] for r in ev.seen.values())  # noqa: E731
        self.assertGreater(best(both), best(noise))  # a rule must hold on every panel
        self.assertGreater(best(single), best(noise))
        g, r = search.diverse_top(both, 1)[0]
        self.assertEqual(len(r["halves"]), 2 + 3)
        self.assertEqual(g.get("regime"), "mvol_high")
        ev_b = both.evs[1]
        self.assertEqual(ev_b.first, 60)
        steps = ev_b.evaluate(g)["steps_t"]
        self.assertGreaterEqual(min(steps), 60)


if __name__ == "__main__":
    unittest.main()
