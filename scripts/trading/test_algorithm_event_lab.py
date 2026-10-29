"""Causality, accounting, finite-state semantics and adversarial falsification."""
import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest

from alpha_discovery import Candle
from algorithm_discovery_lab import base_features
from algorithm_event_lab import (
    State, development, distinguishing_witness, eventize, interpret, load,
    replay, semantic_hash, step, strict_json, validate,
)

PROPOSALS = Path(__file__).parents[2]/"docs/trading/ALGORITHM-EVENT-PROPOSALS-v2.json"


def event(trigger=0, confirm=0, hot=False, calm=False):
    return {"trigger":trigger,"confirm":confirm,"hot":hot,"calm":calm}


def bars(n=1200):
    start = datetime(2024,1,1,tzinfo=timezone.utc)
    return [Candle(start+timedelta(minutes=15*i),100,101,99,100,100) for i in range(n)]


class EventControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proposals = load(PROPOSALS)

    def test_four_fixed_semantically_distinct_definitions(self):
        self.assertEqual(len(self.proposals),4)
        self.assertEqual(len({semantic_hash(x) for x in self.proposals}),4)
        self.assertEqual(sum(x["role"] == "candidate" for x in self.proposals),2)

    def test_event_is_not_a_trade_and_later_confirmation_is_required(self):
        d=self.proposals[0]
        a,trace=interpret(d,[event(1,1),event(0,1),event(0,1)])
        self.assertEqual(a,[0,1,1])
        self.assertEqual([x["to"] for x in trace],["watch","active"])

    def test_contradiction_erases_pending_evidence(self):
        a,_=interpret(self.proposals[0],[event(1),event(0,-1),event(0,1)])
        self.assertEqual(a,[0,0,0])
        other,_=interpret(self.proposals[3],[event(1),event(0,-1),event(0,1)])
        self.assertEqual(other,[0,0,1])

    def test_reversal_requires_two_separate_rejection_observations(self):
        a,_=interpret(self.proposals[1],[event(1),event(0,-1),event(0,-1)])
        self.assertEqual(a,[0,0,-1])
        b,_=interpret(self.proposals[1],[event(1),event(0,-1),event(0,1),event(0,-1)])
        self.assertEqual(b,[0,0,0,0])

    def test_lease_expires_despite_repeated_favorable_evidence(self):
        a,trace=interpret(self.proposals[0],[event(1),event(0,1)]+[event(0,1)]*40)
        self.assertEqual(sum(x!=0 for x in a),12)
        self.assertEqual(a[13],0)
        self.assertTrue(any(x["reason"]=="expired" for x in trace))

    def test_hot_regime_shortens_and_calm_never_renews_deadline(self):
        d=self.proposals[0]
        s=State("active",1,12,0)
        s,action,_=step(d,s,event(hot=True))
        self.assertEqual((s.remaining,action),(3,1))
        for remaining in (2,1):
            s,action,_=step(d,s,event(calm=True))
            self.assertEqual((s.remaining,action),(remaining,1))
        s,action,reason=step(d,s,event(calm=True))
        self.assertEqual((action,reason),(0,"expired"))

    def test_expiry_beats_confirmation_at_the_deadline(self):
        d=self.proposals[0]
        s,action,reason=step(d,State("watch",1,1,7),event(0,1))
        self.assertEqual((s.name,action,reason),("cooldown",0,"expired"))

    def test_no_same_bar_reversal_of_open_exposure(self):
        a,_=interpret(self.proposals[0],[event(1),event(0,1),event(-1,-1)])
        self.assertEqual(a,[0,1,0])

    def test_detector_latches_and_requires_release_before_same_event(self):
        d=copy.deepcopy(self.proposals[0])
        d["features"]["impulse"]=["feature","return"]
        table={x:[0.0]*6 for x in base_features(bars(6))}
        table["return"]=[.5,.5,.5,0,.5,-.5]
        e=eventize(d,table,warmup=0)
        self.assertEqual([x["trigger"] for x in e],[1,0,0,0,1,-1])

    def test_future_mutation_cannot_change_previous_actions(self):
        original=bars()
        modified=list(original)
        c=modified[700]
        modified[700]=Candle(c.time,100,105,95,104,10000)
        for d in self.proposals:
            a,_=interpret(d,eventize(d,base_features(original)))
            b,_=interpret(d,eventize(d,base_features(modified)))
            self.assertEqual(a[:700],b[:700])

    def test_reserved_holdout_is_not_even_passed_to_feature_builder(self):
        class Guarded(list):
            def __getitem__(self, index):
                if isinstance(index,slice) and (index.stop is None or index.stop>960):
                    raise AssertionError("Holdout accessed")
                if isinstance(index,int) and (index<0 or index>=960):
                    raise AssertionError("Holdout accessed")
                return super().__getitem__(index)
        result=development(Guarded(bars()),self.proposals,[])
        self.assertFalse(result["holdout_used"])
        self.assertFalse(result["fresh_validation"])
        self.assertEqual(result["reserved_range"],[960,1200])

    def test_constant_target_pays_one_roundtrip_not_every_bar(self):
        b=bars(20)
        r=replay(b,[1]*20)
        self.assertEqual(r["entries"],1)
        self.assertEqual(r["executions"],2)
        self.assertAlmostEqual(r["cost_drag"],.00014)
        self.assertAlmostEqual(r["net_return"],-.00014)

    def test_next_open_fill_does_not_capture_preentry_gap(self):
        b=bars(3)
        b[1]=Candle(b[1].time,110,112,109,111,100)
        b[2]=Candle(b[2].time,111,112,110,111,100)
        r=replay(b,[1,0,0],side_cost=0)
        self.assertAlmostEqual(r["net_return"],.1*(111/110-1))
        self.assertEqual(r["changes"][0]["fill_bar"],1)

    def test_held_gap_is_included_and_drawdown_is_marked(self):
        b=bars(4)
        b[2]=Candle(b[2].time,80,81,79,80,100)
        b[3]=Candle(b[3].time,100,101,99,100,100)
        r=replay(b,[1,1,0,0],side_cost=0)
        self.assertAlmostEqual(r["net_return"],0)
        self.assertAlmostEqual(r["max_drawdown"],.02)

    def test_reversal_charges_exit_and_entry(self):
        r=replay(bars(4),[1,-1,0,0])
        self.assertEqual((r["entries"],r["executions"]),(2,4))
        self.assertAlmostEqual(r["cost_drag"],.00028)
        r2=replay(bars(4),[1,-1,0,0],side_cost=.0014)
        self.assertAlmostEqual(r2["cost_drag"],2*r["cost_drag"])

    def test_all_flat_is_a_real_zero_cost_control(self):
        r=replay(bars(100),[0]*100)
        self.assertEqual((r["net_return"],r["cost_drag"],r["entries"]),(0,0,0))

    def test_concrete_counterexample_even_sparse_controller_can_lose(self):
        e=[event(1),event(0,1),event(-1,-1),event()]
        actions,_=interpret(self.proposals[0],e)
        b=bars(4)
        b[2]=Candle(b[2].time,100,101,95,96,100)
        b[3]=Candle(b[3].time,96,97,95,96,100)
        r=replay(b,actions)
        self.assertEqual(r["entries"],1)
        self.assertLess(r["net_return"],-.004)

    def test_minimal_semantic_witness_is_replayable(self):
        w=distinguishing_witness(self.proposals[0],self.proposals[2])
        self.assertEqual(w["status"],"DISTINGUISHED")
        self.assertEqual(len(w["events"]),1)
        self.assertEqual(interpret(self.proposals[0],w["events"])[0],w["left_actions"])
        self.assertNotEqual(w["left_actions"],w["right_actions"])

    def test_search_budget_is_not_reported_as_proof(self):
        r=distinguishing_witness(self.proposals[0],self.proposals[0],budget=1)
        self.assertEqual(r["status"],"INCONCLUSIVE_BUDGET")

    def test_exact_finite_equivalence_for_unreachable_exposure_control(self):
        d=copy.deepcopy(self.proposals[0])
        d["states"]["idle"]["rules"]=[]
        w=distinguishing_witness(d,d,budget=100)
        self.assertEqual(w["status"],"EQUIVALENT_ABSTRACT_TRANSDUCERS")

    def test_code_unknown_fields_negative_lag_nonfinite_and_renewal_rejected(self):
        bad=[]
        d=copy.deepcopy(self.proposals[0]);d["code"]="print('unsafe')";bad.append(d)
        d=copy.deepcopy(self.proposals[0]);d["features"]["impulse"]=["eval","code"];bad.append(d)
        d=copy.deepcopy(self.proposals[0]);d["features"]["impulse"]=["lag",-1,["feature","return"]];bad.append(d)
        d=copy.deepcopy(self.proposals[0]);d["detector"]["enter"]=float("nan");bad.append(d)
        d=copy.deepcopy(self.proposals[0]);d["states"]["active"]["ttl"]=None;bad.append(d)
        d=copy.deepcopy(self.proposals[0]);d["states"]["active"]["rules"][0]["to"]="active";bad.append(d)
        for d in bad:
            with self.assertRaises(ValueError):validate(d)

    def test_renamed_duplicate_and_duplicate_json_keys_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"proposals.json"
            d=copy.deepcopy(self.proposals[0]);d["id"]="new-label"
            path.write_text(json.dumps({"schema":"event_controller_proposals_v2","operators":[self.proposals[0],d]}))
            with self.assertRaises(ValueError):load(path)
            path.write_text('{"x":1,"x":2}')
            with self.assertRaises(ValueError):strict_json(path)


if __name__=="__main__":
    unittest.main()
