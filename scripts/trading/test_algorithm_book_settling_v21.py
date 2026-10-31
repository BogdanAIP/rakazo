"""v21 book-timestamp watermark and 3s settle on synthetic whole 15s original source."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_book_settling_v21 import audit,SCHEMA
from algorithm_ws_capture_v8 import save_capture,parse_event
from test_algorithm_fixed_tail_v19 import create_source,book_event,trade_event

T=int(datetime(2026,10,31,6,15,tzinfo=timezone.utc).timestamp()*1000)
SYMBOL="BTC-USDT-SWAP"


def sample(folder,*,settled_historical=True,omit_original_s9=True):
    # Produce genuine 12s unit-test messages using fixture generator, then
    # create NEW full 15s original raw file with sorted source ordinals.
    # No modification to actual historical market source files.
    scratch=Path(folder).parent/"fixture-12s"
    with patch("test_algorithm_fixed_tail_v19.T",T):
        create_source(scratch,flow="same")
    m=json.loads((scratch/"manifest.json").read_text())
    entries=[json.loads(x) for x in (scratch/"messages.jsonl").read_bytes().splitlines()]
    if omit_original_s9:
        # No taker fills for seconds 9..11 before the late fill arrives.
        # Individual trades in this fixture remain exchange-timestamp
        # monotonic; the independent auditor must never be weakened to
        # tolerate a backwards trade execution timestamp.
        entries=[
            e for e in entries
            if not (e["source"]=="trade" and
                    T+9_000<e["received_complete_utc_ms"]<T+12_000)
        ]
    for i in (12,13,14):
        braw=book_event("update",i+2,i+1,T+i*1000+90,
                        [[f"{100.10+i*.01:.4f}","1","0","1"]],[])
        entries.append({"source":"book","received_complete_utc_ms":T+i*1000+100,"raw":braw})
        trraw=trade_event(8000+i,T+i*1000+280,"buy",2)
        entries.append({"source":"trade","received_complete_utc_ms":T+i*1000+300,"raw":trraw})
    if settled_historical:
        entries.append({
            "source":"trade",
            "received_complete_utc_ms":T+12_150,
            "raw":trade_event(9999,T+9_280,"buy",1),
        })
    entries.sort(key=lambda e:e["received_complete_utc_ms"])
    counts={"book":0,"trade":0}
    for e in entries:
        src=e["source"]
        raw=e["raw"]
        e["kind"]=parse_event(src,SYMBOL,raw)[1]
        e["ordinal_source"]=counts[src]
        e["received_monotonic_ns"]=e["received_complete_utc_ms"]*1_000_000
        e["raw_sha256"]=hashlib.sha256(raw.encode()).hexdigest()
        counts[src]+=1
    m.update({
        "observation_seconds":15,
        "end_utc_ms":T+15_012,
        "event_count":len(entries),
        "event_count_by_stream":counts,
    })
    return save_capture(folder,m,entries)


class BookWatermark21Tests(unittest.TestCase):
    def test_full_original_source_reaudit_and_one_recovered_feature_trade(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v21-oct31-btc-01"
            sample(folder,settled_historical=True,omit_original_s9=True)
            result=audit(folder,SYMBOL)
        self.assertEqual(result["schema"],SCHEMA)
        self.assertEqual(result["fixed_nominal_settling_delay_ms"],3000)
        self.assertEqual(result["book_exchange_anchor_span_ms"],8000)
        self.assertEqual(result["feature_exchange_interval_taker_fills_recovered_by_settling"],1)
        self.assertEqual(result["fully_watermark_covered_one_second_bins"],8)
        self.assertEqual(result["new_trade_containing_bins_due_to_settling"],1)
        self.assertEqual(result["true_decision_cutoff_utc_ms"],T+15_012)
        self.assertFalse(result["Windows_exchange_clock_offset_calibrated"])
        self.assertFalse(result["future_price_labels_accessed"])
        self.assertFalse(result["can_trade"])
        self.assertFalse(result["can_start_paper"])

    def test_no_late_historical_trade_produces_zero_recovery(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v21-oct31-btc-01"
            sample(folder,settled_historical=False,omit_original_s9=False)
            result=audit(folder,SYMBOL)
        self.assertEqual(result["feature_exchange_interval_taker_fills_recovered_by_settling"],0)
        self.assertEqual(result["new_trade_containing_bins_due_to_settling"],0)
        self.assertLessEqual(
            result["feature_exchange_interval_taker_fills_available_at_plus12s"],
            result["feature_exchange_interval_taker_fills_available_at_plus15s"])

    def test_manipulated_source_bytes_are_not_reinterpreted(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v21-oct31-btc-01"
            sample(folder)
            with (folder/"messages.jsonl").open("ab") as f:
                f.write(b'{}\n')
            with self.assertRaises(ValueError):
                audit(folder,SYMBOL)

    def test_no_backward_cohort_source_renaming(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v21-oct31-btc-01"
            sample(folder)
            with self.assertRaises(ValueError):
                audit(folder,"SOL-USDT-SWAP")
            # The original default 12s source auditor also refuses this
            # new 15s file instead of interpreting it as an old outcome.
            from algorithm_ws_12s_coverage_v18 import analyze
            with self.assertRaises(ValueError):
                analyze(folder)


if __name__=="__main__":
    unittest.main()
