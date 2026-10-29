"""Witnesses are reproducible counterexamples, never profitability evidence."""
import unittest
from pathlib import Path
from algorithm_event_audit import audit, price_probe, legacy_witness
from algorithm_event_lab import load, interpret, eventize
from algorithm_discovery_lab import base_features
from algorithm_operator_lab import load_operators, causal_operator, direction

ROOT=Path(__file__).parents[2]/"docs/trading"


class EventAuditTests(unittest.TestCase):
    def test_all_reported_witnesses_reproduce(self):
        proposals=load(ROOT/"ALGORITHM-EVENT-PROPOSALS-v2.json")
        legacy=load_operators(ROOT/"ALGORITHM-OPERATOR-PROPOSALS-v1.json")["operators"]
        result=audit(proposals,legacy)
        self.assertEqual(len(result["abstract_transducer_pairs"]),6)
        by_id={x["id"]:x for x in proposals}
        for w in result["abstract_transducer_pairs"]:
            self.assertEqual(w["status"],"DISTINGUISHED")
            self.assertNotEqual(interpret(by_id[w["left"]],w["events"])[0],
                                interpret(by_id[w["right"]],w["events"])[0])
        old_by_id={x["id"]:x for x in legacy}
        self.assertEqual(len(result["legacy_realizable_price_witnesses"]),6)
        for w in result["legacy_realizable_price_witnesses"]:
            self.assertEqual(w["status"],"DISTINGUISHED_ON_REALIZABLE_PRICE_PROBE")
            table=base_features(price_probe(w["log_return_percent"]))
            d=by_id[w["candidate"]]
            self.assertEqual(interpret(d,eventize(d,table))[0][16:],w["candidate_actions"])
            self.assertEqual(direction(causal_operator(old_by_id[w["legacy"]],table)[0])[16:],w["legacy_actions"])

    def test_sparse_confirmation_is_not_a_guarantee_of_profit(self):
        result=audit(load(ROOT/"ALGORITHM-EVENT-PROPOSALS-v2.json"),[])
        self.assertEqual(len(result["synthetic_loss_counterexamples"]),2)
        for case in result["synthetic_loss_counterexamples"]:
            self.assertEqual(case["result"]["entries"],1)
            self.assertLess(case["result"]["net_return"],0)
        self.assertFalse(result["scientific_novelty_proven"])
        self.assertFalse(result["real_market_data_used"])


if __name__=="__main__":
    unittest.main()
