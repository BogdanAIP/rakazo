"""Critic consumes failed development only, never authorizes reuse of holdout."""
import copy
import unittest

from algorithm_operator_lab import load_operators, research
from operator_critique import review
from test_alpha_discovery import sample
from pathlib import Path

IDEAS=(Path(__file__).parents[2] /
       "docs/trading/ALGORITHM-OPERATOR-PROPOSALS-v1.json")


class CritiqueTests(unittest.TestCase):
    def test_failure_trace_has_costs_and_representation_revision(self):
        ideas=load_operators(IDEAS)["operators"]
        experiment=research(sample(1200,0),ideas)
        report=review(experiment)
        self.assertTrue(report["cannot_claim_fresh_validation_by_reusing_same_dataset"])
        self.assertTrue(report["training_and_validation_previously_viewed"])
        self.assertFalse(report["holdout_reexamined"])
        self.assertFalse(report["scientific_novelty_verified"])
        self.assertEqual(len(report["trace"]),3)
        for item in report["trace"]:
            self.assertGreaterEqual(item["modeled_cost_drag_per_bar"],0)
            self.assertIn("representation",item["proposed_representation_change"].lower())

    def test_reject_hypothetical_trading_enabled(self):
        ideas=load_operators(IDEAS)["operators"]
        r=research(sample(1200,0),ideas)
        for key in ("holdout_used","can_submit_orders"):
            bad=copy.deepcopy(r)
            bad[key]=True
            with self.assertRaises(ValueError):
                review(bad)

    def test_critic_refuses_unknown_diagnosis(self):
        r=research(sample(1200,0),load_operators(IDEAS)["operators"])
        r["operators"][0]["diagnosis"]="totally_unverified_claim"
        with self.assertRaises(ValueError):
            review(r)


if __name__=="__main__":
    unittest.main()
