"""Freeze only source-verified positive/negative sign conflict without future outcomes."""
from pathlib import Path
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch

from algorithm_microstructure_freeze_v7 import BAR,GUARD,freeze

T=1793311600000


def audit():
    rows=[]
    for i in range(50):
        depth="0.4" if i%2==0 else "-0.2"
        flow="-0.1" if i<26 and i%2==0 else "0.3" if i<26 else depth
        if i<26 and i%2==1:
            flow="0.3"
        # 26 opposite; 24 aligned.
        rows.append({
            "rank":i+1,"symbol":f"C{i:02d}-USDT-SWAP",
            "source_quality":"DESCRIPTIVE_ONLY",
            "signed_relation_descriptive_only":"opposite_sign" if i<26 else "aligned_sign",
            "book":{"top5_depth_imbalance":depth},
            "recent_taker_trades":{"last100_taker_imbalance":flow},
            "joint_ready_ms":T-5000,
        })
    return {"schema":"algorithm_microstructure_audit_v7",
            "last_capture_receipt_ms":T,
            "universe_sha256":"c"*64,
            "counts":{"opposite_sign":26},"symbols":rows}


class FrozenAntagonismTests(unittest.TestCase):
    def get(self,now,mutate=None):
        d=audit()
        if mutate:
            mutate(d)
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"audit.json"
            p.write_text(json.dumps(d))
            with patch("algorithm_microstructure_freeze_v7.assemble",return_value=d):
                return freeze(td,td,p,now)

    def test_fifty_all_controls_and_no_trading(self):
        frozen=self.get(T+1000)
        self.assertEqual(frozen["market_count"],50)
        self.assertEqual(frozen["qualifying_count"],26)
        self.assertEqual(sum(x["include_in_primary"] for x in frozen["candidates"]),26)
        self.assertEqual(frozen["candidates"][0]["primary_hypothetical_direction"],1)
        self.assertEqual(frozen["candidates"][1]["primary_hypothetical_direction"],-1)
        self.assertIsNone(frozen["candidates"][-1]["primary_hypothetical_direction"])
        self.assertFalse(frozen["can_submit_orders"])
        self.assertFalse(frozen["independent_test"])
        self.assertGreater(frozen["entry_open_utc_ms"],frozen["freeze_utc_ms"]+GUARD)
        self.assertEqual(frozen["primary_exit_open_utc_ms"]-frozen["entry_open_utc_ms"],4*BAR)

    def test_rejects_late_or_premature_freeze(self):
        for utc in [T-1,T+900_001]:
            with self.assertRaises(ValueError):
                self.get(utc)

    def test_rejects_reversing_flow_to_force_a_trade(self):
        def mutate(data):
            data["symbols"][0]["recent_taker_trades"]["last100_taker_imbalance"]="0.1"
        with self.assertRaises(ValueError):
            self.get(T+1,mutate)

    def test_rejects_tampered_audit_bytes(self):
        d=audit()
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"audit.json"
            p.write_text(json.dumps(d))
            def altered(*args):
                out=dict(d)
                out["counts"]=dict(d["counts"])
                out["counts"]["opposite_sign"]=20
                return out
            with patch("algorithm_microstructure_freeze_v7.assemble",side_effect=altered):
                with self.assertRaises(ValueError):
                    freeze(td,td,p,T+1)


if __name__=="__main__":
    unittest.main()
