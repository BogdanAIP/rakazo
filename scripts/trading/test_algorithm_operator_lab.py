"""Algorithm operator invention: safe declarative state and failure diagnostics."""
import copy
import json
import math
import tempfile
import unittest
from pathlib import Path

from alpha_discovery import Candle
from algorithm_discovery_lab import base_features
from algorithm_operator_lab import (
    causal_operator, direction, fingerprint, load_operators,
    null_maximum, probe_signature, research, validate_operator,
)
from test_alpha_discovery import sample

PROPOSALS = (Path(__file__).parents[2] /
             "docs/trading/ALGORITHM-OPERATOR-PROPOSALS-v1.json")


class OperatorDiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=load_operators(PROPOSALS)
        cls.proposals=cls.data["operators"]

    def test_model_proposed_three_distinct_new_state_rules(self):
        self.assertEqual(len(self.proposals),3)
        self.assertEqual(len({fingerprint(x) for x in self.proposals}),3)
        self.assertEqual(len({probe_signature(x) for x in self.proposals}),3)
        self.assertTrue(all(x["parent_id"] and x["failure_addressed"]
                            for x in self.proposals))
        self.assertFalse(self.data["science_level_novelty_verified"])

    def test_new_memory_operator_is_strictly_causal(self):
        original=sample(1200,0.013)
        modified=list(original)
        c=modified[850]
        modified[850]=Candle(c.time,c.op,c.hi*2,c.lo*0.1,c.cl,c.volume*20)
        for op in self.proposals:
            a,_=causal_operator(op,base_features(original))
            b,_=causal_operator(op,base_features(modified))
            self.assertEqual(a[:850],b[:850])
            self.assertEqual(len(a),1200)

    def test_reset_is_real_dynamic_transition(self):
        first=copy.deepcopy(self.proposals[0])
        first["innovation"]=["feature","return"]
        first["reset_when"]=["feature","location"]
        first["reset_threshold"]=0.2
        first["decay"]=0.5
        first["gain"]=1.0
        table={"return":[0.5,0.5,0.5,0.5],
               "location":[0.0,0.0,1.0,0.0]}
        series,resets=causal_operator(first,table)
        self.assertEqual(resets,[2])
        self.assertAlmostEqual(series[0],0.5)
        self.assertAlmostEqual(series[1],0.75)
        self.assertAlmostEqual(series[2],0.5)
        self.assertAlmostEqual(series[3],0.75)

    def test_model_text_cannot_add_executable_code(self):
        invalid=copy.deepcopy(self.proposals[0])
        invalid["code"]="import os"
        with self.assertRaises(ValueError):
            validate_operator(invalid)
        invalid=copy.deepcopy(self.proposals[0])
        invalid["innovation"]=["eval","__import__('os')"]
        with self.assertRaises(ValueError):
            validate_operator(invalid)
        invalid=copy.deepcopy(self.proposals[0])
        invalid["innovation"]=["lag",-1,["feature","return"]]
        with self.assertRaises(ValueError):
            validate_operator(invalid)

    def test_nan_infinity_and_out_of_range_rejected(self):
        for name,value in (("decay",float("nan")),
                           ("gain",float("inf")),
                           ("decay",1.0),
                           ("state_limit",-0.5)):
            invalid=copy.deepcopy(self.proposals[0])
            invalid[name]=value
            with self.assertRaises(ValueError):
                validate_operator(invalid)
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/"bad.json"
            f.write_text('{"schema":"operator_discovery_proposals_v1","operators":NaN}')
            with self.assertRaises(ValueError):
                load_operators(f)

    def test_flat_market_rejects_all_and_leaves_holdout_unread(self):
        report=research(sample(1200,0),self.proposals)
        self.assertEqual(report["decision"],"FALSIFIED_REVISE_OPERATOR_MECHANISM")
        self.assertEqual(report["operator_count"],3)
        self.assertFalse(report["holdout_used"])
        self.assertFalse(report["can_submit_orders"])
        self.assertEqual(report["reserved_holdout_range"],[960,1200])
        self.assertTrue(all("diagnosis" in x for x in report["operators"]))

    def test_holdout_mutation_does_not_change_results(self):
        bars=sample(1200,0.013)
        changed=list(bars)
        for i in range(1000,1010):
            c=changed[i]
            changed[i]=Candle(c.time,c.op,c.hi*10,c.lo*0.2,c.cl,c.volume*10)
        a=research(bars,self.proposals)
        b=research(changed,self.proposals)
        self.assertEqual(a,b)

    def test_negative_control_bounds_and_its_limitations(self):
        n=1200
        actions=[direction([0.3 if i%2 else 0 for i in range(n)])]
        returns=[0.01 if i%3==0 else -0.001 for i in range(n)]
        outcome=null_maximum(actions,returns,720,960,1.0,seed=42)
        self.assertGreater(outcome["max_null_p_exploratory"],0)
        self.assertLessEqual(outcome["max_null_p_exploratory"],1)
        self.assertFalse(outcome["formal_familywise_error_control"])

    def test_immutable_duplicate_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/"dupes.json"
            f.write_text(json.dumps({
                "schema":"operator_discovery_proposals_v1",
                "operators":[self.proposals[0],self.proposals[0]]
            }))
            with self.assertRaises(ValueError):
                load_operators(f)


if __name__ == "__main__":
    unittest.main()
