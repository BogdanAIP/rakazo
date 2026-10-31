"""Offline calibration tests for Algorithm Bench v40. No network, no orders."""
from __future__ import annotations

import csv
import json
import math
import random
import shutil
import statistics
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench

HEADER = ["ts", "symbol", "open", "high", "low", "close", "volume", "eligible", "funding", "oi"]


def synth_panel(directory: Path, name: str, **kw) -> bench.Panel:
    path = directory / name
    bench.synthesize(path, **kw)
    return bench.load_panel(path)


def rows_panel(directory: Path, name: str, rows, header=HEADER) -> bench.Panel:
    path = directory / name
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)
    return bench.load_panel(path)


def same(a, b) -> bool:
    return a.tobytes() == b.tobytes()


def random_expression(rng: random.Random, depth: int = 0):
    if depth >= 3 or rng.random() < 0.3:
        return ["field", rng.choice(bench.FEATURE_FIELDS)]
    op = rng.choice([o for o in bench.OPS if o not in ("field", "const")])
    kind, arity = bench.OPS[op]
    if kind == "window":
        return [op, random_expression(rng, depth + 1), rng.choice([2, 3, 5, 8, 24])]
    if kind == "clip":
        return [op, random_expression(rng, depth + 1), 2.0]
    return [op] + [random_expression(rng, depth + 1) for _ in range(arity)]


def random_hypothesis(rng: random.Random, i: int) -> dict:
    return bench.validate_hypothesis({"id": f"rand-{i}", "author": "test", "score": ["csrank", random_expression(rng)],
                                      "horizon_bars": rng.choice([1, 4, 8, 24]), "min_symbols": 8})


def reference_nonoverlapping(panel, hyp, first_entry, last_exit, costs_bp, penalty_bp=300.0):
    """Independent plain backtest: one position per period, held h bars, no tranches."""
    h = hyp["horizon_bars"]
    score = bench.evaluate_expression(hyp["score"], panel)
    out, prev = [], {}
    t = max(first_entry - 1, 0)
    while t + 1 + h <= last_exit:
        entry, exit_ = t + 1, t + 1 + h
        cohort = [(s, score[s][t]) for s in panel.symbols if score[s][t] == score[s][t]
                  and panel.eligible[s][t] and panel.series["close"][s][t] == panel.series["close"][s][t]]
        if len(cohort) < hyp["min_symbols"]:
            t += h
            continue
        w = bench.target_weights(cohort, hyp)
        gross = fund = 0.0
        held, entered = {}, {}
        for s, wt in w.items():
            res = bench._realized(panel, s, entry, exit_)
            if res is None:
                continue
            entered[s] = wt
            gross += wt * (res[1] / res[0] - 1.0)
            fund -= wt * math.fsum(f for f in panel.series["funding"][s][entry:exit_] if f == f)
            if not res[2]:
                held[s] = wt
        turnover = math.fsum(abs(entered.get(s, 0.0) - prev.get(s, 0.0)) for s in set(entered) | set(prev))
        out.append({"t": t, "weights": w, "gross": gross, "funding": fund, "turnover": turnover})
        prev = held
        t += h
    if out:
        out[-1]["turnover"] += math.fsum(abs(x) for x in prev.values())
    return out


FUNDING_CONTRARIAN = {"id": "funding-contrarian", "author": "claude", "score": ["neg", ["csrank", ["field", "funding"]]],
                      "horizon_bars": 8, "min_symbols": 8}


class BenchTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bench-v40-"))
        cls.null = synth_panel(cls.tmp, "null.csv", symbols=20, bars=1600, seed=11)
        cls.planted = synth_panel(cls.tmp, "planted.csv", symbols=20, bars=1600, seed=12, plant=0.03)
        cls.counter = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh_dir(self, prefix):
        type(self).counter += 1
        d = self.tmp / f"{prefix}-{self.counter}"
        d.mkdir()
        return d

    def fresh_config(self, panel, prefix):
        d = self.fresh_dir(prefix)
        cfg = bench.freeze_config(panel, 0.25, d / "config.json", expect_bar_ms=3_600_000)
        _, boundary = bench.load_config(d / "config.json", panel)
        return d, cfg, boundary


