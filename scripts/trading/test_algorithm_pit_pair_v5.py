"""Two-snapshot source checks and strict no-lookahead feature availability."""
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_pit_pair_v5 import (
    MAX_ASOF_AGE_MS, MIN_PAIR_MS, build_panel, pair_field,
)

EPOCH = int(datetime(2026, 10, 29, 17, tzinfo=timezone.utc).timestamp() * 1000)


def manifests(symbol="BTC-USDT-SWAP", *, offset=30*60_000, new_period=False):
    def make(received, oi, rate, period, tag):
        return {"symbols":[symbol],"records":[
            {"kind":"oi","symbol":symbol, "body_sha256":tag+"a"*63,
             "received_complete_ms":received,
             "observed":{"oiCcy":oi}},
            {"kind":"funding","symbol":symbol, "body_sha256":tag+"b"*63,
             "received_complete_ms":received+500,
             "observed":{
                 "future_forecast_is_realized_rate":False,
                 "historical_publication_time_known":False,
                 "forecast_settlement_time_ms":period,
                 "forecast_funding_rate":rate,
             }},
        ]}
    return (
        make(EPOCH,"3",".0002",EPOCH+28_800_000,"a"),
        make(EPOCH+offset,"3.3",".0004",
             EPOCH+57_600_000 if new_period else EPOCH+28_800_000,"b"),
    )


class PairsTests(unittest.TestCase):
    def test_oi_delta_unavailable_before_second_receipt(self):
        a,b=manifests()
        t=b["records"][0]["received_complete_ms"]
        self.assertIsNone(pair_field(a,b,a["symbols"][0],"oi",t-1))
        row=pair_field(a,b,a["symbols"][0],"oi",t)
        self.assertEqual(row["delta_percent"],"10.0")
        self.assertEqual(row["direction"],1)
        self.assertIsNone(pair_field(a,b,a["symbols"][0],"oi",t+MAX_ASOF_AGE_MS+1))

    def test_funding_drift_uses_only_same_forecast_period(self):
        a,b=manifests()
        t=b["records"][1]["received_complete_ms"]
        self.assertIsNone(pair_field(a,b,a["symbols"][0],"funding",t-1))
        observed=pair_field(a,b,a["symbols"][0],"funding",t)
        self.assertTrue(observed["comparable"])
        self.assertEqual(observed["delta_bps"],"2.0000")
        self.assertEqual(observed["direction"],1)
        a,b=manifests(new_period=True)
        reset=pair_field(a,b,a["symbols"][0],"funding",t)
        self.assertFalse(reset["comparable"])
        self.assertIsNone(reset["delta_bps"])

    def test_short_interval_and_repeated_source_rejected(self):
        a,b=manifests(offset=MIN_PAIR_MS-1)
        with self.assertRaises(ValueError):
            pair_field(a,b,a["symbols"][0],"oi",b["records"][0]["received_complete_ms"])
        a,b=manifests()
        b["records"][0]["body_sha256"]=a["records"][0]["body_sha256"]
        with self.assertRaises(ValueError):
            pair_field(a,b,a["symbols"][0],"oi",b["records"][0]["received_complete_ms"])

    def test_full_panel_preserves_frozen_rank_and_all_fifty(self):
        symbols=[f"SYM{i:03d}-USDT-SWAP" for i in range(50)]
        frozen={"schema":"algorithm_pit_universe_v5","market_count":50,
                "trading_approved":False,
                "historical_point_in_time_membership_verified":False,
                "members":[{"rank":i+1,"symbol":s} for i,s in enumerate(symbols)]}
        side_effect=[]
        for k in range(10):
            batch=symbols[k*5:(k+1)*5]
            start_old=EPOCH+k*20_000
            start_new=EPOCH+30*60_000+k*20_000
            old={"symbols":batch,"records":[{"kind":"time",
                    "request_sent_ms":start_old,
                    "received_complete_ms":start_old+100}]}
            new={"symbols":batch,"records":[{"kind":"time",
                    "request_sent_ms":start_new,
                    "received_complete_ms":start_new+100}]}
            for sym in batch:
                old["records"].extend([
                    {"kind":"oi","symbol":sym,"body_sha256":"a"*64,
                     "received_complete_ms":start_old+110,
                     "observed":{"oiCcy":"3"}},
                    {"kind":"funding","symbol":sym,"body_sha256":"b"*64,
                     "received_complete_ms":start_old+120,
                     "observed":{"forecast_funding_rate":"0.0001",
                                 "forecast_settlement_time_ms":EPOCH+86_400_000,
                                 "future_forecast_is_realized_rate":False,
                                 "historical_publication_time_known":False}},
                ])
                new["records"].extend([
                    {"kind":"oi","symbol":sym,"body_sha256":"c"*64,
                     "received_complete_ms":start_new+110,
                     "observed":{"oiCcy":"3.3"}},
                    {"kind":"funding","symbol":sym,"body_sha256":"d"*64,
                     "received_complete_ms":start_new+120,
                     "observed":{"forecast_funding_rate":"0.0002",
                                 "forecast_settlement_time_ms":EPOCH+86_400_000,
                                 "future_forecast_is_realized_rate":False,
                                 "historical_publication_time_known":False}},
                ])
            old["records"].append({"kind":"time","request_sent_ms":start_old+400,
                                   "received_complete_ms":start_old+500})
            new["records"].append({"kind":"time","request_sent_ms":start_new+400,
                                   "received_complete_ms":start_new+500})
            side_effect.extend([(old,str(k)+"a"),(new,str(k)+"b")])
        audit={"last_response_ms":EPOCH+10*20_000,
               "schema":"algorithm_pit_batch_audit_v5"}
        with tempfile.TemporaryDirectory() as td:
            frozen_file=Path(td)/"frozen.json"
            frozen_file.write_text(json.dumps(frozen))
            with patch("algorithm_pit_pair_v5.first_batch_audit",return_value=audit):
                with patch("algorithm_pit_pair_v5.verify_capture",side_effect=side_effect):
                    result=build_panel(Path(td),frozen_file)
        self.assertEqual(result["summary"]["market_count"],50)
        self.assertEqual(result["summary"]["oi_increased"],50)
        self.assertEqual(result["summary"]["funding_same_period"],50)
        self.assertEqual(result["markets"][-1]["symbol"],symbols[-1])
        self.assertFalse(result["independent_performance_validated"])
        self.assertFalse(result["can_start_paper"])


if __name__=="__main__":
    unittest.main()
