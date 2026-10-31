"""v27 historical cross-asset market controls, hourly OI and no lookahead."""
from __future__ import annotations

from decimal import Decimal
from pathlib import Path
import json
import tempfile
import unittest

from algorithm_crossmarket_v27 import (
    SAMPLES,SYMBOLS,OFFSETS,FUTURE_HORIZONS,ms,
    expected_url,compute_returns,oi_diagnostic,summarize,
    filenames,load_one,RAW_SCHEMA
)


class CrossMarket27Tests(unittest.TestCase):
    def test_exact_four_original_cases_and_no_sep05_urls(self):
        self.assertEqual(set(SAMPLES),{"sep03_loss","sep03_win","sep04_loss","sep04_win"})
        self.assertEqual(SYMBOLS,("NEAR-USDT-SWAP","BTC-USDT-SWAP","ETH-USDT-SWAP"))
        for case in SAMPLES:
            for sym in SYMBOLS:
                url=expected_url(case,sym,"candles")
                self.assertTrue(url.startswith("https://www.okx.com/api/v5/market/history-candles?"))
                self.assertNotIn("books",url)
            u=expected_url(case,"NEAR-USDT-SWAP","oi")
            self.assertIn("open-interest-history",u)
        with self.assertRaises(ValueError):
            expected_url("sep05_holdout","BTC-USDT-SWAP","candles")
        with self.assertRaises(ValueError):
            expected_url("sep04_win","ETH-USDT-SWAP","oi")

    def test_only_completed_previous_minute_at_signal(self):
        case="sep03_win"
        t=ms(SAMPLES[case])
        rows=[]
        for o in range(-36,66):
            start=t+o*60000
            close="200" if o>=0 else "100"
            rows.append([str(start),close,close,close,close,"1","1","1","1"])
        r=compute_returns(rows,case)
        self.assertEqual(r["sampled_exact_completed_minute_bars"]["0"]["completed_bar_start_utc_ms"],t-60000)
        self.assertEqual(r["sampled_exact_completed_minute_bars"]["0"]["close"],"100")
        self.assertEqual(r["sampled_exact_completed_minute_bars"]["5"]["close"],"200")
        self.assertEqual(Decimal(r["close_return_bps_vs_signal"]["5"]),Decimal(10000))
        self.assertEqual(r["close_return_bps_vs_signal"]["0"],"0")

    def test_missing_minute_is_not_backfilled(self):
        t=ms(SAMPLES["sep03_loss"])
        rows=[]
        for o in range(-35,65):
            if o==4:continue
            start=t+o*60000
            rows.append([str(start),"1","1","1","1","1","1","1","1"])
        r=compute_returns(rows,"sep03_loss")
        self.assertIsNone(r["close_return_bps_vs_signal"]["5"])
        self.assertIsNotNone(r["close_return_bps_vs_signal"]["15"])

    def test_one_hour_oi_is_not_assumed_causal_liquidation(self):
        t=ms(SAMPLES["sep03_win"])
        h=(t//3600000)*3600000
        rows=[
            [str(h-3600000),"100","1000","10000"],
            [str(h),"110","1100","11000"],
            [str(h+3600000),"105","1050","10500"],
            [str(h+7200000),"130","1300","13000"],
        ]
        result=oi_diagnostic(rows,"sep03_win")
        self.assertEqual(result["adjacent_oi_changes_percent"]["0_to_1"],"10.0")
        self.assertEqual(result["adjacent_oi_changes_percent"]["1_to_2"],str((Decimal(105)/Decimal(110)-1)*100))
        self.assertTrue(result["cannot_disaggregate_new_positions_vs_short_liquidations"])
        self.assertTrue(result["source_times_not_certified_publicly_available_at_signal"])

    def test_missing_files_preserve_unavailable_status(self):
        with tempfile.TemporaryDirectory() as td:
            r=summarize(td)
        self.assertEqual(len(r["events"]),4)
        self.assertTrue(all(not e["original_source_sha256"] for e in r["events"]))
        self.assertEqual(r["events"][0]["future_horizon_cross_market"]["5"]["status"],
                         "UNAVAILABLE_INCOMPLETE_EXACT_HISTORICAL_CANDLES")
        self.assertFalse(r["can_trade"])
        self.assertFalse(r["independent_signal_validation"])
        self.assertTrue(r["sep05_original_holdout_not_read"])

    def test_unverified_tampered_source_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            rawpath,receipt=filenames(td,"sep03_win","BTC-USDT-SWAP","candles")
            rawpath.write_text('{"code":"0","data":[]}')
            receipt.write_text(json.dumps({
                "schema":RAW_SCHEMA,"case":"sep03_win","symbol":"BTC-USDT-SWAP",
                "kind":"candles","source_url":expected_url("sep03_win","BTC-USDT-SWAP","candles"),
                "raw_response_sha256":"wrong","row_count":0,"not_a_trading_signal":True,
            }))
            with self.assertRaises(ValueError):
                load_one(td,"sep03_win","BTC-USDT-SWAP","candles")


if __name__=="__main__":
    unittest.main()
