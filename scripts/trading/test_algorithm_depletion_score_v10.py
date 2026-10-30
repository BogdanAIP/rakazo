"""v10 preregistered depth depletion predictor and marketable crossing assumptions."""
import tempfile
from pathlib import Path
from unittest.mock import patch
import unittest
from decimal import Decimal

from algorithm_depletion_score_v10 import (
    quotes,marketable_bps,score_second,score_window,evaluate,SAMPLES,
)


def row(index, *, bid="100",ask="100.1", biddepth="10",askdepth="10",
        f="0.75", askadd="1",askreduce="5",bidadd="1",bidreduce="1",
        quality="OBSERVED_BOTH"):
    return {
        "index":index,
        "start_utc_ms":100000+index*1000,
        "end_utc_ms":101000+index*1000,
        "book_end_asof_ms":100500+index*1000,
        "status":quality,"book_update_count":1,"fill_count":3,
        "taker_imbalance":f,
        "best_bid":bid,"best_ask":ask,
        "top5_ask_contracts":askdepth,"top5_bid_contracts":biddepth,
        "book_ask_reduced_contracts":askreduce,
        "book_ask_added_contracts":askadd,
        "book_bid_reduced_contracts":bidreduce,
        "book_bid_added_contracts":bidadd,
    }


def source(symbol):
    bins=[row(i,quality="ABSTAIN_INCOMPLETE_SECOND") for i in range(8)]
    bins[0]=row(0,askdepth="12")
    bins[1]=row(1,askdepth="8")
    bins[3]=row(3,bid="101",ask="101.1")
    return {"schema":"algorithm_ws_microstructure_seconds_v8",
            "symbol":symbol,"one_second_bins":bins,"can_trade":False,
            "quote_readd_is_proxy_not_proven_absorption":True,
            "trade_stream_gapless_not_certified":True,
            "source_manifest_sha256":"a"*64,
            "source_messages_sha256":"b"*64,
            "window_start_utc_ms":100000,
            "window_end_utc_ms":108000}


class V10DepletionTests(unittest.TestCase):
    def test_quote_crossing_requires_spread_even_when_mid_is_flat(self):
        x=marketable_bps(1,Decimal("100"),Decimal("101"),
                         Decimal("100"),Decimal("101"))
        self.assertLess(Decimal(x["gross_bps"]),0)
        self.assertLess(Decimal(x["illustrative_net_bps"]),-14)
        y=marketable_bps(-1,Decimal("100"),Decimal("101"),
                         Decimal("100"),Decimal("101"))
        self.assertLess(Decimal(y["gross_bps"]),0)
        self.assertFalse(y["actual_fills"])

    def test_buy_depletes_opposite_ask_side_with_future_price_independent(self):
        a=row(0,askdepth="12")
        b=row(1,askdepth="8",askadd="1",askreduce="5")
        c=row(3,bid="101",ask="101.1")
        event=score_second(a,b,c)
        self.assertTrue(event["primary"])
        self.assertEqual(event["hypothesis_direction"],1)
        self.assertEqual(event["opposing_side"],"ask")
        self.assertGreater(Decimal(event["primary_marketable_crossing"]["illustrative_net_bps"]),0)
        self.assertLess(event["asof_feature_ms"],event["asof_outcome_ms"])
        badexit=row(3,bid="99",ask="99.1")
        negative=score_second(a,b,badexit)
        self.assertTrue(negative["primary"])
        self.assertEqual(event["hypothesis_direction"],negative["hypothesis_direction"])
        self.assertLess(Decimal(negative["primary_marketable_crossing"]["illustrative_net_bps"]),0)

    def test_sell_depletes_opposite_bid_side(self):
        a=row(0,biddepth="14")
        b=row(1,biddepth="8",f="-0.8",bidadd="1",bidreduce="5")
        c=row(3,bid="98",ask="98.1")
        event=score_second(a,b,c)
        self.assertTrue(event["primary"])
        self.assertEqual(event["hypothesis_direction"],-1)
        self.assertEqual(event["opposing_side"],"bid")

    def test_control_no_depletion_not_artificial_zero_loss(self):
        a=row(0,askdepth="12")
        b=row(1,askdepth="8",askadd="5",askreduce="4")
        c=row(3)
        event=score_second(a,b,c)
        self.assertFalse(event["primary"])
        self.assertEqual(event["status"],"CONTROL_NO_DEPLETION")
        self.assertIsNotNone(event["flow_only"])
        self.assertIsNone(event["primary_marketable_crossing"])
        self.assertIsNone(event["price_only"])

    def test_missing_source_and_zero_flow_abstain(self):
        a=row(0,askdepth="12")
        b=row(1,quality="ABSTAIN_INCOMPLETE_SECOND")
        c=row(3)
        self.assertEqual(score_second(a,b,c)["status"],"ABSTAIN_MISSING_QUALITY")
        b=row(1,f="0")
        self.assertEqual(score_second(a,b,c)["status"],"ABSTAIN_ZERO_TAKER")
        with self.assertRaises(ValueError):
            score_second(row(0,bid="200",ask="100"),row(1),row(3))

    def test_price_only_control_uses_previous_mid(self):
        a=row(0,bid="99",ask="99.1",askdepth="12")
        b=row(1,askdepth="8",askadd="0",askreduce="4")
        c=row(3,bid="101",ask="101.1")
        event=score_second(a,b,c)
        self.assertIsNotNone(event["price_only"])
        self.assertEqual(event["price_only_prior_sign"],1)
        self.assertTrue(event["primary"])

    def test_full_eight_predeclared_runs_no_cherry_picking(self):
        def synthetic(folder):
            symbol="BTC-USDT-SWAP" if "btc" in str(folder) else "SOL-USDT-SWAP"
            return source(symbol)
        with tempfile.TemporaryDirectory() as td:
            with patch("algorithm_depletion_score_v10.build_buckets",side_effect=synthetic):
                result=evaluate(td)
        self.assertEqual(result["planned_captures"],8)
        self.assertEqual(result["verified_captures"],8)
        self.assertEqual(result["primary_eligible_n"],8)
        self.assertEqual(result["source_seconds_scored"],40)
        self.assertFalse(result["can_trade"])
        self.assertEqual(len(result["attempts"]),8)

    def test_missing_captures_fail_closed_not_replaced(self):
        with tempfile.TemporaryDirectory() as td:
            with patch("algorithm_depletion_score_v10.build_buckets",
                       side_effect=FileNotFoundError("missing")):
                x=evaluate(td)
        self.assertEqual(x["verdict"],"INCOMPLETE_OR_REJECTED_SOURCE_COHORT")
        self.assertEqual(x["verified_captures"],0)
        self.assertIsNone(x["summary_means"]["primary_mean_net_cross_quote_bps"])
        self.assertEqual(len(x["attempts"]),8)


if __name__=="__main__":
    unittest.main()
