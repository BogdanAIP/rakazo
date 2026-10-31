"""v26 news known-at-signal classification: scheduled event vs hindsight and false dates."""
from __future__ import annotations
import unittest
from algorithm_news_pit_v26 import SOURCE,load,contexts,parse_utc


class PointInTimeNews26Tests(unittest.TestCase):
    def test_source_dates_and_causal_disclaimers(self):
        r=load()
        self.assertEqual(len(r["signals"]),2)
        self.assertEqual(r["construction_date_utc"],"2026-10-31")
        self.assertFalse(any(e["causal_source_verified"] for e in r["events"]))
        self.assertTrue(any("2025" in e["reason"] for e in r["excluded_false_catalysts"]))

    def test_sep03_1445_public_ism_waller_bybit_but_not_hour_liquidations(self):
        out=contexts(load())
        first=out["signals"][0]
        by_id={e["event_id"]:e for e in first["event_evidence"]}
        self.assertEqual(by_id["sep03-ism-services"]["event_time_minus_signal_minutes"],-45.0)
        self.assertEqual(by_id["sep03-bybit-near-deposit-halt"]["event_time_minus_signal_minutes"],-15.0)
        self.assertEqual(by_id["sep03-near-upgrade-scheduled"]["classification"],
                         "PREANNOUNCED_FUTURE_SCHEDULE")
        self.assertEqual(by_id["sep03-near-upgrade-scheduled"]["event_time_minus_signal_minutes"],15.0)
        self.assertEqual(by_id["sep03-market-liquidations-hour-hindsight"]["classification"],
                         "HINDSIGHT_ONLY_NOT_KNOWN_BY_SIGNAL")
        self.assertNotIn("sep03-market-liquidations-hour-hindsight",first["news_known_at_signal_only"])

    def test_sep04_payroll_is_hours_earlier_not_the_exact_1915_catalyst(self):
        out=contexts(load())
        second=out["signals"][1]
        by_id={e["event_id"]:e for e in second["event_evidence"]}
        self.assertEqual(by_id["sep04-us-payrolls-release"]["event_time_minus_signal_minutes"],-405.0)
        self.assertEqual(by_id["sep04-us-payrolls-release"]["classification"],"PUBLISHED_BEFORE_SIGNAL")
        self.assertEqual(by_id["sep04-near-hourly-recap-hindsight"]["classification"],
                         "HINDSIGHT_ONLY_NOT_KNOWN_BY_SIGNAL")
        self.assertNotIn("sep04-near-hourly-recap-hindsight",second["news_known_at_signal_only"])

    def test_invalid_local_time_rejected(self):
        with self.assertRaises(ValueError):
            parse_utc("2026-09-03T14:00:00+04:00")
        self.assertEqual(parse_utc("2026-09-03T14:00:00Z").hour,14)

    def test_never_accidentally_train_trader(self):
        out=contexts(load())
        self.assertFalse(out["can_trade"])
        self.assertFalse(out["can_start_paper"])
        self.assertFalse(out["true_out_of_sample_test"])
        self.assertFalse(out["news_causality_established"])


if __name__=="__main__":
    unittest.main()
