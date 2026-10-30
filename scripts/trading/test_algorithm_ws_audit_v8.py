"""v8 WebSocket source integrity: sequence-checked depth + fixed-window fills."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from algorithm_ws_capture_v8 import (
    BOOK_URL, TRADE_URL, CaptureRejected, parse_event,
    safe_symbol, save_capture, subscribe_message, SCHEMA as CAPTURE_SCHEMA,
)
from algorithm_ws_audit_v8 import verify_and_audit, strict_load

T=1793330000000
SYMBOL="BTC-USDT-SWAP"


def ws_book(action,seq,prev,ts, bids,asks):
    return json.dumps({"arg":{"channel":"books","instId":SYMBOL},
                       "action":action,"data":[{
                           "bids":bids,"asks":asks,"seqId":seq,
                           "prevSeqId":prev,"checksum":0,"ts":str(ts)}]},
                      separators=(",",":"))


def ws_trade(identifier,ts,side,size):
    return json.dumps({"arg":{"channel":"trades-all","instId":SYMBOL},
                       "data":[{"instId":SYMBOL,"tradeId":str(identifier),
                                "px":"100","sz":size,"side":side,
                                "source":"0","ts":str(ts)}]},
                      separators=(",",":"))


def fixture(gap=False, duplicate_trade=False):
    msgs=[
      ("book",T+10,json.dumps({"event":"subscribe","arg":{"channel":"books","instId":SYMBOL}})),
      ("book",T+50,ws_book("snapshot",1,-1,T+40,
                           [["99","2","0","1"],["98","3","0","1"]],
                           [["101","2","0","1"],["102","1","0","1"]])),
      ("trade",T+80,json.dumps({"event":"subscribe","arg":{"channel":"trades-all","instId":SYMBOL}})),
      ("book",T+1200,ws_book("update",2,8 if gap else 1,T+1100,
                            [["99","0","0","1"],["98","4","0","1"]],[])),
      ("trade",T+1500,ws_trade(100,T+1490,"buy","2")),
      ("book",T+2500,ws_book("update",3,2,T+2400,
                            [["99","1","0","1"]],[])),
      ("trade",T+3500,ws_trade(100 if duplicate_trade else 101,T+3490,"sell","1")),
    ]
    count={"book":0,"trade":0}
    entries=[]
    for stream,received,raw in msgs:
        kind=parse_event(stream,SYMBOL,raw)[1]
        entry={"ordinal_source":count[stream],"source":stream,"kind":kind,
               "received_complete_utc_ms":received,
               "received_monotonic_ns":received*1_000_000,
               "raw_sha256":hashlib.sha256(raw.encode()).hexdigest(),
               "raw":raw}
        entries.append(entry);count[stream]+=1
    manifest={"schema":CAPTURE_SCHEMA,"symbol":SYMBOL,
              "source_urls":{"book":BOOK_URL,"trade":TRADE_URL},
              "source_channels":{"book":"books","trade":"trades-all"},
              "book_checksum_deprecated":True,
              "trades_channel_is_per_fill":True,
              "start_utc_ms":T+1000,"end_utc_ms":T+9000,
              "observation_seconds":8,
              "observed_ack_and_snapshot":{"book_ack":True,"trade_ack":True,"snapshot":True},
              "event_count_by_stream":count,"event_count":len(entries),
              "stream_trade_exchange_gapless_proven":False,
              "cross_stream_total_order_proven":False,
              "no_price_outcomes_queried":True,
              "can_trade":False,"can_start_paper":False}
    return manifest,entries


class WebSocketAuditTests(unittest.TestCase):
    def test_url_and_public_only_subscriptions(self):
        safe_symbol(SYMBOL)
        for value in ("BTC/evil","BTC-USDT-SWAP/../private","BTC-USDT"):
            with self.assertRaises(CaptureRejected):
                safe_symbol(value)
        self.assertEqual(json.loads(subscribe_message("book",SYMBOL))["args"][0]["channel"],"books")
        self.assertEqual(json.loads(subscribe_message("trade",SYMBOL))["args"][0]["channel"],"trades-all")
        with self.assertRaises(CaptureRejected):
            subscribe_message("account",SYMBOL)

    def test_frame_identity_reject_mixed_source(self):
        frame=ws_trade(100,T,"buy","2")
        with self.assertRaises(CaptureRejected):
            parse_event("book",SYMBOL,frame)
        with self.assertRaises(CaptureRejected):
            parse_event("trade","SOL-USDT-SWAP",frame)
        with self.assertRaises(CaptureRejected):
            parse_event("trade",SYMBOL,'{"event":"error","code":"1"}')

    def test_exact_replay_readd_does_not_assert_absorption(self):
        manifest,rows=fixture()
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"source"
            sha=save_capture(folder,manifest,rows)
            result=verify_and_audit(folder)
            self.assertEqual(result["status"],"VERIFIED_FIXED_WINDOW")
            self.assertEqual(result["book_updates_in_window"],2)
            self.assertEqual(result["taker_fills_in_fixed_window"],2)
            self.assertEqual(result["taker_buy_contracts_in_window"],"2")
            self.assertEqual(result["taker_sell_contracts_in_window"],"1")
            self.assertEqual(result["readd_to_earlier_reduced_price_level_count"],1)
            self.assertTrue(result["book_sequence_continuous"])
            self.assertFalse(result["trade_message_loss_detection_proven"])
            self.assertFalse(result["future_prices_seen"])
            self.assertTrue(result["no_trading_action"])
            self.assertEqual(result["capture_manifest_sha256"],sha)
            with self.assertRaises(FileExistsError):
                save_capture(folder,manifest,rows)

    def test_fails_closed_on_sequence_gap(self):
        manifest,rows=fixture(gap=True)
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"source"
            save_capture(folder,manifest,rows)
            result=verify_and_audit(folder)
            self.assertEqual(result["status"],"ORDERBOOK_SEQUENCE_GAP")
            self.assertFalse(result["book_sequence_continuous"])

    def test_rejects_duplicate_trade_ids(self):
        manifest,rows=fixture(duplicate_trade=True)
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"source"
            save_capture(folder,manifest,rows)
            result=verify_and_audit(folder)
            self.assertEqual(result["status"],"DUPLICATE_OR_MALFORMED_TRADE_ID")

    def test_raw_bytes_sha_protects_against_tampering(self):
        manifest,rows=fixture()
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"source"
            save_capture(folder,manifest,rows)
            with (folder/"messages.jsonl").open("ab") as f:
                f.write(b"{}\n")
            with self.assertRaises(ValueError):
                verify_and_audit(folder)

    def test_incremental_batch_may_exceed_snapshot_depth(self):
        from algorithm_ws_audit_v8 import level_update
        book={}
        payload=[[str(2000-i),"1","0","1"] for i in range(448)]
        added,removed,_,_=level_update(book,payload,"bids",snapshot=False)
        self.assertEqual(len(book),448)
        self.assertEqual(added,448)
        self.assertEqual(removed,0)
        with self.assertRaises(ValueError):
            level_update({},[[str(3000-i),"1","0","1"] for i in range(1001)],
                         "bids",snapshot=False)

    def test_large_or_repeated_keys_json_blocked(self):
        with self.assertRaises(ValueError):
            strict_load(b'{"a":1,"a":2}')
        with self.assertRaises(ValueError):
            strict_load(b'{"a":NaN}')


if __name__=="__main__":
    unittest.main()
