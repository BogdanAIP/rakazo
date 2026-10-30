"""v9 prediction logic preregistered before new WebSocket source collection."""
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_quote_recovery_score_v9 import (
    SAMPLES, score_pair, score_window, evaluate, SCHEMA,
)


def sample(index, *, buy="4",sell="1",bid_readd=2,ask_readd=7,
           bid="100",ask="100.1",quality="OBSERVED_BOTH"):
    return {
        "index":index,
        "status":quality,
        "start_utc_ms":100_000+index*1000,
        "end_utc_ms":101_000+index*1000,
        "book_update_count":1,
        "fill_count":4,
        "taker_imbalance":str((Decimal(buy)-Decimal(sell))/
                                (Decimal(buy)+Decimal(sell))),
        "book_bid_quote_readd_events":bid_readd,
        "book_ask_quote_readd_events":ask_readd,
        "best_bid":bid,"best_ask":ask,
    }


def window(symbol="BTC-USDT-SWAP", *, next_bid="99.9",next_ask="100.0"):
    bins=[sample(i,quality="ABSTAIN_INCOMPLETE_SECOND") for i in range(8)]
    bins[0]=sample(0)
    bins[1]=sample(1,bid=next_bid,ask=next_ask)
    return {
        "schema":"algorithm_ws_microstructure_seconds_v8",
        "symbol":symbol,"one_second_bins":bins,
        "quote_readd_is_proxy_not_proven_absorption":True,
        "trade_stream_gapless_not_certified":True,
        "source_manifest_sha256":"a"*64,
        "source_messages_sha256":"b"*64,
        "window_start_utc_ms":100_000,
        "window_end_utc_ms":108_000,
        "can_trade":False,
    }


class PreregisteredNextSecondTests(unittest.TestCase):
    def test_fixed_opposing_side_direction_and_primary_score(self):
        row=score_pair(sample(0),sample(1,bid="99.9",ask="100.0"))
        self.assertTrue(row["primary"])
        self.assertEqual(row["frozen_predicted_direction"],-1)
        self.assertGreater(Decimal(row["primary_reverse_taker_signed_bps"]),0)
        self.assertEqual(Decimal(row["taker_only_control_signed_bps"]),
                         -Decimal(row["primary_reverse_taker_signed_bps"]))
        self.assertEqual(Decimal(row["illustrative_14bps_roundtrip_stress_bps"]),
                         Decimal(row["primary_reverse_taker_signed_bps"])-14)
        self.assertFalse(row["can_trade"])

    def test_sell_flow_bid_readdition_means_predicted_up(self):
        a=sample(0,buy="1",sell="6",bid_readd=9,ask_readd=3)
        b=sample(1,bid="100.1",ask="100.2")
        row=score_pair(a,b)
        self.assertEqual(row["frozen_predicted_direction"],1)
        self.assertGreater(Decimal(row["primary_reverse_taker_signed_bps"]),0)

    def test_no_expost_selection_by_next_midprice(self):
        cur=sample(0)
        up=score_pair(cur,sample(1,bid="100.2",ask="100.3"))
        down=score_pair(cur,sample(1,bid="99.8",ask="99.9"))
        self.assertTrue(up["primary"])
        self.assertTrue(down["primary"])
        self.assertEqual(up["frozen_predicted_direction"],
                         down["frozen_predicted_direction"])
        self.assertLess(Decimal(up["primary_reverse_taker_signed_bps"]),0)
        self.assertGreater(Decimal(down["primary_reverse_taker_signed_bps"]),0)

    def test_tie_zero_and_no_quote_readdition_abstain(self):
        self.assertEqual(score_pair(sample(0,ask_readd=2),
                                    sample(1))["status"],"CONTROL_NO_OPPOSITION")
        self.assertEqual(score_pair(sample(0,buy="2",sell="2"),
                                    sample(1))["status"],"ABSTAIN_ZERO_FLOW")
        self.assertEqual(score_pair(sample(0,ask_readd=0,bid_readd=0),
                                    sample(1))["status"],"CONTROL_NO_OPPOSITION")
        self.assertEqual(score_pair(sample(0),sample(1,quality="ABSTAIN_INCOMPLETE_SECOND"))["status"],
                         "ABSTAIN_SOURCE_QUALITY")

    def test_seven_precommitted_seconds_and_no_late_feature_leak(self):
        record=window()
        events=score_window(record)
        self.assertEqual(len(events),7)
        self.assertTrue(events[0]["primary"])
        self.assertLess(events[0]["source_feature_available_at_ms"],
                        events[0]["outcome_not_before_ms"])
        self.assertEqual(sum(x["primary"] for x in events),1)

    def test_exact_six_source_attempts_not_only_winners(self):
        def generated(folder):
            name=Path(folder).name
            symbol="BTC-USDT-SWAP" if "btc" in name else "SOL-USDT-SWAP"
            return window(symbol)
        with tempfile.TemporaryDirectory() as td:
            with patch("algorithm_quote_recovery_score_v9.build_buckets",
                       side_effect=generated):
                result=evaluate(td)
        self.assertEqual(result["schema"],SCHEMA)
        self.assertEqual(result["planned_source_captures"],6)
        self.assertEqual(result["completed_source_captures"],6)
        self.assertEqual(result["qualified_source_seconds"],6)
        self.assertEqual(len(result["samples"]),6)
        self.assertEqual(result["primary_success_count"],6)
        self.assertEqual(result["verdict"],"DESCRIPTIVELY_POSITIVE_NOT_VALIDATED")
        self.assertFalse(result["independent_alpha_validation"])
        self.assertFalse(result["can_start_paper"])

    def test_bad_missing_capture_is_reported_as_missing_not_zero_return(self):
        with tempfile.TemporaryDirectory() as td:
            with patch("algorithm_quote_recovery_score_v9.build_buckets",
                       side_effect=FileNotFoundError("data missing")):
                out=evaluate(td)
        self.assertEqual(out["completed_source_captures"],0)
        self.assertEqual(out["qualified_source_seconds"],0)
        self.assertIsNone(out["primary_and_controls"])
        self.assertEqual(out["verdict"],"INCOMPLETE_SOURCE_COHORT")
        self.assertEqual(len(out["samples"]),6)


if __name__ == "__main__":
    unittest.main()