class TestValidation(BenchTestCase):
    def test_rejects_unknown_operator_and_code(self):
        for bad in (["exec", "print(1)"], ["field", "future_close"], ["lag", ["field", "close"], -1],
                    ["lag", ["field", "close"], 1.5], ["std", ["field", "ret"], 1], ["const", float("nan")],
                    ["const", True], ["add", ["field", "close"]], "close", []):
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

    def test_medium_and_three_month_horizon_validation(self):
        for hours in (48, 168, 336, 720, 1440, 2160):
            rule = bench.validate_hypothesis({"id": f"h-{hours}", "score": ["field", "ret"],
                                             "horizon_bars": hours})
            self.assertEqual(rule["horizon_bars"], hours)
        for hours in (0, 2161, -1, 1.5, True):
            with self.assertRaises(ValueError):
                bench.validate_hypothesis({"id": "bad", "score": ["field", "ret"],
                                          "horizon_bars": hours})

    def test_hypothesis_identity_ignores_metadata(self):
        a = bench.validate_hypothesis({"id": "a", "author": "gpt", "score": ["field", "ret"], "horizon_bars": 4})
        b = bench.validate_hypothesis({"id": "b", "author": "claude", "rationale": "x", "score": ["field", "ret"], "horizon_bars": 4})
        c = bench.validate_hypothesis({"id": "a", "score": ["field", "ret"], "horizon_bars": 5})
        self.assertEqual(bench.hypothesis_sha(a), bench.hypothesis_sha(b))
        self.assertNotEqual(bench.hypothesis_sha(a), bench.hypothesis_sha(c))


