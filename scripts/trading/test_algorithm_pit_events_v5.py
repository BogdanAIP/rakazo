"""No-lookahead observation labels with explicit abstention."""
import copy
import unittest

from algorithm_pit_events_v5 import event_at, event_report

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
