"""v14 external forward quote validator is a provenance-only gate, not PnL."""
from pathlib import Path
import hashlib
import json
import tempfile
import unittest

from algorithm_forward_evidence_gate_v14 import (
    SCHEMA,inspect_candidate,MAX_RESPONSE_WINDOW_MS
)
from algorithm_ai_research_v14 import propose
from test_algorithm_ai_research_v14 import candidate,OCT30
from test_algorithm_manual_runner_v13 import init
from test_algorithm_minute_quote_v11 import raw_book

T=1793350000000
H=300000
URL="https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=5"


def save_external(folder,*,ts=T+H+1000,sent=T+H+900,recv=T+H+1300,
                  raw_override=None):
    folder=Path(folder)
    folder.mkdir()
    raw=raw_book(ts) if raw_override is None else raw_override
    (folder/"raw.json").write_bytes(raw)
    m={
        "schema":SCHEMA,
        "symbol":"BTC-USDT-SWAP",
        "source_end_utc_ms":T,
        "request_sent_utc_ms":sent,
        "response_complete_utc_ms":recv,
        "request_url":URL,
        "raw_sha256":hashlib.sha256(raw).hexdigest(),
        "network_origin_attestation":None,
    }
    (folder/"manifest.json").write_text(json.dumps(m))
    return folder


class OfflineAuthenticityGateTests(unittest.TestCase):
    def test_hash_and_time_pass_still_not_exchange_authenticated_or_pnl(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"hypothesis.json"
            p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+1000)
            folder=save_external(Path(td)/"external")
            result=inspect_candidate(study,candidate()["id"],T,folder)
            self.assertTrue(result["book_schema_and_timestamps_plausible"])
            self.assertFalse(result["original_exchange_origin_independently_verified"])
            self.assertFalse(result["source_usable_for_future_labels"])
            self.assertFalse(result["pnl_calculation_authorized"])
            self.assertIsNone(result["future_price_label"])
            self.assertFalse(result["can_trade"])
            self.assertTrue(result["no_network_calls_made"])

    def test_horizon_early_late_stale_and_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"hypothesis.json";p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+1000)
            specs=[
                dict(ts=T+H-1,sent=T+H+10,recv=T+H+500),
                dict(ts=T+H+500,sent=T+H-1,recv=T+H+800),
                dict(ts=T+H+500,sent=T+H+10,recv=T+H+6000),
                dict(ts=T+H+1000,sent=T+H+10,recv=T+H+MAX_RESPONSE_WINDOW_MS+1),
            ]
            for k,kwargs in enumerate(specs):
                folder=save_external(Path(td)/f"external{k}",**kwargs)
                with self.assertRaises(ValueError):
                    inspect_candidate(study,candidate()["id"],T,folder)
            folder=save_external(Path(td)/"tamper")
            (folder/"raw.json").write_bytes(b'{"fake":"price"}')
            with self.assertRaises(ValueError):
                inspect_candidate(study,candidate()["id"],T,folder)

    def test_metadata_cannot_self_assert_trusted_network_origin(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            p=Path(td)/"hypothesis.json";p.write_text(json.dumps(candidate()))
            propose(study,p,now=OCT30+1000)
            folder=save_external(Path(td)/"external")
            m=json.loads((folder/"manifest.json").read_text())
            m["network_origin_attestation"]="trusted_exchange"
            (folder/"manifest.json").write_text(json.dumps(m))
            with self.assertRaises(ValueError):
                inspect_candidate(study,candidate()["id"],T,folder)


if __name__=="__main__":
    unittest.main()
