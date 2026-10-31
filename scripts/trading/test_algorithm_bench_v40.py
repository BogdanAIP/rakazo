"""Offline calibration tests for Algorithm Bench v40. No network, no orders."""
from __future__ import annotations

import io
import json
import random
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench


def write_panel(directory: Path, name: str, text: str) -> bench.Panel:
    path = directory / name
    path.write_text(text)
    return bench.load_panel(path)


def random_expression(rng: random.Random, depth: int = 0):
    leaves = [["field", f] for f in bench.FEATURE_FIELDS]
    if depth >= 3 or rng.random() < 0.3:
        return rng.choice(leaves)
    op = rng.choice([o for o in bench.OPS if o not in ("field", "const")])
    kind, arity, _ = bench.OPS[op]
    if kind == "window":
        n = rng.choice([2, 3, 5, 8, 24])
        return [op, random_expression(rng, depth + 1), n]
    if kind == "clip":
        return [op, random_expression(rng, depth + 1), 2.0]
    return [op] + [random_expression(rng, depth + 1) for _ in range(arity)]


def random_hypothesis(rng: random.Random, i: int) -> dict:
    return bench.validate_hypothesis({
        "id": f"rand-{i}",
        "author": "test",
        "score": ["csrank", random_expression(rng)],
        "horizon_bars": rng.choice([1, 4, 8, 24]),
        "min_symbols": 8,
    })


class BenchTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bench-v40-"))
        cls.null = write_panel(cls.tmp, "null.csv", bench.synthesize(symbols=20, bars=1600, seed=11, plant=0.0))
        cls.planted = write_panel(cls.tmp, "planted.csv", bench.synthesize(symbols=20, bars=1600, seed=12, plant=0.02))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh_config(self, panel, name):
        d = self.tmp / name
        d.mkdir()
        cfg = bench.freeze_config(panel, 0.25, d / "config.json")
        _, boundary = bench.load_config(d / "config.json", panel)
        return d, cfg, boundary


class TestValidation(BenchTestCase):
    def test_rejects_unknown_operator_and_code(self):
        for bad in (["exec", "print(1)"], ["field", "future_close"], ["lag", ["field", "close"], -1],
                    ["lag", ["field", "close"], 1.5], ["std", ["field", "ret"], 1], ["const", float("nan")],
                    ["add", ["field", "close"]], "close", []):
            with self.assertRaises(ValueError):
                bench.validate_hypothesis({"id": "x", "score": bad, "horizon_bars": 1})

    def test_rejects_deep_and_extra_fields(self):
        deep = ["field", "close"]
        for _ in range(bench.MAX_DEPTH + 1):
            deep = ["neg", deep]
        with self.assertRaises(ValueError):
            bench.validate_hypothesis({"id": "x", "score": deep, "horizon_bars": 1})
        with self.assertRaises(ValueError):
            bench.validate_hypothesis({"id": "x", "score": ["field", "close"], "horizon_bars": 1, "code": "x"})

    def test_hypothesis_identity_ignores_metadata(self):
        a = bench.validate_hypothesis({"id": "a", "author": "gpt", "score": ["field", "ret"], "horizon_bars": 4})
        b = bench.validate_hypothesis({"id": "b", "author": "claude", "rationale": "x", "score": ["field", "ret"], "horizon_bars": 4})
        c = bench.validate_hypothesis({"id": "a", "score": ["field", "ret"], "horizon_bars": 5})
        self.assertEqual(bench.hypothesis_sha(a), bench.hypothesis_sha(b))
        self.assertNotEqual(bench.hypothesis_sha(a), bench.hypothesis_sha(c))


