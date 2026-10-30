"""v19 exact fixed trailing-eight-second projection and AI rules, no lookahead."""
from __future__ import annotations
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_fixed_tail_v19 import tail_buckets,evaluate,HYPOTHESES
from algorithm_ws_capture_v8 import save_capture,parse_event,BOOK_URL,TRADE_URL,CHANNELS,SCHEMA
from test_algorithm_ai_research_v14 import candidate
from test_algorithm_impact_decay_v15 import impact_proposal

T=int(datetime(2026,10,30,13,0,tzinfo=timezone.utc).timestamp()*1000)
SYMBOL="BTC-USDT-SWAP"


def book_event(action,seq,prev,ts,bids,asks):
    return json.dumps({
        "arg":{"channel":"books","instId":SYMBOL},
        "action":action,"data":[{"bids":bids,"asks":asks,
        "seqId":seq,"prevSeqId":prev,"ts":str(ts),"checksum":0}]
    },separators=(",",":"))


def trade_event(identifier,ts,side,qty):
    return json.dumps({
        "arg":{"channel":"trades-all","instId":SYMBOL},
        "data":[{"instId":SYMBOL,"tradeId":str(identifier),"px":"100",
                 "sz":str(qty),"side":side,"ts":str(ts),"source":"0"}]
    },separators=(",",":"))


def create_source(folder,*,flow="flip",tamper=False):
    frames=[
        ("book",T-400,json.dumps({"event":"subscribe",
            "arg":{"channel":"books","instId":SYMBOL}})),
        ("trade",T-350,json.dumps({"event":"subscribe",
            "arg":{"channel":"trades-all","instId":SYMBOL}})),
        ("book",T-300,book_event("snapshot",1,-1,T-350,
                  [["100","10","0","1"]],[["101","10","0","1"]])),
    ]
    last_bid=100.
    for i in range(12):
        if i<8:
            bid=100.01+(i*.02)
        else:
            bid=100.01+7*.02+(i-7)*.002
        # Only add bids below unchanged ask 101; all updates are visible
        # book changes preserving executable positive bid-ask spread.
        frames.append(("book",T+i*1000+100,book_event(
            "update",i+2,i+1,T+i*1000+90,
            [[f"{bid:.4f}","1","0","1"]],[])))
        for sub in range(2):
            if i<4: # Intentional huge pre-window seller flow.
                side="sell"
                qty=100
            elif flow=="flip":
                side="buy" if i<8 else "sell"
                qty=2
            else:
                side="buy"
                qty=2
            frames.append(("trade",T+i*1000+300+sub*150,
                           trade_event(1000+i*2+sub,T+i*1000+280+sub*150,
                                       side,qty)))
    counts={"book":0,"trade":0}
    entries=[]
    import hashlib
    for src,ms,raw in frames:
        entry={"ordinal_source":counts[src],"source":src,
               "kind":parse_event(src,SYMBOL,raw)[1],
               "received_complete_utc_ms":ms,
               "received_monotonic_ns":ms*1000000,
               "raw_sha256":hashlib.sha256(raw.encode()).hexdigest(),
               "raw":raw}
        entries.append(entry)
        counts[src]+=1
    manifest={
        "schema":SCHEMA,"symbol":SYMBOL,
        "source_urls":{"book":BOOK_URL,"trade":TRADE_URL},
        "source_channels":CHANNELS,
        "book_checksum_deprecated":True,
        "trades_channel_is_per_fill":True,
        "start_utc_ms":T,"end_utc_ms":T+12012,
        "observation_seconds":12,
        "observed_ack_and_snapshot":{"book_ack":True,
                                     "trade_ack":True,"snapshot":True},
        "event_count_by_stream":counts,
        "event_count":len(entries),
        "stream_trade_exchange_gapless_proven":False,
        "cross_stream_total_order_proven":False,
        "no_price_outcomes_queried":True,
        "can_trade":False,"can_start_paper":False
    }
    return save_capture(folder,manifest,entries)


