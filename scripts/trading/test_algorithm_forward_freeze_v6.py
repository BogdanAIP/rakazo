"""Freeze decisions before any future close, with immutable evidence references."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_forward_freeze_v6 import (
    BAR, GUARD, freeze, save_freeze, strict_next_boundary
)

CAPTURE = 1_793_298_000_000
SHA = "a"*64


def fixture():
    markets=[]
    observations=[]
    for i in range(50):
        sym=f"Z{i:02}-USDT-SWAP"
        markets.append({"symbol":sym,"rank":i+1,
            "oi":{"second_received_ms":CAPTURE-1000},
            "funding_forecast":{"second_received_ms":CAPTURE-500}})
        observations.append({"symbol":sym,"rank":i+1,
            "event":"CO_MOVEMENT" if i<5 else None,
            "status":"OBSERVATION_ONLY" if i<5 else "ABSTAIN_NO_JOINT_CHANGE",
            "funding_forecast_change_sign":1 if i%2==0 else -1})
    panel={"markets":markets,"second_round_last_receipt_ms":CAPTURE,
           "frozen_universe_sha256":"c"*64}
    expected={"schema":"algorithm_pit_observation_events_v5",
              "decision_time_ms":CAPTURE,"counts":{
                  "CO_MOVEMENT":5,"ABSTAIN_NO_JOINT_CHANGE":45},
              "observations":observations}
    stored={**expected,"source_panel_sha256":SHA,
            "source_panel_verified_against_raw_captures":True,
            "allow_paper":False,"allow_live_orders":False}
    return panel,expected,stored


class FreezeTests(unittest.TestCase):
    def test_strict_future_15min_plus_guard(self):
        self.assertEqual(strict_next_boundary(BAR*100),BAR*101)
        self.assertEqual(strict_next_boundary(BAR*100+1),BAR*101)
        with self.assertRaises(ValueError):
            strict_next_boundary(-1)

    def simulate(self,at,patch_saved=None,patch_panel=None):
        panel,expected,stored=fixture()
        if patch_saved is not None:
            patch_saved(stored)
        if patch_panel is not None:
            patch_panel(panel)
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"events.json"
            path.write_text(json.dumps(stored),encoding="utf8")
            with patch("algorithm_forward_freeze_v6.load_verified_panel",
                       return_value=(panel,SHA)):
                with patch("algorithm_forward_freeze_v6.event_report",
                           return_value=expected):
                    return freeze(td,path,td,td,clock_ms=at)

    def test_co_movement_only_no_orders(self):
        t=CAPTURE+10_000
        out=self.simulate(t)
        self.assertEqual(len(out["candidates"]),50)
        self.assertEqual(sum(c["primary_included"] for c in out["candidates"]),5)
        self.assertEqual(out["candidates"][0]["primary_direction_for_research_only"],1)
        self.assertEqual(out["candidates"][1]["primary_direction_for_research_only"],-1)
        self.assertTrue(all(c["primary_direction_for_research_only"] is None
                            for c in out["candidates"][5:]))
        self.assertGreater(out["entry_candle_open_ms"],t+GUARD)
        self.assertEqual(out["primary_exit_candle_open_ms"]-out["entry_candle_open_ms"],4*BAR)
        self.assertEqual(out["earliest_primary_outcome_collection_ms"],
                         out["primary_exit_candle_open_ms"]+BAR)
        self.assertFalse(out["can_submit_orders"])
        self.assertFalse(out["independent_validation"])

    def test_not_frozen_before_input_or_after_expiry(self):
        for t in (CAPTURE-1,CAPTURE+4_000_000):
            with self.assertRaises(ValueError):
                self.simulate(t)

    def test_reject_event_source_digest_mutation(self):
        def tamper(stored):
            stored["source_panel_sha256"]="b"*64
        with self.assertRaises(ValueError):
            self.simulate(CAPTURE+1000,patch_saved=tamper)

    def test_reject_label_mutation(self):
        def tamper(stored):
            stored["observations"][1]["funding_forecast_change_sign"]=-100
        with self.assertRaises(ValueError):
            self.simulate(CAPTURE+1000,patch_saved=tamper)

    def test_new_freeze_only_and_exact_file_hash(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"frozen.json"
            report=self.simulate(CAPTURE+1000)
            digest=save_freeze(path,report)
            self.assertEqual(digest,hashlib.sha256(path.read_bytes()).hexdigest())
            with self.assertRaises(FileExistsError):
                save_freeze(path,report)


if __name__ == "__main__":
    unittest.main()