class TestPanel(BenchTestCase):
    HEADER = "ts,symbol,open,high,low,close,volume\n"

    def test_rejects_duplicate_and_off_grid(self):
        with self.assertRaises(ValueError):
            write_panel(self.tmp, "dup.csv", self.HEADER + "0,A,1,1,1,1,1\n0,A,1,1,1,1,1\n60000,A,1,1,1,1,1\n")
        with self.assertRaises(ValueError):
            write_panel(self.tmp, "grid.csv", self.HEADER + "0,A,1,1,1,1,1\n60000,A,1,1,1,1,1\n"
                        "120000,A,1,1,1,1,1\n150000,A,1,1,1,1,1\n")
        with self.assertRaises(ValueError):
            write_panel(self.tmp, "hl.csv", self.HEADER + "0,A,1,0.5,1,1,1\n60000,A,1,1,1,1,1\n")

    def test_missing_bars_become_gaps(self):
        p = write_panel(self.tmp, "gap.csv", self.HEADER + "0,A,1,1,1,1,1\n180000,A,1,1,1,1,1\n"
                        "0,B,1,1,1,1,1\n60000,B,1,1,1,1,1\n120000,B,1,1,1,1,1\n")
        self.assertEqual((p.T, p.bar_ms), (4, 60000))
        self.assertIsNone(p.series["close"]["A"][1])
        self.assertIsNone(p.series["close"]["B"][3])


class TestCausality(BenchTestCase):
    def test_prefix_invariance_for_random_expressions(self):
        """The score at bar t must not change when later bars are removed."""
        rng = random.Random(3)
        cuts = [200, 517, 900]
        for _ in range(60):
            expr = ["csrank", random_expression(rng)]
            full = bench.evaluate_expression(expr, self.null)
            for cut in cuts:
                part = bench.evaluate_expression(expr, self.null.truncated(cut))
                for s in self.null.symbols:
                    self.assertEqual(full[s][:cut], part[s], msg=json.dumps(expr))

    def test_development_report_ignores_holdout_data(self):
        """Rewriting every holdout bar must not change any development metric."""
        text = bench.synthesize(symbols=20, bars=1600, seed=11, plant=0.0)
        lines = text.splitlines()
        cfg_dir, cfg, boundary = self.fresh_config(self.null, "leak-a")
        cut_ts = cfg["holdout_start_ts"]
        rng = random.Random(5)
        altered = [lines[0]]
        for line in lines[1:]:
            parts = line.split(",")
            if int(parts[0]) >= cut_ts:
                k = 1 + rng.random()
                for j in (2, 3, 4, 5):
                    parts[j] = f"{float(parts[j]) * k:.8g}"
            altered.append(",".join(parts))
        other = write_panel(self.tmp, "altered.csv", "\n".join(altered) + "\n")
        self.assertNotEqual(other.sha, self.null.sha)
        d2 = self.tmp / "leak-b"
        d2.mkdir()
        bench.freeze_config(other, 0.25, d2 / "config.json")
        cfg2, boundary2 = bench.load_config(d2 / "config.json", other)
        self.assertEqual(boundary, boundary2)
        rng = random.Random(9)
        for i in range(8):
            h = random_hypothesis(rng, i)
            a = bench.evaluate_development(self.null, cfg, boundary, h, cfg_dir / "ledger.jsonl")
            b = bench.evaluate_development(other, cfg2, boundary2, h, d2 / "ledger.jsonl")
            self.assertEqual(a["summary"], b["summary"])


class TestCalibration(BenchTestCase):
    def test_noise_rarely_passes(self):
        """Forty random hypotheses on pure noise share one ledger; at most two may pass."""
        d, cfg, boundary = self.fresh_config(self.null, "fp")
        rng = random.Random(21)
        verdicts = [bench.evaluate_development(self.null, cfg, boundary, random_hypothesis(rng, i), d / "ledger.jsonl")["verdict"]
                    for i in range(40)]
        self.assertLessEqual(verdicts.count("PASS_DEV"), 2, verdicts)
        self.assertEqual(len(bench.read_ledger(d / "ledger.jsonl")), 40)

    def test_planted_edge_is_found(self):
        d, cfg, boundary = self.fresh_config(self.planted, "tp")
        hyp = bench.validate_hypothesis({"id": "funding-contrarian", "score": ["neg", ["csrank", ["field", "funding"]]],
                                         "horizon_bars": 8, "min_symbols": 8})
        rep = bench.evaluate_development(self.planted, cfg, boundary, hyp, d / "ledger.jsonl")
        self.assertEqual(rep["verdict"], "PASS_DEV", json.dumps(rep["summary"]["by_cost_bp_per_side"]["6"]))
        self.assertGreater(rep["summary"]["ic_mean"], 0)

    def test_more_trials_raise_the_bar(self):
        sr, n = 0.15, 300
        one = bench.deflated_sharpe(sr, n, 0.0, 3.0, 1, 1 / n)
        many = bench.deflated_sharpe(sr, n, 0.0, 3.0, 200, 1 / n)
        self.assertGreater(one, 0.99)
        self.assertLess(many, one)
        self.assertGreater(bench.expected_max_sharpe(200, 1 / n), bench.expected_max_sharpe(10, 1 / n))

    def test_power_arithmetic(self):
        self.assertEqual(bench.periods_needed(0.1), 785)
        self.assertAlmostEqual(bench.mde_sharpe(785), 0.1, places=3)