def known_proposals():
    p1=candidate();p1["id"]=HYPOTHESES[0]
    p2=impact_proposal();p2["id"]=HYPOTHESES[1]
    h1={"registered_utc_ms":T-10000,"proposal_sha256":"a"*64,
        "entry_sha256":"b"*64}
    h2={"registered_utc_ms":T-10000,"proposal_sha256":"c"*64,
        "entry_sha256":"d"*64}
    return [(h1,p1),(h2,p2)]


class FixedTail19Tests(unittest.TestCase):
    def test_tail_excludes_first_four_seconds_with_big_opposite_trade_flow(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v19-oct30-btc-01"
            create_source(folder,flow="flip")
            result=tail_buckets(folder,SYMBOL)
            rows=result["one_second_bins"]
            self.assertEqual(len(rows),8)
            self.assertEqual([r["source_second"] for r in rows],list(range(4,12)))
            self.assertEqual(result["bins_with_both_streams"],8)
            self.assertEqual(sum(r["fill_count"] for r in rows),16)
            self.assertEqual(result["window_start_utc_ms"],T+4000)
            self.assertEqual(result["feature_window_end_utc_ms"],T+12000)
            self.assertEqual(result["window_end_utc_ms"],T+12012)
            self.assertEqual(rows[0]["buy_taker_contracts"],"4")
            self.assertEqual(rows[0]["sell_taker_contracts"],"0")
            self.assertEqual(rows[7]["sell_taker_contracts"],"4")
            self.assertTrue(all(r["book_end_asof_ms"] is not None for r in rows))

    def test_flip_rule_applies_only_to_exact_last_eight_seconds(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v19-oct30-btc-01"
            create_source(folder,flow="flip")
            with patch("algorithm_fixed_tail_v19.registered",
                       return_value=known_proposals()):
                out=evaluate(folder,td,SYMBOL)
            self.assertEqual(out["joint_tail_seconds"],8)
            self.assertEqual(out["eligible_candidate_count"],1)
            self.assertTrue(out["candidate_checks"][0]["source_only_result"]["eligible"])
            self.assertEqual(out["candidate_checks"][0]["source_only_result"]["hypothetical_direction"],-1)
            self.assertFalse(out["candidate_checks"][1]["source_only_result"]["eligible"])
            self.assertIsNone(out["future_market_labels"])
            self.assertFalse(out["can_trade"])

    def test_impact_decay_same_sign_is_separate_qualifying_source_condition(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v19-oct30-btc-01"
            create_source(folder,flow="same")
            with patch("algorithm_fixed_tail_v19.registered",
                       return_value=known_proposals()):
                out=evaluate(folder,td,SYMBOL)
            self.assertFalse(out["candidate_checks"][0]["source_only_result"]["eligible"])
            self.assertTrue(out["candidate_checks"][1]["source_only_result"]["eligible"])
            self.assertEqual(out["candidate_checks"][1]["source_only_result"]["hypothetical_direction"],-1)

    def test_hindsight_proposal_and_bad_symbol_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v19-oct30-btc-01"
            create_source(folder)
            proposals=known_proposals()
            proposals[0][0]["registered_utc_ms"]=T+1
            with patch("algorithm_fixed_tail_v19.registered",
                       return_value=proposals):
                with self.assertRaises(ValueError):
                    evaluate(folder,td,SYMBOL)
            with self.assertRaises(ValueError):
                tail_buckets(folder,"SOL-USDT-SWAP")

    def test_modified_raw_source_fails_independent_twelve_second_audit(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"ws-v19-oct30-btc-01"
            create_source(folder)
            with (folder/"messages.jsonl").open("ab") as out:
                out.write(b'{}\n')
            with self.assertRaises(ValueError):
                tail_buckets(folder,SYMBOL)


if __name__=="__main__":
    unittest.main()
