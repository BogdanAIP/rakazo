"""V10 pre-subscription trades at the same start millisecond are excluded.

Original raw WebSocket frames are preserved. Source ordinal establishes that
these two fills happened *before* the ACK, despite equal UTC millisecond.
"""
import hashlib
from pathlib import Path
import tempfile
import unittest

from test_algorithm_ws_audit_v8 import fixture, ws_trade, T, SYMBOL
from algorithm_ws_capture_v8 import parse_event, save_capture
from algorithm_ws_audit_v8 import verify_and_audit
from algorithm_ws_buckets_v8 import build_buckets


class SameMillisecondPreAckTests(unittest.TestCase):
    def test_pre_ack_trade_at_start_is_saved_but_not_scored(self):
        manifest, events = fixture()
        start=manifest["start_utc_ms"]
        # A pre-ACK fill and the actual trade subscription ACK arrive inside
        # one local UTC millisecond, ordered by source capture event order.
        events[2]["received_complete_utc_ms"]=start
        events[2]["received_monotonic_ns"]=start*1_000_000+200
        raw=ws_trade(95,start,"buy","50")
        prior={
            "source":"trade","kind":parse_event("trade",SYMBOL,raw)[1],
            "ordinal_source":0,
            "received_complete_utc_ms":start,
            "received_monotonic_ns":start*1_000_000+100,
            "raw_sha256":hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            "raw":raw,
        }
        events.insert(2,prior)
        counts={"book":0,"trade":0}
        for x in events:
            x["ordinal_source"]=counts[x["source"]]
            counts[x["source"]]+=1
        manifest["event_count_by_stream"]=counts
        manifest["event_count"]=len(events)
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"capture"
            save_capture(folder,manifest,events)
            source=verify_and_audit(folder)
            second=build_buckets(folder)
        self.assertEqual(source["status"],"VERIFIED_FIXED_WINDOW")
        self.assertEqual(source["taker_fills_in_fixed_window"],2)
        self.assertEqual(second["one_second_bins"][0]["fill_count"],1)
        self.assertEqual(second["one_second_bins"][0]["buy_taker_contracts"],"2")
        self.assertTrue(second["no_execution_or_future_returns"])


if __name__=="__main__":
    unittest.main()
