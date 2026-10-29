"""Research engine tests: causal synthesis, family pivot, no orders or proof claims."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from algorithm_discovery_lab import (
    FAMILIES, actions, base_features, discover, empirical_max_null, evaluate,
    generate, identity, next_bar_returns, novelty_summary, reveal_holdout_once,
    run_audited, score, validate_ast,
)
from test_alpha_discovery import sample

import random


class SynthesisTests(unittest.TestCase):
    def test_programs_are_structurally_distinct_across_families(self):
        rng=random.Random(5)
        hashes=set()
        ops=set()
        for family in FAMILIES:
            programs=[generate(family,rng) for _ in range(12)]
            for ast in programs:
                validate_ast(ast)
                hashes.add(identity(ast))
                ops.add(ast[0])
        self.assertGreaterEqual(len(hashes),25)
        self.assertIn("if_pos",ops)
        self.assertGreaterEqual(len(ops),2)

    def test_unsafe_programs_are_rejected_not_evaled(self):
        bad=[
            ["eval","__import__('os').system('whoami')"],
            ["feature","news_surprise"],  # no source/news timestamp exists yet
            ["lag",-1,["feature","return"]],
            ["mean",10000,["feature","return"]],
            ["if_pos",["feature","body"]],
        ]
        for x in bad:
            with self.subTest(program=x),self.assertRaises(ValueError):
                validate_ast(x)
        too_deep=["feature","return"]
        for _ in range(8):
            too_deep=["neg",too_deep]
        with self.assertRaises(ValueError):
            validate_ast(too_deep)

    def test_all_transformations_are_strictly_causal(self):
        candles=sample(1200,0.013)
        modified=list(candles)
        bar=modified[850]
        from alpha_discovery import Candle
        modified[850]=Candle(bar.time,bar.op,bar.hi*2,bar.lo*0.5,
                             bar.cl,bar.volume)
        old,new=base_features(candles),base_features(modified)
        rng=random.Random(17)
        for family in FAMILIES:
            for _ in range(10):
                ast=generate(family,rng)
                a=evaluate(ast,old)
                b=evaluate(ast,new)
                self.assertEqual(a[:850],b[:850])
                self.assertEqual(len(a),len(b))

    def test_next_bar_entry_is_future_open_not_earlier_close(self):
        candles=sample(1200,0.013)
        outcomes=next_bar_returns(candles)
        self.assertAlmostEqual(outcomes[15],
                               candles[16].cl/candles[16].op-1)
        self.assertEqual(len(outcomes),len(candles))
        a=[0]*len(candles)
        a[15]=1
        result=score(a,outcomes,15,25)
        self.assertEqual(result["trades"],1)
        self.assertAlmostEqual(result["mean_pnl_per_bar"],
                               0.1*(outcomes[15]-0.0014)/9)

    def test_negative_result_pivots_representations_and_skips_holdout(self):
        result,catalog,outcomes=discover(sample(1200,0),seed=42,
                                         per_family=8,shifts=9)
        self.assertEqual(result["status"],"NO_VALIDATED_DISCOVERY")
        self.assertEqual(result["hypotheses_evaluated"],24)
        self.assertEqual([x["family"] for x in result["family_experiments"]],
                         list(FAMILIES))
        self.assertTrue(all(x["family_status"]=="FALSIFIED_PIVOT_NEXT_FAMILY"
                            for x in result["family_experiments"]))
        self.assertIsNone(result["holdout"])
        self.assertFalse(result["can_submit_orders"])
        self.assertFalse(result["scientific_novelty_verified"])
        self.assertEqual(len(catalog),24)

    def test_changing_reserved_future_does_not_change_search(self):
        base=sample(1200,0.013)
        altered=list(base)
        from alpha_discovery import Candle
        for i in range(1010,1017):
            c=altered[i]
            altered[i]=Candle(c.time,c.op,c.hi*2,c.lo*0.1,c.cl,c.volume)
        a,_,_=discover(base,seed=9,per_family=8,shifts=9)
        b,_,_=discover(altered,seed=9,per_family=8,shifts=9)
        self.assertEqual(a["family_experiments"],b["family_experiments"])
        self.assertEqual(a["provisional_candidates"],b["provisional_candidates"])
        self.assertEqual(a["discovery_summary"],b["discovery_summary"])

    def test_behavioral_novelty_is_not_scientific_novelty(self):
        arr=[1,0,-1,1,0]*240
        report=novelty_summary({
            "structA":arr, "structB":arr[:], "structC":[-x for x in arr]
        },0,1200)
        self.assertEqual(report["unique_structures"],3)
        self.assertEqual(report["unique_behaviors"],2)

    def test_max_null_never_claims_proof(self):
        actions=[[1]*1200,[-1]*1200]
        outcomes=[0.01 if i%3==0 else -0.009 for i in range(1200)]
        null=empirical_max_null(actions,outcomes,720,960,
                                observed=0.1,rng=random.Random(1),shifts=9)
        self.assertGreater(null["p"],0)
        self.assertLessEqual(null["p"],1)
        self.assertFalse(null["scientific_significance_proven"])
        self.assertIn("family_shortlist",null["multiple_selection_adjustment"])

    def test_holdout_can_only_be_revealed_once(self):
        result,acts,outcomes=discover(sample(1200,0.0),per_family=8,shifts=9)
        fake=copy.deepcopy(result)
        pid=next(iter(acts))
        fake["provisional_candidates"]=[{"program_id":pid}]
        reveal_holdout_once(fake,acts,outcomes)
        self.assertIsNotNone(fake["holdout"])
        with self.assertRaises(ValueError):
            reveal_holdout_once(fake,acts,outcomes)

    def test_persistent_registry_claim_blocks_research_reuse(self):
        candles=sample(1200,0)
        with tempfile.TemporaryDirectory() as d:
            csv_path=Path(d)/"research.csv"
            output=Path(d)/"run1.json"
            fakehash=hashlib.sha256(b"fixture").hexdigest()
            with patch("run_alpha_audited.verify_snapshot",
                       return_value=(candles,{"source":"official_archive"},fakehash)):
                a=run_audited(csv_path,Path(d)/"ledger",output,
                              seed=7,per_family=8,shifts=9)
                self.assertFalse(a["can_submit_orders"])
                self.assertTrue(output.exists())
                self.assertEqual(a["status"],"NO_VALIDATED_DISCOVERY")
                with self.assertRaises(FileExistsError):
                    run_audited(csv_path,Path(d)/"ledger",
                                Path(d)/"run2.json",seed=7,
                                per_family=8,shifts=9)


if __name__=="__main__":
    unittest.main()