class TestSimulation(BenchTestCase):
    def test_long_pays_positive_funding(self):
        header = "ts,symbol,open,high,low,close,volume,funding\n"
        rows = []
        for t in range(6):
            for s, f in (("A", "0.001"), ("B", "-0.001"), ("C", "0")):
                rows.append(f"{t * 60000},{s},1,1,1,1,1,{f}")
        p = write_panel(self.tmp, "fund.csv", header + "\n".join(rows) + "\n")
        hyp = bench.validate_hypothesis({"id": "x", "score": ["field", "funding"], "horizon_bars": 1,
                                         "quantile": 0.34, "min_symbols": 3})
        sim = bench.simulate(p, hyp, first_entry=1, last_exit=5, costs_bp=[0])
        # long A (pays +0.001), short B (receives -0.001 => pays 0.001): 0.5*0.001 + 0.5*0.001
        for period in sim["periods"]:
            self.assertAlmostEqual(period["gross"], 0.0)
            self.assertAlmostEqual(period["funding"], -0.001)

    def test_costs_scale_with_turnover(self):
        d, cfg, boundary = self.fresh_config(self.null, "cost")
        hyp = bench.validate_hypothesis({"id": "flip", "score": ["field", "ret"], "horizon_bars": 1, "min_symbols": 8})
        sim = bench.simulate(self.null.truncated(boundary), hyp, 1, boundary - 1, [0, 10])
        for p in sim["periods"]:
            self.assertAlmostEqual(p["net"]["0"] - p["net"]["10"], p["turnover"] * 10 / 1e4)


class TestHoldoutDiscipline(BenchTestCase):
    def test_holdout_requires_pass_and_is_one_use(self):
        d, cfg, boundary = self.fresh_config(self.planted, "hold")
        good = bench.validate_hypothesis({"id": "funding-contrarian", "score": ["neg", ["csrank", ["field", "funding"]]],
                                          "horizon_bars": 8, "min_symbols": 8})
        untested = bench.validate_hypothesis({"id": "u", "score": ["field", "ret"], "horizon_bars": 8, "min_symbols": 8})
        ledger, claims = d / "ledger.jsonl", d / "claims"
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, untested, ledger, claims)
        self.assertEqual(bench.evaluate_development(self.planted, cfg, boundary, good, ledger)["verdict"], "PASS_DEV")
        rep = bench.evaluate_holdout(self.planted, cfg, boundary, good, ledger, claims)
        self.assertEqual(rep["verdict"], "PASS_HOLDOUT")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, good, ledger, claims)

    def test_holdout_budget(self):
        d, cfg, boundary = self.fresh_config(self.planted, "budget")
        claims = d / "claims"
        claims.mkdir()
        for i in range(cfg["gate"]["holdout_budget"]):
            (claims / f"{i}.claim.json").write_text("{}")
        good = bench.validate_hypothesis({"id": "g", "score": ["neg", ["csrank", ["field", "funding"]]],
                                          "horizon_bars": 8, "min_symbols": 8})
        bench.evaluate_development(self.planted, cfg, boundary, good, d / "ledger.jsonl")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, good, d / "ledger.jsonl", claims)

    def test_config_refuses_other_panel_and_overwrite(self):
        d, cfg, boundary = self.fresh_config(self.null, "cfg")
        with self.assertRaises(ValueError):
            bench.load_config(d / "config.json", self.planted)
        with self.assertRaises(FileExistsError):
            bench.freeze_config(self.null, 0.25, d / "config.json")


if __name__ == "__main__":
    unittest.main()
