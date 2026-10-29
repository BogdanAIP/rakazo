"""Model-proposed executable research hypotheses: sandboxed AST only."""
import json
import tempfile
import unittest
from pathlib import Path

from algorithm_discovery_lab import discover
from algorithm_proposals import read_proposals
from test_alpha_discovery import sample

EXAMPLE=Path(__file__).parents[2]/"docs/trading/ALGORITHM-DISCOVERY-PROPOSALS-v0.json"


class ModelProposalTests(unittest.TestCase):
    def test_three_llm_authored_proposals_validate_and_are_tested(self):
        doc=read_proposals(EXAMPLE)
        self.assertEqual(len(doc["proposals"]),3)
        result,catalog,_=discover(
            sample(1200,0),per_family=8,shifts=9,
            model_proposals=[x["program"] for x in doc["proposals"]]
        )
        self.assertEqual(result["model_proposal_count"],3)
        self.assertEqual(result["hypotheses_evaluated"],27)
        self.assertEqual(result["family_experiments"][-1]["family"],"model_proposals")
        self.assertTrue(all(item["program_sha256"] in catalog
                            for item in doc["proposals"]))
        self.assertIsNone(result["holdout"])
        self.assertFalse(result["scientific_novelty_verified"])
        self.assertEqual(len(result["hypothesis_catalog"]),27)
        self.assertIn("diagnosis",result["family_experiments"][-1])

    def test_arbitrary_executable_code_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"hypotheses.json"
            payload={"schema":"algorithm_discovery_proposals_v0","proposals":[{
                "id":"malicious","hypothesis":"This is deliberately invalid program",
                "program":["exec","import os; os.system('whoami')"]}]}
            p.write_text(json.dumps(payload),encoding="utf-8")
            with self.assertRaises(ValueError):
                read_proposals(p)

    def test_duplicate_and_wrong_schema_fails(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"repeated.json"
            base=read_proposals(EXAMPLE)["proposals"][0]
            payload={"schema":"algorithm_discovery_proposals_v0","proposals":[
                {k:base[k] for k in ("id","hypothesis","program")},
                {k:base[k] for k in ("id","hypothesis","program")}
            ]}
            p.write_text(json.dumps(payload),encoding="utf-8")
            with self.assertRaises(ValueError):
                read_proposals(p)
            payload["schema"]="unexpected"
            p.write_text(json.dumps(payload),encoding="utf-8")
            with self.assertRaises(ValueError):
                read_proposals(p)


if __name__=="__main__":
    unittest.main()
