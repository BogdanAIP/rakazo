"""v17 manual same-day source-only prospective checks; no v12 mutation."""
from datetime import datetime,timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_oct30_preflight_v17 import run,SCHEMA,CANDIDATES
from test_algorithm_ai_research_v14 import candidate
from test_algorithm_impact_decay_v15 import impact_proposal,rows as impact_rows

T=int(datetime(2026,10,30,14,tzinfo=timezone.utc).timestamp()*1000)

def source():
    a=impact_rows()
    a.update({"symbol":"BTC-USDT-SWAP",
              "window_start_utc_ms":T-8000,
              "window_end_utc_ms":T,
              "source_manifest_sha256":"a"*64,
              "source_messages_sha256":"b"*64,
              "bins_with_both_streams":8})
    return a

class PreflightTests(unittest.TestCase):
    def test_two_preregistered_hypotheses_one_source_not_two_independent(self):
        with tempfile.TemporaryDirectory() as td:
            src=Path(td)/"ws-v17-oct30-btc-01";src.mkdir()
            h1={"proposal_sha256":"a"*64,"entry_sha256":"b"*64,
                "registered_utc_ms":T-3600000}
            h2={"proposal_sha256":"c"*64,"entry_sha256":"d"*64,
                "registered_utc_ms":T-3600000}
            with patch("algorithm_oct30_preflight_v17.build_buckets",return_value=source()):
                with patch("algorithm_oct30_preflight_v17.registered",
                           return_value=[(h1,candidate()),(h2,impact_proposal())]):
                    out=run(src,td,"BTC-USDT-SWAP")
        self.assertEqual(out["schema"],SCHEMA)
        self.assertEqual(len(out["candidate_checks"]),2)
        self.assertEqual(out["candidate_eligible_count"],1)
        self.assertTrue(out["two_hypotheses_do_not_create_independent_samples"])
        self.assertTrue(out["candidate_checks"][1]["source_only_signal"]["eligible"])
        self.assertFalse(out["candidate_checks"][0]["source_only_signal"]["eligible"])
        self.assertIsNone(out["realized_pnl"])
        self.assertFalse(out["can_trade"])

    def test_hindsight_candidate_and_wrong_day_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            src=Path(td)/"ws-v17-oct30-btc-01";src.mkdir()
            h1={"proposal_sha256":"a"*64,"entry_sha256":"b"*64,
                "registered_utc_ms":T+1}
            h2={"proposal_sha256":"c"*64,"entry_sha256":"d"*64,
                "registered_utc_ms":T-10000}
            with patch("algorithm_oct30_preflight_v17.build_buckets",return_value=source()):
                with patch("algorithm_oct30_preflight_v17.registered",
                           return_value=[(h1,candidate()),(h2,impact_proposal())]):
                    with self.assertRaises(ValueError):
                        run(src,td,"BTC-USDT-SWAP")
                late=source()
                late["window_start_utc_ms"]+=86400000
                late["window_end_utc_ms"]+=86400000
                with patch("algorithm_oct30_preflight_v17.build_buckets",return_value=late):
                    with self.assertRaises(ValueError):
                        run(src,td,"BTC-USDT-SWAP")

    def test_wrong_folder_or_symbol_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                run(Path(td)/"wrong",td,"BTC-USDT-SWAP")
            with self.assertRaises(ValueError):
                run(Path(td)/"ws-v17-oct30-btc-01",td,"ETH-USDT-SWAP")

if __name__=="__main__":
    unittest.main()
