"""Offline tests: how promotion order inside one validation batch affects the selection
statistics of the pinned bench (v40.9). No network, no market data.

simulate/summarize are replaced by fixed synthetic summaries so only the selection code in
evaluate_validation runs. The pinned behaviour recorded here: the trial count covers the
whole batch from its first rule, but the cross-trial Sharpe variance uses only ledger rows
already written plus the rule itself, so it depends on batch order. A single-candidate batch
(the r2 handoff) has no such dependence."""
from __future__ import annotations

import json
import random
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import algorithm_bench_v40 as bench

PPY, N = 365, 200
FLOOR = PPY / N  # null sampling variance of the annual Sharpe, the variance lower bound


def fake_summary(sharpe_annual: float) -> dict:
    g = {"sharpe_annual": sharpe_annual, "sharpe_period_lr": sharpe_annual / PPY ** 0.5, "skew": 0.0,
         "kurtosis": 3.0, "mean_bp": 1.0, "n_effective": 180}
    return {"periods": N, "periods_per_year": PPY, "funding_unknown_share": 0.0, "ic_mean": 0.01,
            "folds": [{"net_mean_bp": 1.0}] * 3 + [{"net_mean_bp": -1.0}], "power": {"mde_sharpe_annual": 3.0},
            "by_cost_bp_per_side": {"10": g}}


class BatchOrderCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="bench-order-"))
        self.panel = SimpleNamespace(T=500, sha="synthetic-panel")
        self.cfg = {"gate": dict(bench.DEFAULT_GATE), "search_end_utc": "s", "holdout_start_utc": "h"}
        self.sharpe = {}
        patches = [mock.patch.object(bench, "search_index", lambda cfg, panel: 100),
                   mock.patch.object(bench, "simulate", lambda dev, hyp, **kw: hyp["id"]),
                   mock.patch.object(bench, "summarize", lambda sim, *a: fake_summary(self.sharpe[sim]))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def hyp(self, rid: str, sharpe: float) -> dict:
        self.sharpe[rid] = sharpe  # distinct windows give distinct hypothesis SHAs
        return bench.validate_hypothesis({"id": rid, "score": ["csrank", ["sum", ["field", "ret"], len(self.sharpe) + 1]],
                                          "horizon_bars": 1})

    def run_batch(self, hyps, ledger: Path):
        shas = [bench.hypothesis_sha(h) for h in hyps]
        return {r["hypothesis"]["id"]: r for r in
                (bench.evaluate_validation(self.panel, self.cfg, 500, h, ledger, shas) for h in hyps)}


class TestBatchOrder(BatchOrderCase):
    def test_trial_count_covers_whole_batch_in_any_order(self):
        a, b = self.hyp("a", 3.0), self.hyp("b", 8.0)
        for i, order in enumerate(([a, b], [b, a])):
            reps = self.run_batch(order, self.tmp / f"l{i}.jsonl")
            self.assertEqual({r["selection"]["trials_counted"] for r in reps.values()}, {2})

    def test_pinned_variance_depends_on_batch_order(self):
        """Pinned behaviour, not a target: the same rule passes when promoted first and is
        deflated by a later-listed stronger rule when promoted second."""
        a, b = self.hyp("a", 3.0), self.hyp("b", 8.0)
        first = self.run_batch([a, b], self.tmp / "ab.jsonl")["a"]
        second = self.run_batch([b, a], self.tmp / "ba.jsonl")["a"]
        self.assertAlmostEqual(first["selection"]["var_annual_sharpe_used"], FLOOR)
        self.assertAlmostEqual(second["selection"]["var_annual_sharpe_used"], 12.5)
        self.assertEqual(first["verdict"], "PASS_VALIDATION")
        self.assertEqual(second["verdict"], "INCONCLUSIVE_UNPOWERED")

    def test_single_candidate_ignores_order_of_prior_ledger_rows(self):
        """The r2 shape: one candidate after an earlier batch on the same panel."""
        rng = random.Random(40)
        prior = [{"region": "validation", "panel_sha256": self.panel.sha, "hypothesis_sha256": f"p{i}",
                  "sharpe_annual_gate": rng.uniform(-1, 1)} for i in range(5)]
        prior.append({"region": "validation", "panel_sha256": "other-panel", "hypothesis_sha256": "x",
                      "sharpe_annual_gate": 50.0})
        selections = set()
        for k in range(6):
            rows = prior[:]
            rng.shuffle(rows)
            ledger = self.tmp / f"prior{k}.jsonl"
            ledger.write_text("".join(json.dumps(r) + "\n" for r in rows))
            rep = self.run_batch([self.hyp("c", 2.5)], ledger)["c"]
            sel = rep["selection"]
            selections.add((sel["trials_counted"], round(sel["var_annual_sharpe_used"], 12),
                            round(sel["deflated_sharpe"], 12), rep["verdict"]))
        self.assertEqual(len(selections), 1)
        self.assertEqual(next(iter(selections))[0], 6)  # five priors on this panel + the candidate

    def test_variance_never_below_null_floor(self):
        hyps = [self.hyp(f"n{i}", 0.5 + 0.01 * i) for i in range(5)]
        for r in self.run_batch(hyps, self.tmp / "near.jsonl").values():
            self.assertGreaterEqual(r["selection"]["var_annual_sharpe_used"], FLOOR - 1e-12)


if __name__ == "__main__":
    unittest.main()
