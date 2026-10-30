"""v20 latency diagnostic tests: exact source provenance, skew and late fills."""
from pathlib import Path
import tempfile
import unittest

from algorithm_event_latency_v20 import (
    analyze, summary, nearest_rank, delay_bucket, SCHEMA
)
from test_algorithm_fixed_tail_v19 import create_source

SYMBOL="BTC-USDT-SWAP"


class EventLatency20Tests(unittest.TestCase):
    def test_exact_quantile_integer_nearest_rank_and_negative_skew(self):
        self.assertIsNone(nearest_rank([],90))
        self.assertEqual(nearest_rank([-30,0,10,260,900,8000],50),10)
        self.assertEqual(nearest_rank([-30,0,10,260,900,8000],90),8000)
        q=summary([-30,0,10,260,900,8000])
        self.assertEqual(q["samples"],6)
        self.assertEqual(q["p0_min_ms"],-30)
        self.assertEqual(q["p50_median_ms"],10)
        self.assertEqual(q["p100_max_ms"],8000)
        self.assertEqual(q["buckets"]["negative"],1)
        self.assertEqual(q["buckets"]["zero"],1)
        self.assertEqual(q["buckets"]["251_to_500"],1)
        self.assertEqual(q["buckets"]["above_5000"],1)

    def test_full_12s_source_audited_and_clock_delay_reported(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"ws-v20-oct30-btc-01"
            create_source(p)
            r=analyze(p,SYMBOL)
        self.assertEqual(r["schema"],SCHEMA)
        self.assertEqual(r["original_original_messages"],39)
        self.assertEqual(r["received_book_updates_total"],12)
        self.assertEqual(r["received_valid_taker_fills_original_window_total"],24)
        self.assertEqual(r["trade_exchange_ts_to_local_receipt_delta_ms"]["p50_median_ms"],20)
        self.assertEqual(r["book_exchange_ts_to_local_receipt_delta_ms"]["p50_median_ms"],10)
        self.assertEqual(r["receipt_only_tail_joint_seconds"],8)
        self.assertEqual(r["strict_exchange_time_tail_joint_seconds"],8)
        self.assertFalse(r["market_outcomes_or_pnl_scored"])
        self.assertFalse(r["can_trade"])
        self.assertFalse(r["client_exchange_clock_skew_independently_established"])

    def test_original_receipt_bin_can_count_delayed_pretail_trade_but_strict_cannot(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"ws-v20-oct30-btc-01"
            create_source(p,delayed_only_first_tail=True)
            r=analyze(p,SYMBOL)
        self.assertEqual(r["pre_tail_exchange_time_trades_received_in_tail"],1)
        self.assertEqual(r["receipt_only_tail_joint_seconds"],8)
        self.assertEqual(r["strict_exchange_time_tail_joint_seconds"],7)
        self.assertEqual(r["strict_joint_second_gap"],1)
        self.assertEqual(r["each_source_second"][4]["pre_tail_exchange_time_received_trades"],1)
        self.assertEqual(r["each_source_second"][4]["trades_strict_exchange_time_tail"],0)
        self.assertFalse(r["trade_feed_completeness_independently_verified"])

    def test_sha_tamper_wrong_market_or_filename_refused(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"ws-v20-oct30-btc-01"
            create_source(p)
            with self.assertRaises(ValueError):
                analyze(p,"SOL-USDT-SWAP")
            with (p/"messages.jsonl").open("ab") as out:
                out.write(b"{}\n")
            with self.assertRaises(ValueError):
                analyze(p,SYMBOL)

    def test_wrong_cohort_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                analyze(Path(td)/"ws-v19-oct30-btc-01",SYMBOL)


if __name__=="__main__":
    unittest.main()
