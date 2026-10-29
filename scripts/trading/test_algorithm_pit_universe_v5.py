"""Freeze only an immutable, correctly sorted 50-symbol candidate universe."""
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

from algorithm_pit_universe_v5 import freeze

START=datetime(2026,10,29,tzinfo=timezone.utc)


def source():
    rows=[]
    for i in range(52):
        rows.append({
            "symbol":f"SYM{i:03}-USDT-SWAP",
            "listed_since":(START-timedelta(days=100)).isoformat().replace("+00:00","Z"),
            "estimated_24h_quote_turnover_usdt":100_000_000-i*1_000_000,
            "spread_bps":0.5
        })
    return {
        "schema":"okx_usdt_swap_universe_v1",
        "source":"official_okx_public_rest",
        "fetched_at_utc":"2026-10-29T06:14:22.890Z",
        "instruments_response_sha256":"a"*64,
        "tickers_response_sha256":"b"*64,
        "selection":{"minimum_listing_days":90,
                     "min_estimated_24h_turnover_usdt":2_000_000,
                     "max_spread_bps":30},
        "total_live_liquid_candidates":52,
        "selected":rows,
    }


class UniverseTests(unittest.TestCase):
    def call(self,data):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"source.json"
            p.write_text(json.dumps(data),encoding="utf8")
            return freeze(p)

    def test_frozen_first_fifty_and_no_independent_evidence(self):
        out=self.call(source())
        self.assertEqual(out["market_count"],50)
        self.assertEqual(out["members"][0]["symbol"],"SYM000-USDT-SWAP")
        self.assertEqual(out["members"][-1]["symbol"],"SYM049-USDT-SWAP")
        self.assertFalse(out["source_raw_api_responses_verified"])
        self.assertFalse(out["historical_point_in_time_membership_verified"])
        self.assertFalse(out["independent_evaluation_ready"])

    def test_rejects_duplicate_reordered_invalid_or_young(self):
        edits=[]
        data=source();data["selected"][12]["symbol"]=data["selected"][0]["symbol"];edits.append(data)
        data=source();data["selected"][2]["estimated_24h_quote_turnover_usdt"]=200_000_000;edits.append(data)
        data=source();data["selected"][8]["listed_since"]=START.isoformat();edits.append(data)
        data=source();data["selected"][0]["spread_bps"]=50;edits.append(data)
        data=source();data["source"]="not_official";edits.append(data)
        data=source();data["tickers_response_sha256"]="bad";edits.append(data)
        for data in edits:
            with self.assertRaises(ValueError):
                self.call(data)

    def test_not_a_parameter_sweep(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"screen.json"
            p.write_text(json.dumps(source()))
            with self.assertRaises(ValueError):
                freeze(p,size=48)
            with self.assertRaises(ValueError):
                freeze(p,size=True)


if __name__=="__main__":
    unittest.main()
