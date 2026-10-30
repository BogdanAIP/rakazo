"""v11 prospective minute-scale source, forward-time and fee policy regression."""
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_minute_quote_v11 import (
    FREEZE, CAPTURES, freeze, marketable, collect_exit, save_exit,
    read_exit, score_all, MIN_WAIT_MS, MAX_WAIT_MS
)

T=1793346000000


def bins(symbol="BTC-USDT-SWAP"):
    rows=[]
    for i in range(8):
        rows.append({
            "index":i,"start_utc_ms":T-8000+i*1000,
            "end_utc_ms":T-7000+i*1000,
            "status":"OBSERVED_BOTH",
            "book_update_count":1,
            "book_end_asof_ms":T-7500+i*1000,
            "best_bid":"100" if i!=0 else "99",
            "best_ask":"100.1" if i!=0 else "99.1",
            "buy_taker_contracts":"10","sell_taker_contracts":"2",
            "fill_count":12,
        })
    return {"symbol":symbol,"schema":"algorithm_ws_microstructure_seconds_v8",
            "window_start_utc_ms":T-8000,
            "window_end_utc_ms":T,
            "bins_with_both_streams":8,
            "source_manifest_sha256":"a"*64,
            "source_messages_sha256":"b"*64,
            "one_second_bins":rows,"can_trade":False}


def raw_book(ts):
    return json.dumps({"code":"0","msg":"","data":[{
        "seqId":100,"ts":str(ts),
        "bids":[[str(100-i),"2","0","1"] for i in range(5)],
        "asks":[[str(100.1+i),"2","0","1"] for i in range(5)],
    }]}).encode()


def lock():
    return {"schema":FREEZE,"symbol":"BTC-USDT-SWAP","run":1,
            "source_end_utc_ms":T,
            "earliest_exit_request_utc_ms":T+MIN_WAIT_MS,
            "latest_exit_complete_utc_ms":T+MAX_WAIT_MS,
            "can_trade":False,"can_start_paper":False,
            "entry_best_bid":"100","entry_best_ask":"100.1",
            "primary_direction":1}


class V11MinuteTests(unittest.TestCase):
    def test_locked_flow_persistence_and_price_control(self):
        x=bins()
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)
            (folder/"manifest.json").write_text(json.dumps({
                "symbol":x["symbol"],"end_utc_ms":T
            }))
            with patch("algorithm_minute_quote_v11.build_buckets",return_value=x):
                result=freeze(folder,"btc",1,T+1000)
        self.assertTrue(result["primary_eligible"])
        self.assertEqual(result["primary_direction"],1)
        self.assertEqual(result["flow_only_direction"],1)
        self.assertEqual(result["price_only_direction"],1)
        self.assertEqual(result["early_fills"],48)
        self.assertEqual(result["late_fills"],48)
        self.assertEqual(result["earliest_exit_request_utc_ms"],T+MIN_WAIT_MS)
        self.assertFalse(result["can_trade"])

    def test_conflicting_halves_abstain_without_flipping(self):
        x=bins()
        for r in x["one_second_bins"][4:]:
            r["buy_taker_contracts"],r["sell_taker_contracts"]="1","10"
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            (p/"manifest.json").write_text(json.dumps({"symbol":x["symbol"],"end_utc_ms":T}))
            with patch("algorithm_minute_quote_v11.build_buckets",return_value=x):
                result=freeze(p,"btc",1,T+1000)
        self.assertFalse(result["primary_eligible"])
        self.assertIsNone(result["primary_direction"])

    def test_freeze_timing_and_quote_freshness_fail_closed(self):
        x=bins()
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)
            (folder/"manifest.json").write_text(json.dumps({"symbol":x["symbol"],"end_utc_ms":T}))
            with patch("algorithm_minute_quote_v11.build_buckets",return_value=x):
                with self.assertRaises(ValueError):
                    freeze(folder,"btc",1,T+MIN_WAIT_MS)
                with self.assertRaises(ValueError):
                    freeze(folder,"btc",1,T-1)
                y=bins();y["one_second_bins"][7]["book_end_asof_ms"]=T-2000
                with patch("algorithm_minute_quote_v11.build_buckets",return_value=y):
                    result=freeze(folder,"btc",1,T+100)
                self.assertFalse(result["primary_eligible"])
                self.assertIsNone(result["entry_best_bid"])

    def test_exit_public_only_future_and_single_receipt(self):
        f=lock()
        requests=[]
        earliest=T+MIN_WAIT_MS
        def read(url):
            requests.append(url)
            return raw_book(earliest+1200)
        def clock():
            return (earliest+1500) if not requests else earliest+1800
        meta,raw=collect_exit(f,"c"*64,read=read,clock=clock)
        self.assertEqual(len(requests),1)
        self.assertEqual(meta["book"]["best_bid"],"100")
        self.assertFalse(meta["can_trade"])
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"evidence"
            save_exit(folder,meta,raw)
            output,_=read_exit(folder,"c"*64,f)
            self.assertEqual(output,meta)
            (folder/"raw.json").write_bytes(b'{"tampered":true}')
            with self.assertRaises(ValueError):
                read_exit(folder,"c"*64,f)
        calls=[]
        with self.assertRaises(ValueError):
            collect_exit(f,"c"*64,read=lambda u:calls.append(u),
                         clock=lambda:earliest-1)
        self.assertEqual(calls,[])

    def test_cannot_reuse_book_from_before_one_minute_or_after_deadline(self):
        earliest=T+MIN_WAIT_MS
        f=lock()
        with self.assertRaises(ValueError):
            collect_exit(f,"c"*64,read=lambda url:raw_book(earliest-1),
                         clock=lambda:earliest+1000)
        with self.assertRaises(ValueError):
            collect_exit(f,"c"*64,read=lambda url:raw_book(earliest+1000),
                         clock=lambda:T+MAX_WAIT_MS+1)

    def test_quoted_bid_ask_crossing_and_fees(self):
        f=lock()
        x=marketable(1,f,{"best_bid":"100","best_ask":"100.1"})
        self.assertLess(Decimal(x["gross_cross_quote_bps"]),0)
        self.assertLess(Decimal(x["base_5bps_side_net_bps"]),Decimal(x["gross_cross_quote_bps"]))
        self.assertLess(Decimal(x["stress_7bps_side_net_bps"]),Decimal(x["base_5bps_side_net_bps"]))
        f["entry_best_bid"]="100"
        f["entry_best_ask"]="100.1"
        y=marketable(-1,f,{"best_bid":"100","best_ask":"100.1"})
        self.assertLess(Decimal(y["gross_cross_quote_bps"]),0)
        with self.assertRaises(ValueError):
            marketable(0,f,{"best_bid":"100","best_ask":"100.1"})

    def test_all_four_missing_attempts_are_not_zero_returns(self):
        with tempfile.TemporaryDirectory() as td:
            report=score_all(td)
        self.assertEqual(report["planned_captures"],4)
        self.assertEqual(report["verified_outcomes"],0)
        self.assertEqual(len(report["attempts"]),4)
        self.assertIsNone(report["primary_quote_crossing"])
        self.assertEqual(report["verdict"],"INCOMPLETE_VALIDATION")


if __name__=="__main__":
    unittest.main()
