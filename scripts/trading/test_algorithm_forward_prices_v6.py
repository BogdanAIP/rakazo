"""Future-price source validation is sealed until the preregistered time."""
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest

from algorithm_forward_prices_v6 import (
    BAR, capture_batch, candles_url, freeze_file, save_batch,
    validate_candles, verify_batch, public_read
)

T = 1_793_300_400_000


def frozen():
    rows=[{"rank":i+1,"symbol":f"T{i:02d}-USDT-SWAP",
           "primary_included":i<5} for i in range(50)]
    return {"schema":"algorithm_forward_frozen_v6","candidates":rows,
            "can_start_paper":False,"can_submit_orders":False,
            "entry_candle_open_ms":T,
            "primary_exit_candle_open_ms":T+4*BAR,
            "earliest_primary_outcome_collection_ms":T+5*BAR,
            "_verified_sha256":"a"*64}


def candles(start=T):
    entries=[]
    for i in range(7):
        t=start+6*BAR-i*BAR
        entries.append([str(t),"100","104","98","102",
                        "100","1","10100","1"])
    return json.dumps({"code":"0","msg":"","data":entries}).encode()


class FuturePriceTests(unittest.TestCase):
    def test_exact_frozen_candle_identity_and_confirm(self):
        rows=validate_candles(candles(),T+7*BAR)
        self.assertEqual(rows[T]["open"],"100")
        bad=json.loads(candles())
        bad["data"][2][8]="0" # primary exit is at T+4*BAR
        parsed=validate_candles(json.dumps(bad).encode(),T+7*BAR)
        self.assertEqual(parsed[T+4*BAR]["confirm"],"0")
        bad["data"][2][0]=str(T+3*BAR)
        with self.assertRaises(ValueError):
            validate_candles(json.dumps(bad).encode(),T+7*BAR)

    def test_nan_and_wrong_ohlc_rejected(self):
        bad=json.loads(candles())
        bad["data"][0][1]="NaN"
        with self.assertRaises(ValueError):
            validate_candles(json.dumps(bad).encode(),T+7*BAR)
        bad=json.loads(candles())
        bad["data"][0][2]="99"
        with self.assertRaises(ValueError):
            validate_candles(json.dumps(bad).encode(),T+7*BAR)

    def test_not_before_primary_exit_confirmed_and_private_routes_blocked(self):
        frozen_doc=frozen()
        with self.assertRaises(ValueError):
            capture_batch(frozen_doc,1,T+5*BAR-1,lambda url: b"")
        for url in ("https://www.okx.com/api/v5/trade/order",
                    "https://www.okx.com/api/v5/account/positions"):
            with self.assertRaises(ValueError):
                public_read(url)
        with self.assertRaises(ValueError):
            candles_url("BTC-USDT-SWAP/../../../SECRET")

    def test_real_bytes_hash_and_reject_overwrite(self):
        freeze=frozen()
        now=[T+8*BAR]
        def clock():
            now[0]+=150
            return now[0]
        def reader(url):
            if "candles" in url:
                return candles()
            return json.dumps({"code":"0","msg":"",
                    "data":[{"ts":str(now[0])}]}).encode()
        manifest,records=capture_batch(freeze,1,clock,reader)
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td)/"prices-1"
            digest=save_batch(folder,manifest,records)
            result,other=verify_batch(folder,freeze,1)
            self.assertEqual(digest,other)
            self.assertEqual(len(result["records"]),7)
            with self.assertRaises(FileExistsError):
                save_batch(folder,manifest,records)
            path=folder/records[1][0]["raw_file"]
            path.write_bytes(b'{"modified":"yes"}')
            with self.assertRaises(ValueError):
                verify_batch(folder,freeze,1)

    def test_frozen_sha_must_match_exact_file_bytes(self):
        f=frozen()
        del f["_verified_sha256"]
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"freeze.json"
            p.write_text(json.dumps(f),encoding="utf8")
            with self.assertRaises(ValueError):
                freeze_file(p,"b"*64)
            doc=freeze_file(p,sha256(p.read_bytes()).hexdigest())
            self.assertEqual(len(doc["candidates"]),50)


if __name__ == "__main__":
    unittest.main()
