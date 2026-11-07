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
        batch = list(reps.values())
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
        self.rep, self.peer = reps["a"], reps["b"]
        self.gate = self.cfg["gate"]
        self.assertEqual(self.status(), "PASS")

    def status(self, rep=None, peer=None, prior=None, batch=None):
        rep = rep or self.rep
        batch = [rep, peer or self.peer] if batch is None else batch
        return j13.check(rep, self.gate, batch, {} if prior is None else prior)["status"]

    @staticmethod
    def copy(rep):
        return json.loads(json.dumps(rep))

    def test_nonfinite_or_missing_inputs(self):
        for bad in (math.nan, math.inf, "9.0", True):
            peer = self.copy(self.peer)
            peer["sharpe_annual_gate"] = bad
            self.assertEqual(self.status(peer=peer), "UNDEFINED")
            self.assertEqual(self.status(prior={"p": bad}), "UNDEFINED")
        self.assertEqual(self.status(batch=[self.peer]), "UNDEFINED")  # candidate not in batch
        self.assertEqual(self.status(batch=[self.rep]), "UNDEFINED")  # single rule
        self.assertEqual(self.status(batch=[self.rep, self.peer, self.peer]), "UNDEFINED")  # duplicate
        rep = self.copy(self.rep)
        del rep["selection"]
        self.assertEqual(self.status(rep=rep), "UNDEFINED")
        rep = self.copy(self.rep)
        rep["summary"]["by_cost_bp_per_side"]["10"]["skew"] = math.nan
        self.assertEqual(self.status(rep=rep), "UNDEFINED")

    def test_gpt_probe_own_batch_sharpe_none(self):
        """GPT 00:22: the candidate's own batch Sharpe set to None passed; it must match its summary."""
        rep = self.copy(self.rep)
        rep["sharpe_annual_gate"] = None
        self.assertEqual(self.status(rep=rep), "UNDEFINED")
        rep = self.copy(self.rep)
        rep["sharpe_annual_gate"] = 8.0  # differs from summary 9.0
        self.assertEqual(self.status(rep=rep), "UNDEFINED")

    def test_gpt_probe_trial_count(self):
        """GPT 00:22: trials_counted=0 passed; it must be the integer |prior ∪ batch| + configured priors."""
        self.assertEqual(self.rep["selection"]["trials_counted"], 2)
        for bad in (0, 1, 3, 2.0, True, "2", None):
            rep = self.copy(self.rep)
            rep["selection"]["trials_counted"] = bad
            self.assertEqual(self.status(rep=rep), "UNDEFINED", bad)
        # a prior ledger rule not reflected in the report's count
        self.assertEqual(self.status(prior={"p0": 0.5}), "UNDEFINED")
        rep = self.copy(self.rep)
        rep["selection"]["trials_counted"] = 3
        self.assertEqual(self.status(rep=rep, prior={"p0": 0.5}), "PASS")
        self.assertEqual(self.status(rep=rep, prior={"p0": 0.5, rep["hypothesis_sha256"]: 9.0}), "UNDEFINED")
        gate = dict(self.gate, validation_prior_trials=5)
        self.assertEqual(j13.check(self.rep, gate, [self.rep, self.peer], {})["status"], "UNDEFINED")

    def test_gpt_probe_overflow_fails_closed(self):
        """GPT 00:22: a finite prior Sharpe of 1e200 raised OverflowError; it must give UNDEFINED."""
        rep = self.copy(self.rep)
        rep["selection"]["trials_counted"] = 3
        self.assertEqual(self.status(rep=rep, prior={"p0": 1e200}), "UNDEFINED")

    def test_peer_without_sharpe_must_be_insufficient_data(self):
        peer = self.copy(self.peer)
        peer["sharpe_annual_gate"] = None
        self.assertEqual(self.status(peer=peer), "UNDEFINED")  # verdict still PASS_VALIDATION
        peer["verdict"] = "INSUFFICIENT_DATA"
        del peer["selection"]
        res = j13.check(self.rep, self.gate, [self.rep, peer], {})
        self.assertEqual((res["status"], res["subsets"]), ("PASS", 1))

    def test_batch_reports_must_belong_to_panel_and_match_sha(self):
        peer = self.copy(self.peer)
        peer["panel_sha256"] = "other-panel"
        self.assertEqual(self.status(peer=peer), "UNDEFINED")
        peer = self.copy(self.peer)
        peer["hypothesis_sha256"] = "f" * 64
        self.assertEqual(self.status(peer=peer), "UNDEFINED")
        peer = self.copy(self.peer)
        peer["region"] = "exploration"
        self.assertEqual(self.status(peer=peer), "UNDEFINED")
        rep = self.copy(self.rep)
        rep["summary"]["periods"] = 200.0
        self.assertEqual(self.status(rep=rep), "UNDEFINED")

    def test_non_pass_verdict_is_not_eligible(self):
        rep = dict(self.rep, verdict="FUNDING_UNKNOWN")
        self.assertEqual(self.status(rep=rep), "FAIL")


if __name__ == "__main__":
    unittest.main()
