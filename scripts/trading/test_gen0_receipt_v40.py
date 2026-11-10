"""Offline tests for the data-free generation-0 receipt around the pinned `run` and `null` CLI (synthetic data only)."""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import random
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search
import gen0_receipt_v40 as gen0

DAY = 86_400_000
POP, GENS = 10, 2


class Gen0Receipt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="gen0-receipt-"))
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
        cls.cfg = acfg
        start = dt.datetime.fromtimestamp((t0 + 150 * DAY) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        common = ["--library", "r3-f1", "--panel", str(a), "--config", str(acfg), "--extra-panel", str(b),
                  "--extra-config", str(bcfg), "--extra-folds", "3", "--extra-start", start,
                  "--population", str(POP), "--generations", str(GENS)]
        cls.out = {}

        def run(tag, *extra):
            d = cls.tmp / tag
            d.mkdir()
            argv = ["run", *common, "--round", "t", "--explore-ledger", str(d / "l.jsonl"),
                    "--report", str(d / "r.json"), "--promote-out", str(d / "p.json"), *extra]
            with contextlib.redirect_stdout(io.StringIO()):
                search.main(argv)
            cls.out[tag] = ((d / "l.jsonl").read_bytes(), (d / "r.json").read_bytes())

        run("real", "--seed", "301")
        run("other_seed", "--seed", "302")
        seeds = cls.tmp / "seeds.json"
        seeds.write_text(json.dumps([{"blend": [[1, "pvcorr20"]], "h": 1, "w": "equal"}]))
        run("seeded", "--seed", "301", "--seeds", str(seeds))
        # GPT 11-10 07:27 counterexample: a --seeds file holding exactly the seeded draw.
        search.use_library("r3-f1")
        c0 = json.loads(acfg.read_text())
        bars0 = (c0["holdout_start_ts"] - c0["search_end_ts"]) // DAY
        search.allowed_horizons = [h for h in search.HORIZONS if h * 25 <= bars0] or [search.HORIZONS[0]]
        rng = random.Random(301)
        mimic = cls.tmp / "mimic.json"
        mimic.write_text(json.dumps([search.repair(rng, search.random_genome(rng)) for _ in range(POP)]))
        run("mimic", "--seed", "301", "--seeds", str(mimic))
        d = cls.tmp / "null"
        d.mkdir()
        with contextlib.redirect_stdout(io.StringIO()):
            search.main(["null", *common, "--seed", "301", "--first-null", "6", "--runs", "2",
                         "--explore-ledger", str(d / "l.jsonl"), "--out", str(d / "r.json")])
        cls.out["null"] = ((d / "l.jsonl").read_bytes(), (d / "r.json").read_bytes())
        c = json.loads(acfg.read_text())
        cls.bars = (c["holdout_start_ts"] - c["search_end_ts"]) // DAY

    @classmethod
    def tearDownClass(cls):
        search.use_library("r2")
        search.allowed_horizons = list(search.HORIZONS)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_check(self, tag, seed=301, population=POP, library="r3-f1"):
        return gen0.check(*self.out[tag], "run", library, seed, population, self.bars, 2, GENS)

    def null_check(self, seed=301, population=POP, first=6, runs=2, ledger=None):
        led, rep = self.out["null"]
        return gen0.check(ledger if ledger is not None else led, rep, "null", "r3-f1", seed, population,
                          self.bars, 2, None, first, runs)

    def test_genuine_run_passes(self):
        res = self.run_check("real")
        self.assertEqual(res["verdict"], "GEN0_OK", res)
        self.assertGreater(res["gen0_distinct"], 1)

    def test_seeds_file_rejected(self):
        self.assertEqual(self.run_check("seeded")["verdict"], "INVALID")

    def test_seeds_file_reproducing_the_draw_is_not_detected(self):
        """Scope limit (GPT 07:27): GEN0_OK binds generation 0, not the absence of --seeds."""
        self.assertEqual(self.run_check("mimic")["verdict"], "GEN0_OK")
        real_rows = self.out["real"][0].splitlines()
        mimic_rows = self.out["mimic"][0].splitlines()
        n0 = 2 * self.run_check("real")["gen0_distinct"]
        self.assertEqual([json.loads(r)["genome"] for r in real_rows[:n0]],
                         [json.loads(r)["genome"] for r in mimic_rows[:n0]])

    def test_other_seed_rejected_both_ways(self):
        self.assertEqual(self.run_check("other_seed")["verdict"], "INVALID")
        self.assertEqual(self.run_check("real", seed=302)["verdict"], "INVALID")
        self.assertEqual(self.run_check("other_seed", seed=302)["verdict"], "GEN0_OK")

    def test_wrong_population_or_library_rejected(self):
        self.assertEqual(self.run_check("real", population=POP + 3)["verdict"], "INVALID")
        self.assertEqual(self.run_check("real", population=POP - 3)["verdict"], "INVALID")
        self.assertEqual(self.run_check("real", library="r2")["verdict"], "INVALID")

    def test_null_runs_share_generation_0(self):
        self.assertEqual(self.null_check()["verdict"], "GEN0_OK")
        self.assertEqual(self.null_check(seed=302)["verdict"], "INVALID")
        self.assertEqual(self.null_check(first=5)["verdict"], "INVALID")

    def test_swapped_generation_0_rows_rejected(self):
        led, _ = self.out["null"]
        ls = led.split(b"\n")[:-1]
        swapped = ls[2:4] + ls[0:2] + ls[4:]
        self.assertEqual(self.null_check(ledger=b"\n".join(swapped) + b"\n")["verdict"], "INVALID")
        self.assertEqual(self.null_check(ledger=led[:-1])["verdict"], "INVALID")

    def test_module_state_restored(self):
        search.use_library("r2")
        search.allowed_horizons = list(search.HORIZONS)
        gen0.expected_gen0("r3-f1", 301, POP, self.bars)
        self.assertEqual(search.allowed_horizons, list(search.HORIZONS))
        self.assertIs(search.TERMINALS, search.LIBRARIES["r2"])

    def test_cli(self):
        led, rep = self.out["real"]
        (self.tmp / "cl.jsonl").write_bytes(led)
        (self.tmp / "cr.json").write_bytes(rep)
        base = ["--ledger", str(self.tmp / "cl.jsonl"), "--report", str(self.tmp / "cr.json"), "--library", "r3-f1",
                "--config", str(self.cfg), "--bar-ms", str(DAY), "--panels", "2", "--population", str(POP),
                "--generations", str(GENS), "--kind", "run"]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(gen0.main(base + ["--seed", "301"]), 0)
            self.assertEqual(gen0.main(base + ["--seed", "302"]), 1)


if __name__ == "__main__":
    unittest.main()
