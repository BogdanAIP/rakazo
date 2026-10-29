"""Strict public-only capture receipts and point-in-time OI availability."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from algorithm_pit_capture_v5 import (
    BASE, MAX_FEATURE_AGE_MS, MIN_OI_SEPARATION_MS,
    capture, epoch_ms, point_in_time_oi_delta, public_get,
    save_capture, strict_json, verify_capture,
)

T = 1793295700000
BTC = "BTC-USDT-SWAP"
ETH = "ETH-USDT-SWAP"


def fake_capture(symbols=None):
    current = [T]
    def now():
        current[0] += 300
        return current[0]
    def get(url):
        timestamp = str(current[0])
        if url == BASE+"time":
            data = {"code":"0","data":[{"ts":timestamp}],"msg":""}
        elif "open-interest?" in url:
            symbol = url.split("instId=")[1]
            data = {"code":"0","data":[{"instId":symbol,"instType":"SWAP",
                    "ts":timestamp,"oi":"300","oiCcy":"3","oiUsd":"1000"}],"msg":""}
        elif "funding-rate?" in url:
            symbol = url.split("instId=")[1]
            data = {"code":"0","data":[{"instId":symbol,"instType":"SWAP",
                "ts":timestamp, "fundingRate":"0.0002",
                "fundingTime":str(current[0]+28_800_000),
                "prevFundingTime":str(current[0]-28_800_000),
                "settFundingRate":"-0.0001"}],"msg":""}
        else:
            raise AssertionError("Unknown route")
        return json.dumps(data,sort_keys=True).encode("utf8")
    return capture([BTC] if symbols is None else symbols, get=get, now=now)


class PublicCaptureTests(unittest.TestCase):
    def test_receipt_roundtrip_and_tamper_failure(self):
        manifest, rows = fake_capture([BTC,ETH])
        self.assertEqual(len(rows),6)
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)/"evidence-001"
            digest=save_capture(folder,manifest,rows)
            parsed, other_digest=verify_capture(folder)
            self.assertEqual(digest, other_digest)
            self.assertFalse(parsed["historical_publication_time_certified"])
            self.assertTrue(parsed["forecast_funding_not_settled_cashflow"])
            self.assertFalse(parsed["can_trade"])
            (folder / rows[1][0]["raw_file"]).write_bytes(b'{"fake":true}')
            with self.assertRaises(ValueError):
                verify_capture(folder)
            with self.assertRaises(FileExistsError):
                save_capture(folder,manifest,rows)

    def test_prohibited_public_routes_and_duplicate_symbols(self):
        for url in (
            "https://www.okx.com/api/v5/trade/order",
            "https://www.okx.com/api/v5/account/balance",
            "https://evil.example/api/v5/public/time",
            BASE+"open-interest?instType=SWAP&instId=BTC-USDT-SWAP&extra=1",
        ):
            with self.assertRaises(ValueError):
                public_get(url)
        with self.assertRaises(ValueError):
            fake_capture([BTC,BTC])
        with self.assertRaises(ValueError):
            fake_capture(["BTC-USDT-SWAP/../../../data"])
        with self.assertRaises(ValueError):
            fake_capture([])

    def test_duplicate_json_fields_and_nans_rejected(self):
        with self.assertRaises(ValueError):
            strict_json(b'{"code":"0","code":"1"}')
        with self.assertRaises(ValueError):
            strict_json(b'{"x":NaN}')
        with self.assertRaises(ValueError):
            epoch_ms(1793295700000)

    def test_first_snapshot_never_backfills_historical_oi(self):
        manifest,_=fake_capture([BTC])
        oi=next(x for x in manifest["records"] if x["kind"]=="oi")
        self.assertIsNone(point_in_time_oi_delta([manifest],BTC,oi["received_complete_ms"]-1))
        self.assertIsNone(point_in_time_oi_delta([manifest],BTC,oi["received_complete_ms"]+1))

    def test_future_received_data_does_not_appear_in_past_decisions(self):
        original,_=fake_capture()
        oi=next(x for x in original["records"] if x["kind"]=="oi")
        future=deepcopy(original)
        for record in future["records"]:
            record["received_complete_ms"]+=MIN_OI_SEPARATION_MS
            record["available_to_research_not_before_ms"]+=MIN_OI_SEPARATION_MS
            if record["kind"]=="oi":
                record["observed"]["oiCcy"]="4"
        before=oi["received_complete_ms"]+MIN_OI_SEPARATION_MS-1
        self.assertIsNone(point_in_time_oi_delta([original,future],BTC,before))
        after=oi["received_complete_ms"]+MIN_OI_SEPARATION_MS
        value=point_in_time_oi_delta([original,future],BTC,after)
        self.assertEqual(value["oiCcy_delta_fraction"],str(4/3-1) if False else
                         "0.3333333333333333333333333333")
        self.assertFalse(value["trading_approved"])
        self.assertIsNone(point_in_time_oi_delta([original,future],BTC,after+MAX_FEATURE_AGE_MS+1))

    def test_server_time_skew_fails_closed(self):
        m, rows=fake_capture()
        corrupted=deepcopy(m)
        x=corrupted["records"][0]
        x["observed"]["server_time_ms"]+=3600_000
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)/"skew"
            save_capture(folder,corrupted,rows)
            with self.assertRaises(ValueError):
                verify_capture(folder)


if __name__=="__main__":
    unittest.main()
