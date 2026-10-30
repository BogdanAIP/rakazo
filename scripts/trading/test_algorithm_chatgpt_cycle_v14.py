"""v14 single manual ChatGPT invocation dispatch and repeat-safe AI signals."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_chatgpt_cycle_v14 import run_cycle
from algorithm_ai_research_v14 import propose
from test_algorithm_ai_research_v14 import candidate,OCT30,NOV01
from test_algorithm_manual_runner_v13 import init,MEMBERS


class ChatGPTManualCycleTests(unittest.TestCase):
    def test_before_november_one_no_network_no_signals(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"proposal.json";p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+100)
            result=run_cycle(study,max_captures=1)
            self.assertEqual(result["capture_session"]["source_attempt_count"],0)
            self.assertEqual(result["new_source_only_signals"],[])
            self.assertEqual(result["research_state"]["proposals_registered"],1)
            self.assertFalse(result["actual_market_outcomes_scored"])
            self.assertFalse(result["can_trade"])

    def test_one_foreground_cycle_pairs_only_precommit_eligible_sources(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"proposal.json";p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+100)
            obs={
                "date_utc":"2026-11-01",
                "symbol":MEMBERS[0],
                "status":"SOURCE_VERIFIED_NO_OUTCOME",
                "capture_start_utc_ms":NOV01-500,
            }
            def fake_runner(study,max_captures):
                self.assertEqual(max_captures,1)
                return {"source_attempt_count":1,"finished_utc_ms":NOV01+8000}
            calls=[]
            def fake_signal(study,ident,day,symbol):
                calls.append((ident,day,symbol))
                return {"proposal_id":ident,"symbol":symbol,"date":day}
            with patch("algorithm_chatgpt_cycle_v14.read_entries",
                       return_value=[{"observation":obs}]):
                result=run_cycle(study,max_captures=1,
                                 runner=fake_runner,signaler=fake_signal)
            self.assertEqual(len(calls),1)
            self.assertEqual(result["capture_session"]["source_attempt_count"],1)
            self.assertEqual(len(result["new_source_only_signals"]),1)
            self.assertFalse(result["can_start_paper"])

    def test_hindsight_source_is_not_reinterpreted_as_forecast(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"proposal.json";p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+100)
            obs={
                "date_utc":"2026-11-01","symbol":MEMBERS[0],
                "status":"SOURCE_VERIFIED_NO_OUTCOME",
                "capture_start_utc_ms":OCT30,
            }
            def fail_signal(*a):
                raise AssertionError("Should never be scored after source")
            with patch("algorithm_chatgpt_cycle_v14.read_entries",
                       return_value=[{"observation":obs}]):
                result=run_cycle(study,max_captures=0,
                        runner=lambda *a,**k:{"source_attempt_count":0},
                        signaler=fail_signal)
            self.assertEqual(len(result["skipped_prior_source_hypotheses"]),1)
            self.assertEqual(result["new_source_only_signals"],[])


if __name__=="__main__":
    unittest.main()