class TestPanel(BenchTestCase):
    def test_rejects_duplicate_off_grid_and_bad_values(self):
        bar = ["1", "1", "1", "1", "1", "1", "", ""]
        cases = {
            "dup": [[0, "A", *bar], [0, "A", *bar], [60000, "A", *bar]],
            "grid": [[0, "A", *bar], [60000, "A", *bar], [120000, "A", *bar], [150000, "A", *bar]],
            "hl": [[0, "A", "1", "0.5", "1", "1", "1", "1", "", ""], [60000, "A", *bar]],
            "elig": [[0, "A", "1", "1", "1", "1", "1", "2", "", ""], [60000, "A", *bar]],
            "fund": [[0, "A", "1", "1", "1", "1", "1", "1", "n/a", ""], [60000, "A", *bar]],
        }
        for name, rows in cases.items():
            with self.assertRaises(ValueError, msg=name):
                rows_panel(self.tmp, f"{name}.csv", rows)

    def test_missing_bars_and_funding_states(self):
        rows = [[0, "A", 1, 1, 1, 1, 1, 1, "0.001", ""], [180000, "A", 1, 1, 1, 1, 1, 1, "NA", ""],
                [0, "B", 1, 1, 1, 1, 1, 0, "", ""], [60000, "B", 1, 1, 1, 1, 1, 1, "", ""],
                [120000, "B", 1, 1, 1, 1, 1, 1, "", ""]]
        p = rows_panel(self.tmp, "gap.csv", rows)
        self.assertEqual((p.T, p.bar_ms), (4, 60000))
        self.assertTrue(math.isnan(p.series["close"]["A"][1]))
        self.assertTrue(math.isnan(p.series["close"]["B"][3]))
        self.assertEqual(p.series["funding"]["A"][0], 0.001)
        self.assertEqual(p.settled["A"][0], 1)
        self.assertTrue(math.isnan(p.series["funding"]["A"][3]))
        self.assertEqual((p.series["funding"]["B"][1], p.settled["B"][1]), (0.0, 0))
        self.assertEqual(list(p.eligible["B"]), [0, 1, 1, 0])
        last = bench.evaluate_expression(["field", "funding"], p)["A"]
        self.assertEqual(last[0], 0.001)
        self.assertTrue(all(math.isnan(x) for x in last[1:]))  # missing rows and NA reset it

    def test_eligibility_audit(self):
        path = self.tmp / "elig.csv"
        bench.synthesize(path, symbols=4, bars=24 * 70, seed=4)
        panel = bench.load_panel(path)
        implied = bench.recompute_eligibility(panel, usd=24 * 1000 * 0.9, days=30)
        day0 = panel.times[0] // bench.MS_PER_DAY
        with open(path) as fh:
            rows = list(csv.reader(fh))
        for row in rows[1:]:
            row[7] = implied[row[1]][int(row[0]) // bench.MS_PER_DAY - day0]
        good = rows_panel(self.tmp, "elig-good.csv", rows[1:])
        audit = bench.audit_panel(good, 3_600_000, 24 * 1000 * 0.9, 30)
        self.assertEqual(audit["eligibility_check"]["mismatched_rows"], 0)
        self.assertTrue(audit["bar_ms_matches_expected"])
        self.assertGreater(audit["eligible_rows"], 0)
        rows[1][7] = 1 - int(rows[1][7])
        bad = rows_panel(self.tmp, "elig-bad.csv", rows[1:])
        self.assertEqual(bench.audit_panel(bad, None, 24 * 1000 * 0.9, 30)["eligibility_check"]["mismatched_rows"], 1)


    def test_recent_listing_requires_its_own_30_prior_days(self):
        rows = []
        for d in range(61):
            for symbol in ("EARLY", "LATE"):
                if symbol == "LATE" and d < 20:
                    continue
                rows.append((d * bench.MS_PER_DAY, symbol, 1, 1, 1, 1,
                             10_000_000, 0, "", ""))
        panel = rows_panel(self.tmp, "listing-warmup.csv", rows)
        flags = bench.recompute_eligibility(panel, usd=5_000_000, days=30)
        self.assertEqual(flags["EARLY"][29], 0)
        self.assertEqual(flags["EARLY"][30], 1)
        self.assertEqual(flags["LATE"][35], 0)
        self.assertEqual(flags["LATE"][49], 0)
        self.assertEqual(flags["LATE"][50], 1)


class TestOperators(BenchTestCase):
    def test_rolling_windows_match_naive(self):
        rng = random.Random(8)
        for level in (0.0, 1e5):
            xs = [level + rng.gauss(0, 1) for _ in range(400)]
            for i in rng.sample(range(400), 12):
                xs[i] = math.nan
            arr = bench.array("d", xs)
            for n in (2, 5, 24):
                got = {op: bench._ts_op(op, arr, n) for op in ("sum", "mean", "std", "z", "tsrank")}
                for t in range(len(xs)):
                    w = xs[t - n + 1:t + 1] if t >= n - 1 else None
                    if w is None or any(math.isnan(v) for v in w):
                        self.assertTrue(all(math.isnan(got[op][t]) for op in got))
                        continue
                    sd = statistics.stdev(w)
                    tol = 1e-6 * max(1.0, level)
                    self.assertAlmostEqual(got["sum"][t], math.fsum(w), delta=tol * n)
                    self.assertAlmostEqual(got["mean"][t], statistics.fmean(w), delta=tol)
                    self.assertAlmostEqual(got["std"][t], sd, delta=1e-6)
                    self.assertAlmostEqual(got["z"][t], (w[-1] - statistics.fmean(w)) / sd, delta=1e-5)
                    below = sum(v < w[-1] for v in w)
                    equal = sum(v == w[-1] for v in w)
                    self.assertAlmostEqual(got["tsrank"][t], (below + (equal - 1) / 2) / (n - 1) - 0.5)


class TestCausality(BenchTestCase):
    def test_prefix_invariance_for_random_expressions(self):
        """The score at bar t must not change when later bars are removed."""
        rng = random.Random(3)
        for _ in range(60):
            expr = ["csrank", random_expression(rng)]
            full = bench.evaluate_expression(expr, self.null)
            for cut in (200, 517, 900):
                part = bench.evaluate_expression(expr, self.null.truncated(cut))
                for s in self.null.symbols:
                    self.assertTrue(same(full[s][:cut], part[s]), msg=json.dumps(expr))

    def test_future_delisting_does_not_change_decisions(self):
        """Removing a symbol's future rows must not change any earlier cohort or weights."""
        for horizon in (8, 48):
            with self.subTest(horizon=horizon):
                self._delisting_case(dict(FUNDING_CONTRARIAN, horizon_bars=horizon))

    def _delisting_case(self, rule):
        path = self.tmp / "delist-base.csv"
        if not path.exists():
            bench.synthesize(path, symbols=20, bars=600, seed=21)
        base = bench.load_panel(path)
        hyp = bench.validate_hypothesis(rule)
        sim = bench.simulate(base, hyp, 1, base.T - 1, [10])
        probe = next(p for p in sim["periods"] if p["t"] >= 300 and p["weights"])
        victim = max(probe["weights"], key=probe["weights"].get)
        with open(path) as fh:
            rows = list(csv.reader(fh))
        cut_ts = base.times[probe["t"] + 2]
        kept = [r for r in rows[1:] if not (r[1] == victim and int(r[0]) >= cut_ts)]
        gone = rows_panel(self.tmp, f"delist-gone-{hyp['horizon_bars']}.csv", kept)
        sim2 = bench.simulate(gone, hyp, 1, gone.T - 1, [10])
        first = {p["t"]: p for p in sim["periods"]}
        second = {p["t"]: p for p in sim2["periods"]}
        for t in first:
            if t <= probe["t"]:
                self.assertEqual(first[t]["weights"], second[t]["weights"])
                self.assertEqual(first[t]["n"], second[t]["n"])
        self.assertIn(victim, second[probe["t"]]["weights"])
        self.assertGreater(sim2["counts"]["missing_exits"], 0)

    def test_development_report_ignores_holdout_data(self):
        """Rewriting every holdout bar must not change any development metric."""
        src = self.tmp / "null.csv"
        _, cfg, boundary = self.fresh_config(self.null, "leak-a")
        rng = random.Random(5)
        with open(src) as fh:
            rows = list(csv.reader(fh))
        for row in rows[1:]:
            if int(row[0]) >= cfg["holdout_start_ts"]:
                k = 1 + rng.random()
                for j in (2, 3, 4, 5):
                    row[j] = f"{float(row[j]) * k:.8g}"
        other = rows_panel(self.tmp, "altered.csv", rows[1:])
        self.assertNotEqual(other.sha, self.null.sha)
        d2 = self.fresh_dir("leak-b")
        cfg2 = bench.freeze_config(other, 0.25, d2 / "config.json")
        _, boundary2 = bench.load_config(d2 / "config.json", other)
        self.assertEqual(boundary, boundary2)
        rng = random.Random(9)
        da = self.fresh_dir("leak-ledger")
        for i in range(8):
            h = random_hypothesis(rng, i)
            a = bench.evaluate_development(self.null, cfg, boundary, h, da / "a.jsonl")
            b = bench.evaluate_development(other, cfg2, boundary2, h, da / "b.jsonl")
            self.assertEqual(a["summary"], b["summary"])


class TestSimulation(BenchTestCase):
    def flat_panel(self, name, funding_cells, extra_rows=()):
        rows = []
        for t in range(6):
            for s, f in zip(("A", "B", "C"), funding_cells):
                rows.append([t * 60000, s, 1, 1, 1, 1, 1, 1, f, ""])
        rows.extend(extra_rows)
        return rows_panel(self.tmp, name, rows)

    def hyp3(self, score):
        return bench.validate_hypothesis({"id": "x", "score": score, "horizon_bars": 1, "quantile": 0.34, "min_symbols": 3})

    def test_long_pays_positive_funding(self):
        p = self.flat_panel("fund.csv", ("0.001", "-0.001", "0"))
        sim = bench.simulate(p, self.hyp3(["field", "funding"]), 1, 5, [0])
        for period in sim["periods"]:  # long A pays 0.001, short B pays 0.001: 0.5*0.001*2
            self.assertAlmostEqual(period["gross"], 0.0)
            self.assertAlmostEqual(period["funding"], -0.001)
        self.assertEqual(sim["funding_unknown_share"], 0.0)

    def test_unknown_funding_is_counted_and_gates(self):
        p = self.flat_panel("fund-na.csv", ("NA", "NA", "NA"))
        sim = bench.simulate(p, self.hyp3(["neg", ["field", "close"]]), 1, 5, [0])
        self.assertEqual(sim["funding_unknown_share"], 1.0)
        with open(self.tmp / "null.csv") as fh:
            rows = list(csv.reader(fh))
        for row in rows[1:]:
            row[8] = "NA"
        nf = rows_panel(self.tmp, "nofund.csv", rows[1:])
        d2 = self.fresh_dir("fund-gate-2")
        cfg2 = bench.freeze_config(nf, 0.25, d2 / "config.json")
        _, b2 = bench.load_config(d2 / "config.json", nf)
        hyp = bench.validate_hypothesis({"id": "m", "score": ["csrank", ["sum", ["field", "ret"], 24]], "horizon_bars": 8,
                                         "min_symbols": 8})
        self.assertEqual(bench.evaluate_development(nf, cfg2, b2, hyp, d2 / "l.jsonl")["verdict"], "FUNDING_UNKNOWN")

    def test_missing_exit_is_penalised(self):
        rows = []
        for t in range(4):
            for s, px in (("A", 3), ("B", 2), ("C", 1)):
                if s == "A" and t >= 2:
                    continue  # A disappears after entry
                rows.append([t * 60000, s, px, px, px, px, 1, 1, "", ""])
        p = rows_panel(self.tmp, "exit.csv", rows)
        hyp = self.hyp3(["field", "close"])  # long A, short C
        sim = bench.simulate(p, hyp, 1, 2, [0], missing_exit_penalty_bp=300)
        period = sim["periods"][0]
        self.assertEqual(sim["counts"]["missing_exits"], 1)
        self.assertAlmostEqual(period["penalty"], 0.5 * 0.03)
        self.assertAlmostEqual(period["net"]["0"], -0.015)

    def test_ineligible_symbols_never_enter(self):
        rows = []
        for t in range(6):
            for s, px, el in (("A", 3, 0), ("B", 2, 1), ("C", 1, 1), ("D", 4, 1)):
                rows.append([t * 60000, s, px, px, px, px, 1, el, "", ""])
        p = rows_panel(self.tmp, "inel.csv", rows)
        sim = bench.simulate(p, self.hyp3(["field", "close"]), 1, 5, [0])
        for period in sim["periods"]:
            self.assertNotIn("A", period["weights"])
            self.assertEqual(period["n"], 3)

    def test_costs_scale_with_turnover(self):
        _, cfg, boundary = self.fresh_config(self.null, "cost")
        hyp = bench.validate_hypothesis({"id": "flip", "score": ["field", "ret"], "horizon_bars": 1, "min_symbols": 8})
        sim = bench.simulate(self.null.truncated(boundary), hyp, 1, boundary - 1, [0, 10])
        for p in sim["periods"]:
            self.assertAlmostEqual(p["net"]["0"] - p["net"]["10"], p["turnover"] * 10 / 1e4)


class TestStaggeredTranches(BenchTestCase):
    def test_single_tranche_matches_reference_engine(self):
        """With rebalance == horizon the book engine must equal a plain non-overlapping backtest."""
        for h in (1, 8, 24):
            hyp = bench.validate_hypothesis({"id": "x", "score": ["csrank", ["sum", ["field", "ret"], 24]],
                                             "horizon_bars": h, "min_symbols": 8})
            got = bench.simulate(self.null, hyp, 1, self.null.T - 1, [0, 10])
            ref = reference_nonoverlapping(self.null, hyp, 1, self.null.T - 1, [0, 10])
            self.assertEqual(got["tranches"], 1)
            self.assertEqual(len(got["periods"]), len(ref))
            for a, b in zip(got["periods"], ref):
                self.assertEqual((a["t"], a["weights"]), (b["t"], b["weights"]))
                for key in ("gross", "funding", "turnover"):
                    self.assertAlmostEqual(a[key], b[key], places=12)

    def test_book_holds_k_tranches_with_full_gross(self):
        hyp = bench.validate_hypothesis({"id": "x", "score": ["csrank", ["sum", ["field", "ret"], 24]],
                                         "horizon_bars": 96, "rebalance_bars": 24, "min_symbols": 8})
        sim = bench.simulate(self.null, hyp, 1, self.null.T - 1, [10])
        self.assertEqual((sim["tranches"], sim["rebalance_bars"]), (4, 24))
        steady = sim["periods"][5:-5]
        self.assertTrue(steady)
        for p in steady:  # each tranche turns over 1/K of the book per step at most twice
            self.assertLessEqual(p["turnover"], 2 * 1.0 / 4 + 1e-9)

    def test_default_rebalance_is_daily_for_long_holds(self):
        self.assertEqual([bench.default_rebalance(h) for h in (1, 8, 24, 48, 168, 2160, 36)], [1, 8, 24, 24, 24, 24, 12])
        with self.assertRaises(ValueError):
            bench.validate_hypothesis({"id": "x", "score": ["field", "ret"], "horizon_bars": 48, "rebalance_bars": 20})
        a = bench.validate_hypothesis({"id": "x", "score": ["field", "ret"], "horizon_bars": 48})
        b = bench.validate_hypothesis({"id": "x", "score": ["field", "ret"], "horizon_bars": 48, "rebalance_bars": 48})
        self.assertNotEqual(bench.hypothesis_sha(a), bench.hypothesis_sha(b))

    def test_long_run_variance_discounts_overlap(self):
        rng = random.Random(4)
        noise = [rng.gauss(0, 1) for _ in range(4000)]
        k = 10
        overlapping = [math.fsum(noise[i:i + k]) for i in range(len(noise) - k)]
        lrv, g0 = bench.long_run_variance(overlapping, k - 1)
        n_eff = len(overlapping) * g0 / lrv
        self.assertLess(n_eff, len(overlapping) / 4)
        self.assertGreater(n_eff, len(overlapping) / 25)
        lrv_iid, g0_iid = bench.long_run_variance(noise, 5)
        self.assertAlmostEqual(lrv_iid / g0_iid, 1.0, delta=0.15)


class TestCalibration(BenchTestCase):
    def test_noise_rarely_passes(self):
        """Forty random hypotheses on pure noise share one ledger; at most two may pass."""
        d, cfg, boundary = self.fresh_config(self.null, "fp")
        rng = random.Random(21)
        verdicts = [bench.evaluate_development(self.null, cfg, boundary, random_hypothesis(rng, i), d / "l.jsonl")["verdict"]
                    for i in range(40)]
        self.assertLessEqual(verdicts.count("PASS_DEV"), 2, verdicts)
        self.assertEqual(len(bench.read_ledger(d / "l.jsonl")), 40)

    def test_planted_edge_is_found(self):
        d, cfg, boundary = self.fresh_config(self.planted, "tp")
        rep = bench.evaluate_development(self.planted, cfg, boundary, bench.validate_hypothesis(FUNDING_CONTRARIAN),
                                         d / "l.jsonl")
        self.assertEqual(rep["verdict"], "PASS_DEV", json.dumps(rep["summary"]["by_cost_bp_per_side"]["10"]))
        self.assertGreater(rep["summary"]["ic_mean"], 0)

    def test_more_trials_raise_the_bar(self):
        sr, n = 0.15, 300
        one = bench.deflated_sharpe(sr, n, 0.0, 3.0, 1, 1 / n)
        many = bench.deflated_sharpe(sr, n, 0.0, 3.0, 200, 1 / n)
        self.assertGreater(one, 0.99)
        self.assertLess(many, one)

    def test_power_arithmetic(self):
        self.assertEqual(bench.periods_needed(0.1), 785)
        self.assertAlmostEqual(bench.mde_sharpe(785), 0.1, places=3)


class TestHoldoutDiscipline(BenchTestCase):
    def passed(self, prefix):
        d, cfg, boundary = self.fresh_config(self.planted, prefix)
        hyp = bench.validate_hypothesis(FUNDING_CONTRARIAN)
        rep = bench.evaluate_development(self.planted, cfg, boundary, hyp, d / "l.jsonl")
        self.assertEqual(rep["verdict"], "PASS_DEV")
        return d, cfg, boundary, hyp, rep["hypothesis_sha256"]

    def test_holdout_requires_pass_signoff_and_is_one_use(self):
        d, cfg, boundary, hyp, hsha = self.passed("hold")
        untested = bench.validate_hypothesis({"id": "u", "score": ["field", "ret"], "horizon_bars": 8, "min_symbols": 8})
        args = (d / "l.jsonl", d / "claims", d / "signoffs")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, untested, *args)
        with self.assertRaises(PermissionError):  # no sign-off yet
            bench.evaluate_holdout(self.planted, cfg, boundary, hyp, *args)
        bench.write_signoff(d / "signoffs", hsha, self.planted.sha, "gpt", "reviewed")
        rep = bench.evaluate_holdout(self.planted, cfg, boundary, hyp, *args)
        self.assertEqual(rep["verdict"], "PASS_HOLDOUT")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, hyp, *args)

    def test_author_cannot_sign_off_own_hypothesis(self):
        d, cfg, boundary, hyp, hsha = self.passed("self-sign")
        bench.write_signoff(d / "signoffs", hsha, self.planted.sha, "claude")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, hyp, d / "l.jsonl", d / "claims", d / "signoffs")
        with self.assertRaises(ValueError):
            bench.write_signoff(d / "other", hsha, self.planted.sha, "someone")

    def test_holdout_budget(self):
        d, cfg, boundary, hyp, hsha = self.passed("budget")
        (d / "claims").mkdir()
        for i in range(cfg["gate"]["holdout_budget"]):
            (d / "claims" / f"{i}.claim.json").write_text("{}")
        bench.write_signoff(d / "signoffs", hsha, self.planted.sha, "gpt")
        with self.assertRaises(PermissionError):
            bench.evaluate_holdout(self.planted, cfg, boundary, hyp, d / "l.jsonl", d / "claims", d / "signoffs")

    def test_config_refuses_other_panel_wrong_bar_and_overwrite(self):
        d, cfg, boundary = self.fresh_config(self.null, "cfg")
        with self.assertRaises(ValueError):
            bench.load_config(d / "config.json", self.planted)
        with self.assertRaises(FileExistsError):
            bench.freeze_config(self.null, 0.25, d / "config.json")
        with self.assertRaises(ValueError):
            bench.freeze_config(self.null, 0.25, d / "other.json", expect_bar_ms=60_000)


if __name__ == "__main__":
    unittest.main()
