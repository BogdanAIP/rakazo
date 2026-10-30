"""v15 scientific controls: unique market/day != duplicated signal hypotheses."""
import json
from pathlib import Path
import tempfile
import unittest
from algorithm_research_readiness_v15 import audit
from algorithm_ai_research_v14 import propose
from test_algorithm_ai_research_v14 import candidate,OCT30
from test_algorithm_impact_decay_v15 import impact_proposal
from test_algorithm_manual_runner_v13 import init


class V15ScientificReadinessTests(unittest.TestCase):
    def test_two_hypotheses_cannot_turn_sixty_unique_sources_into_120_events(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"a.json"
            p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+100)
            q=Path(td)/"b.json"
            q.write_text(json.dumps(impact_proposal()))
            propose(study,q,now=OCT30+200)
            result=audit(study)
            self.assertEqual(result["hypotheses_registered"],2)
            self.assertEqual(result["development_max_one_event_per_slot"],30)
            self.assertEqual(result["validation_max_one_event_per_slot"],15)
            self.assertEqual(result["holdout_max_one_event_per_slot"],15)
            self.assertEqual(result["all_days_max_one_event_per_slot"],60)
            self.assertEqual(result["required_qualified_events_for_generalization"],100)
            self.assertFalse(result["can_reach_required_qualified_event_count_with_this_plan"])
            self.assertEqual(result["exploratory_bonferroni_alpha_per_registered_candidate"],"0.025")
            self.assertFalse(result["repeated_predictions_per_slot_are_independent_events"])
            self.assertFalse(result["future_outcome_source_authenticated"])
            self.assertFalse(result["out_of_sample_candidate_signals_implemented"])
            self.assertFalse(result["can_trade"])
            self.assertFalse(result["can_start_paper"])

    def test_unregistered_proposals_cannot_be_scored_or_claimed(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            result=audit(study)
            self.assertEqual(result["hypotheses_registered"],0)
            self.assertEqual(result["verified_source_receipts_so_far"],0)
            self.assertIsNone(result["exploratory_bonferroni_alpha_per_registered_candidate"])
            self.assertEqual(result["status"],"PILOT_DESIGN_SOURCE_ONLY_NO_ALPHA_VALIDATION")


if __name__=="__main__":
    unittest.main()
