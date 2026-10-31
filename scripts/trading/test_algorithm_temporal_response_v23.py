"""v23 temporal-response prereg, strict as-of semantics and no alpha overclaims."""
from __future__ import annotations
from decimal import Decimal
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

from algorithm_temporal_response_v23 import (
    anchors,targets,config,config_sha,new_state,apply_one,
    signal_at,imbalance,observation,summarize,valid_asof_quote,
    load_checkpoints,format_summary,HORIZONS,MAX_STALE_MS,
    CP_SCHEMA,ROOT_NAME
)
from algorithm_multiday_registry_v12 import canonical,sha256,GENESIS


def q(bid="100",ask="101",bs="10",ass="10",*,status="AVAILABLE"):
    return {"status":status,"bid":bid,"ask":ask,"bid_size":bs,"ask_size":ass}


def event(ts,action="update",bids=None,asks=None):
    return json.dumps({
        "instId":"NEAR-USDT-SWAP","ts":str(ts),
        "action":action,
        "bids":bids if bids is not None else [],
        "asks":asks if asks is not None else [],
    }).encode()+b"\n"


class TemporalResponseTests(unittest.TestCase):
    def test_exact_two_blocks_58_anchors_and_eight_horizons(self):
        ts=anchors()
        self.assertEqual(len(ts),58)
        self.assertEqual(ts[1]-ts[0],15*60*1000)
        self.assertEqual(HORIZONS,(10,30,60,120,300,900,1800,3600))
        from algorithm_temporal_response_v23 import utc_ms,DATE
        self.assertEqual(ts[0],utc_ms(DATE,2))
        self.assertEqual(ts[28],utc_ms(DATE,9))
        self.assertEqual(ts[29],utc_ms(DATE,14))
        self.assertEqual(ts[-1],utc_ms(DATE,21))
        self.assertFalse(any(utc_ms(DATE,10)<=t<utc_ms(DATE,14) for t in ts))
        self.assertEqual(min(targets()),ts[0]-30_000)
        self.assertEqual(max(targets()),ts[-1]+3600_000)
        self.assertEqual(config()["horizons_seconds"],list(HORIZONS))

    def test_baseline_and_new_pressure_shock_are_distinct_and_frozen(self):
        before=q(bs="20",ass="80")
        now=q(bs="80",ass="20")
        base=signal_at(before,now,"baseline_imbalance")
        shock=signal_at(before,now,"pressure_shock_without_mid_adaptation")
        self.assertEqual(base["status"],"ELIGIBLE")
        self.assertEqual(base["direction"],1)
        self.assertEqual(shock["status"],"ELIGIBLE")
        self.assertEqual(shock["direction"],1)
        self.assertEqual(Decimal(shock["midquote_drift_30s_bps"]),0)
        almost=q(bs="55",ass="45")
        self.assertEqual(signal_at(before,almost,"baseline_imbalance")["status"],
                         "ABSTAIN_THRESHOLD")
        bigprice=q(bid="102",ask="103",bs="80",ass="20")
        self.assertEqual(signal_at(before,bigprice,"pressure_shock_without_mid_adaptation")["status"],
                         "ABSTAIN_THRESHOLD")
        self.assertEqual(signal_at(None,now,"pressure_shock_without_mid_adaptation")["status"],
                         "ABSTAIN_MISSING_PRESIGNAL_BOOK")
        with self.assertRaises(ValueError):
            signal_at(before,now,"unknown_hindsight_rule")

    def test_asof_only_preceding_event_and_future_event_only_brackets(self):
        from algorithm_temporal_response_v23 import utc_ms,DATE
        first_target=targets()[0]
        book={"bids":{},"asks":{}}
        heaps={"bids":[],"asks":[]}
        state=new_state()
        apply_one(state,book,heaps,event(first_target-200,
            "snapshot",bids=[["100","10","1"]],asks=[["101","10","1"]]),targets())
        self.assertEqual(state["next_target_index"],0)
        apply_one(state,book,heaps,event(first_target+4,
            "update",bids=[["100.5","10","2"]],asks=[["101.5","10","2"]]),targets())
        # Before applying later update, the quote MUST be the old 100/101,
        # and the later 100.5/101.5 levels must never contaminate it.
        result=state["quotes"][str(first_target)]
        self.assertEqual(result["bid"],"100")
        self.assertEqual(result["ask"],"101")
        self.assertEqual(result["book_asof_age_ms"],200)
        self.assertEqual(result["book_bracket_delay_ms"],4)
        self.assertEqual(state["events_read"],2)

    def test_stale_quote_cannot_be_used_to_make_a_signal(self):
        book={"bids":{Decimal("100"):Decimal("10")},
              "asks":{Decimal("101"):Decimal("10")}}
        heaps={"bids":[Decimal("-100")],"asks":[Decimal("101")]}
        result=valid_asof_quote(book,heaps,1000,7001,7002)
        self.assertEqual(result["status"],"UNAVAILABLE_STALE_ASOF")
        result=valid_asof_quote(book,heaps,1000,1200,7002)
        self.assertEqual(result["status"],"UNAVAILABLE_NO_NEAR_FUTURE_BRACKET")
        sig=signal_at(result,q(),"baseline_imbalance")
        self.assertEqual(sig["status"],"ABSTAIN_THRESHOLD")

    def test_fixed_cost_crossing_rejects_no_horizon_winner_pick(self):
        entry=q(bid="100",ask="101",bs="80",ass="20")
        exit_=q(bid="100",ask="101",bs="80",ass="20")
        long=observation(1,entry,exit_)
        short=observation(-1,entry,exit_)
        self.assertLess(Decimal(long["gross_crossing_bps"]),0)
        self.assertLess(Decimal(short["gross_crossing_bps"]),0)
        self.assertLess(Decimal(long["net_fee7_each_side_bps"]),
                        Decimal(long["net_fee5_each_side_bps"]))
        self.assertFalse(long["is_actual_fill"])
        self.assertFalse(long["is_prospective_prediction"])
        missed=observation(1,entry,{"status":"UNAVAILABLE_STALE_ASOF"})
        self.assertEqual(missed["status"],"MISSING_ARCHIVED_OUTCOME")

    def test_each_candidate_horizon_preserves_abstentions_and_missing(self):
        rows=[
            {"candidate":"baseline_imbalance","horizon_s":10,
             "signal":{"status":"ELIGIBLE"},
             "outcome":{"status":"EVALUATED_HISTORICAL_QUOTE_PROXY",
               "net_fee5_each_side_bps":"-2","net_fee7_each_side_bps":"-6",
               "signed_midquote_move_bps":"4","gross_crossing_bps":"8"}},
            {"candidate":"baseline_imbalance","horizon_s":10,
             "signal":{"status":"ELIGIBLE"},
             "outcome":{"status":"MISSING_ARCHIVED_OUTCOME"}},
            {"candidate":"baseline_imbalance","horizon_s":10,
             "signal":{"status":"ABSTAIN_THRESHOLD"},
             "outcome":{"status":"NOT_EVALUATED_SOURCE_ABSTAIN"}},
        ]
        summary=summarize(rows,"baseline_imbalance",10)
        self.assertEqual(summary["source_anchors_total"],3)
        self.assertEqual(summary["signal_eligible_anchor_count"],2)
        self.assertEqual(summary["signal_abstentions"],1)
        self.assertEqual(summary["scored_with_archived_bid_ask"],1)
        self.assertEqual(summary["missing_or_unscorable_source_outcomes"],1)
        self.assertEqual(summary["positive_after_fee5_count"],0)
        self.assertFalse(summary["confidence_independence_claim"])

    def test_book_timestamps_go_backward_rejected(self):
        first=targets()[0]
        book={"bids":{},"asks":{}}
        heaps={"bids":[],"asks":[]}
        s=new_state()
        apply_one(s,book,heaps,event(first-50,"snapshot",
                  bids=[["100","1","1"]],asks=[["101","1","1"]]),targets())
        with self.assertRaises(ValueError):
            apply_one(s,book,heaps,event(first-60,"update",
                      bids=[["99","1","1"]]),targets())

    def test_checkpoint_hash_chain_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            idx,prev,state,root=load_checkpoints(td)
            self.assertEqual(idx,0)
            core={"schema":CP_SCHEMA,"index":1,"previous_sha256":GENESIS,
                  "study_configuration_sha256":config_sha(),"state":state}
            record={**core,"checkpoint_sha256":sha256(canonical(core))}
            path=root/"checkpoint-000001.json"
            path.write_bytes(canonical(record)+b"\n")
            self.assertEqual(load_checkpoints(td)[0],1)
            record["state"]["events_read"]=10
            path.write_bytes(canonical(record)+b"\n")
            with self.assertRaises(ValueError):
                load_checkpoints(td)

if __name__=="__main__":
    unittest.main()
