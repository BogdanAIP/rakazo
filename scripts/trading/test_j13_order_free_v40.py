"""Offline tests for the J13 order-free check: the pinned evaluate_validation runs with synthetic
summaries (harness from test_validation_batch_order_v40); no network, no market data."""
from __future__ import annotations

import itertools
import json
import math
import random
import unittest

import algorithm_bench_v40 as bench
import j13_order_free_v40 as j13
from test_validation_batch_order_v40 import BatchOrderCase


class TestJ13OrderFree(BatchOrderCase):
    def run_and_check(self, order, ledger, prior_rows=()):
        ledger.write_text("".join(json.dumps(r) + "\n" for r in prior_rows))
        prior = j13.prior_sharpes(bench.read_ledger(ledger), self.panel.sha)
        reps = self.run_batch(order, ledger)
        batch = {r["hypothesis_sha256"]: r["sharpe_annual_gate"] for r in reps.values()}
        return {rid: (r, j13.check(r, self.cfg["gate"], batch, prior)) for rid, r in reps.items()}

    def test_gpt_three_rule_counterexample_is_order_free(self):
        """GPT 23:37: 3.5 passes when first (DSR 0.957) and not after 6.0 (0.928); J13 as first
        written kept that dependence. The subset check gives FAIL in both orders."""
        a, b, c = self.hyp("a", 3.5), self.hyp("b", 6.0), self.hyp("c", 4.75)
        first = self.run_and_check([a, b, c], self.tmp / "abc.jsonl")["a"]
        second = self.run_and_check([b, a, c], self.tmp / "bac.jsonl")["a"]
        self.assertAlmostEqual(first[0]["selection"]["deflated_sharpe"], 0.957220, places=6)
        self.assertAlmostEqual(second[0]["selection"]["deflated_sharpe"], 0.927716, places=6)
        self.assertEqual((first[0]["verdict"], second[0]["verdict"]), ("PASS_VALIDATION", "INCONCLUSIVE_UNPOWERED"))
        self.assertEqual(first[1], second[1])
        self.assertEqual(first[1]["status"], "FAIL")
        self.assertAlmostEqual(first[1]["worst_dsr"], 0.927716, places=6)
        self.assertEqual(first[1]["subsets"], 4)

    def test_same_result_in_every_order_and_never_looser(self):
        rng = random.Random(13)
        prior_rows = [{"region": "validation", "panel_sha256": self.panel.sha, "hypothesis_sha256": f"p{i}",
                       "sharpe_annual_gate": rng.uniform(-1, 2)} for i in range(4)]
        for trial in range(4):
            hyps = [self.hyp(f"t{trial}r{i}", rng.uniform(1.5, 7.0)) for i in range(4)]
            seen = {}
            for k, order in enumerate(itertools.permutations(hyps)):
                for rid, (rep, res) in self.run_and_check(list(order), self.tmp / f"t{trial}-{k}.jsonl",
                                                          prior_rows).items():
                    self.assertNotEqual(res["status"], "UNDEFINED")
                    self.assertEqual(res["subsets"], 8)
                    self.assertLessEqual(res["worst_dsr"], rep["selection"]["deflated_sharpe"] + 1e-15)
                    if res["status"] == "PASS":
                        self.assertEqual(rep["verdict"], "PASS_VALIDATION")
                    seen.setdefault(rid, set()).add((res["status"], round(res["worst_dsr"], 12)))
            self.assertTrue(all(len(v) == 1 for v in seen.values()), seen)

    def test_strong_batch_still_passes(self):
        reps = self.run_and_check([self.hyp("s1", 9.0), self.hyp("s2", 9.5)], self.tmp / "s.jsonl")
        self.assertEqual({res["status"] for _, res in reps.values()}, {"PASS"})


class TestJ13FailsClosed(BatchOrderCase):
    def setUp(self):
        super().setUp()
        self.a, self.b = self.hyp("a", 9.0), self.hyp("b", 9.5)
        reps = self.run_batch([self.a, self.b], self.tmp / "l.jsonl")
        self.rep = reps["a"]
        self.batch = {r["hypothesis_sha256"]: r["sharpe_annual_gate"] for r in reps.values()}
        self.gate = self.cfg["gate"]
        self.assertEqual(j13.check(self.rep, self.gate, self.batch, {})["status"], "PASS")

    def status(self, rep=None, batch=None, prior=None):
        return j13.check(rep or self.rep, self.gate, self.batch if batch is None else batch,
                         {} if prior is None else prior)["status"]

    def test_nonfinite_or_missing_inputs(self):
        other = next(k for k in self.batch if k != self.rep["hypothesis_sha256"])
        for bad in (math.nan, math.inf, "9.0", True):
            self.assertEqual(self.status(batch={**self.batch, other: bad}), "UNDEFINED")
            self.assertEqual(self.status(prior={"p": bad}), "UNDEFINED")
        self.assertEqual(self.status(batch={other: 9.5}), "UNDEFINED")  # candidate not in batch
        self.assertEqual(self.status(batch={self.rep["hypothesis_sha256"]: 9.0}), "UNDEFINED")  # single rule
        rep = json.loads(json.dumps(self.rep))
        del rep["selection"]
        self.assertEqual(self.status(rep=rep), "UNDEFINED")
        rep = json.loads(json.dumps(self.rep))
        rep["summary"]["by_cost_bp_per_side"]["10"]["skew"] = math.nan
        self.assertEqual(self.status(rep=rep), "UNDEFINED")

    def test_member_without_sharpe_is_never_a_predecessor(self):
        other = next(k for k in self.batch if k != self.rep["hypothesis_sha256"])
        res = j13.check(self.rep, self.gate, {**self.batch, other: None}, {})
        self.assertEqual((res["status"], res["subsets"]), ("PASS", 1))

    def test_non_pass_verdict_is_not_eligible(self):
        rep = dict(self.rep, verdict="FUNDING_UNKNOWN")
        self.assertEqual(self.status(rep=rep), "FAIL")


if __name__ == "__main__":
    unittest.main()
