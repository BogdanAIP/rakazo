"""Deterministic second-wise source replay, with no fill/cancel causality claims."""
from pathlib import Path
import tempfile
import unittest

from algorithm_ws_capture_v8 import save_capture
from algorithm_ws_buckets_v8 import build_buckets
from test_algorithm_ws_audit_v8 import fixture


class TimeBinsTests(unittest.TestCase):
    def test_fixed_seconds_and_abstain_for_empty_buckets(self):
        m,e=fixture()
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"capture"
            save_capture(folder,m,e)
            d=build_buckets(folder)
        self.assertEqual(d["bins_with_both_streams"],1)
        self.assertEqual(len(d["one_second_bins"]),8)
        self.assertEqual(d["one_second_bins"][0]["book_update_count"],1)
        self.assertEqual(d["one_second_bins"][0]["fill_count"],1)
        self.assertEqual(d["one_second_bins"][0]["buy_taker_contracts"],"2")
        self.assertEqual(d["one_second_bins"][1]["quote_readd_events"],1)
        self.assertEqual(d["one_second_bins"][1]["book_bid_quote_readd_events"],1)
        self.assertEqual(d["one_second_bins"][1]["book_ask_quote_readd_events"],0)
        self.assertEqual(d["one_second_bins"][2]["status"],"ABSTAIN_INCOMPLETE_SECOND")
        self.assertTrue(d["quote_readd_is_proxy_not_proven_absorption"])
        self.assertTrue(d["trade_stream_gapless_not_certified"])
        self.assertFalse(d["can_trade"])

    def test_corrupt_raw_sources_rejected_before_feature_derivation(self):
        m,e=fixture(gap=True)
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"capture"
            save_capture(folder,m,e)
            with self.assertRaises(ValueError):
                build_buckets(folder)


if __name__=="__main__":
    unittest.main()
