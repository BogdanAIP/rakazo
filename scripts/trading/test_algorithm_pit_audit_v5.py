"""Cross-batch PIT audit rejects silent skips/reorders; no backtest claim."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_pit_audit_v5 import audit

T=int(datetime(2026,10,29,17,tzinfo=timezone.utc).timestamp()*1000)


def evidence():
    syms=[f"ASSET{i:02d}-USDT-SWAP" for i in range(50)]
    freeze={"schema":"algorithm_pit_universe_v5","market_count":50,
            "trading_approved":False,
            "historical_point_in_time_membership_verified":False,
            "source_fetched_at_utc":"2026-10-29T06:14:22Z",
            "members":[{"rank":i+1,"symbol":sym} for i,sym in enumerate(syms)]}
    bundles=[]
    for batch in range(10):
        batch_syms=syms[batch*5:(batch+1)*5]
        start=T+batch*30_000
        records=[{"kind":"time","symbol":None,"request_sent_ms":start,
                  "received_complete_ms":start+500}]
        for i,s in enumerate(batch_syms):
            records.extend([
                {"kind":"oi","symbol":s,"request_sent_ms":start+1000+i*3000,
                 "received_complete_ms":start+1800+i*3000,
                 "observed":{"oiCcy":"3"}},
                {"kind":"funding","symbol":s,"request_sent_ms":start+1800+i*3000,
                 "received_complete_ms":start+2700+i*3000,
                 "observed":{"future_forecast_is_realized_rate":False,
                             "historical_publication_time_known":False}}])
        records.append({"kind":"time","symbol":None,
                        "request_sent_ms":start+17_000,
                        "received_complete_ms":start+17_600})
        bundles.append(({"symbols":batch_syms,"no_scheduler":True,"no_credentials":True,
                         "records":records},hashlib.sha256(str(batch).encode()).hexdigest()))
    return freeze,bundles


class PITBatchAuditTests(unittest.TestCase):
    def call(self,freeze,bundles):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"frozen.json"
            p.write_text(json.dumps(freeze),encoding="utf8")
            with patch("algorithm_pit_audit_v5.verify_capture",side_effect=bundles):
                return audit(Path(td),p)

    def test_all_fifty_and_ten_receipts(self):
        frozen,bundles=evidence()
        out=self.call(frozen,bundles)
        self.assertEqual(out["counts"]["symbols"],50)
        self.assertEqual(out["counts"]["raw_api_responses"],120)
        self.assertEqual(len(out["batch_receipts"]),10)
        self.assertTrue(out["single_snapshot_has_no_oi_delta"])
        self.assertFalse(out["independent_forward_test_ready"])
        self.assertFalse(out["trading_approved"])

    def test_swap_rank_or_drop_source_is_rejected(self):
        frozen,bundles=evidence()
        wrong=list(bundles)
        changed=dict(wrong[5][0])
        changed["symbols"]=list(reversed(changed["symbols"]))
        wrong[5]=(changed,wrong[5][1])
        with self.assertRaises(ValueError):
            self.call(frozen,wrong)
        wrong=list(bundles)
        changed=dict(wrong[2][0])
        changed["records"]=changed["records"][:-1]
        wrong[2]=(changed,wrong[2][1])
        with self.assertRaises(ValueError):
            self.call(frozen,wrong)


if __name__=="__main__":
    unittest.main()
