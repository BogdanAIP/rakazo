"""No-lookahead observation labels with explicit abstention."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_pit_events_v5 import event_at, event_report, load_verified_panel

T = 1_793_296_000_000


def source(oi_sign=1, funding_sign=1, comparable=True):
    return {
        "symbol": "BTC-USDT-SWAP", "rank": 1,
        "oi": {"direction": oi_sign, "asof_available_not_before_ms": T},
        "funding_forecast": {
            "direction": funding_sign if comparable else None,
            "asof_available_not_before_ms": T+1000,
            "comparable": comparable,
        }
    }


class EventTests(unittest.TestCase):
    def test_future_receipt_inaccessible_even_if_oi_already_known(self):
        row = source()
        self.assertEqual(event_at(row, T+999)["status"], "ABSTAIN_UNRECEIVED")
        self.assertIsNone(event_at(row, T+999)["event"])
        self.assertEqual(event_at(row, T+1000)["event"], "CO_MOVEMENT")
        self.assertIsNone(event_at(row, T+1000)["trading_action"])

    def test_opposition_and_expired_observations(self):
        r = source(funding_sign=-1)
        self.assertEqual(event_at(r, T+1000)["event"], "OPPOSITION")
        self.assertEqual(event_at(r, T+3_600_001)["status"], "ABSTAIN_STALE")

    def test_unclear_forecast_cannot_become_trade(self):
        self.assertEqual(event_at(source(funding_sign=0),T+1000)["status"],
                         "ABSTAIN_NO_JOINT_CHANGE")
        self.assertEqual(event_at(source(comparable=False),T+1000)["status"],
                         "ABSTAIN_FUNDING_PERIOD_SWITCH")
        self.assertEqual(event_at(source(oi_sign=0),T+1000)["status"],
                         "ABSTAIN_NO_JOINT_CHANGE")

    def test_invalid_value_rejected(self):
        with self.assertRaises(ValueError):
            event_at(source(),True)
        with self.assertRaises(ValueError):
            event_at(source(oi_sign=2),T+1000)

    def test_event_receipt_references_exact_verified_bytes(self):
        # CRLF archive bytes, not re-serialized LF strings, own the receipt hash.
        panel = {"schema": "algorithm_pit_two_snapshot_panel_v5",
                 "markets": [{"symbol": "BTC-USDT-SWAP", "rank": 1}]}
        raw = (json.dumps(panel, indent=2).replace("\n", "\r\n") + "\r\n").encode("utf8")
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "paired.json"
            p.write_bytes(raw)
            with patch("algorithm_pit_events_v5.build_panel", return_value=panel):
                value, digest = load_verified_panel(p, td, "universe.json")
            self.assertEqual(value, panel)
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            different = {"schema": panel["schema"], "markets": []}
            with patch("algorithm_pit_events_v5.build_panel", return_value=different):
                with self.assertRaises(ValueError):
                    load_verified_panel(p, td, "universe.json")

    def test_frozen_complete_panel_required(self):
        panel={"schema":"algorithm_pit_two_snapshot_panel_v5",
               "markets":[source()]}
        with self.assertRaises(ValueError):
            event_report(panel,T+1000)
        full=[]
        for i in range(50):
            item=copy.deepcopy(source(oi_sign=1 if i%2==0 else -1,
                                      funding_sign=1 if i%2==0 else -1))
            item["symbol"]=f"X{i:02d}-USDT-SWAP"
            item["rank"]=i+1
            full.append(item)
        report=event_report({"schema":"algorithm_pit_two_snapshot_panel_v5","markets":full},
                            T+1000)
        self.assertEqual(report["counts"]["CO_MOVEMENT"],50)
        self.assertFalse(report["allow_paper"])
        self.assertFalse(report["allow_live_orders"])
        self.assertFalse(report["scientific_novelty_or_edge_proven"])


if __name__ == "__main__":
    unittest.main()
