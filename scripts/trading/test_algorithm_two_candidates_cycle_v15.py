"""v15 both frozen ChatGPT candidates are considered, with no winner selection."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_chatgpt_cycle_v14 import run_cycle
from algorithm_ai_research_v14 import propose
from test_algorithm_ai_research_v14 import candidate,OCT30,NOV01
from test_algorithm_impact_decay_v15 import impact_proposal
from test_algorithm_manual_runner_v13 import init,MEMBERS


class TwoPreregisteredCandidatesTest(unittest.TestCase):
    def test_one_source_yields_two_unscored_hypotheses_not_two_independent_events(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            pa=Path(td)/"a.json";pa.write_text(json.dumps(candidate()))
            pb=Path(td)/"b.json";pb.write_text(json.dumps(impact_proposal()))
            propose(study,pa,now=OCT30+1)
            propose(study,pb,now=OCT30+2)
            record={"observation":{
                "date_utc":"2026-11-01","symbol":MEMBERS[0],
                "status":"SOURCE_VERIFIED_NO_OUTCOME",
                "capture_start_utc_ms":NOV01-2000}}
            calls=[]
            def fake_signal(_study,id,day,sym):
                calls.append((id,day,sym))
                return {"candidate":id,"eligible":False,"future_pnl":None}
            with patch("algorithm_chatgpt_cycle_v14.read_entries",
                       return_value=[record]):
                result=run_cycle(
                    study,max_captures=0,
                    runner=lambda study,max_captures:{"source_attempt_count":0},
                    signaler=fake_signal)
            self.assertEqual(len(calls),2)
            self.assertEqual({x[0] for x in calls},
                             {"flow-memory-flip-001","impact-decay-check-20261030"})
            self.assertEqual(len({(x[1],x[2]) for x in calls}),1)
            self.assertTrue(all(x["future_pnl"] is None for x in result["new_source_only_signals"]))
            self.assertFalse(result["actual_market_outcomes_scored"])
            self.assertFalse(result["can_trade"])


if __name__=="__main__":
    unittest.main()
