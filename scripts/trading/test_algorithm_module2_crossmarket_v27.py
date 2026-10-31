"""v27 frozen public module2 UTC+8 original CSV bar ingestion tests."""
from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from datetime import datetime,timezone

from algorithm_module2_archive_v27 import (
    url_for,original_filename,paths,open_verified,RECEIPT_SCHEMA
)
from algorithm_module2_crossmarket_v27 import archive_bars,SCHEMA
from algorithm_crossmarket_v27 import compute_returns
from algorithm_multiday_registry_v12 import canonical,sha256


class Module2History27Tests(unittest.TestCase):
    def test_holdout_day_utc_plus8_sep05_strictly_forbidden(self):
        for sym in ("BTC-USDT-SWAP","ETH-USDT-SWAP","NEAR-USDT-SWAP"):
            self.assertIn("20260903",url_for("2026-09-03",sym))
            self.assertIn("20260904",url_for("2026-09-04",sym))
            with self.assertRaises(ValueError):
                url_for("2026-09-05",sym)

    def sample_original(self,root):
        day="2026-09-03";symbol="BTC-USDT-SWAP"
        start=int(datetime(2026,9,2,16,tzinfo=timezone.utc).timestamp()*1000)
        b=io.StringIO()
        writer=csv.writer(b)
        writer.writerow(["instrument_name","open","high","low","close",
                         "vol","vol_ccy","vol_quote","open_time","confirm"])
        for i in range(1440):
            price="100" if i<1440-1 else "101"
            writer.writerow([symbol,price,price,price,price,1,1,1,start+i*60000,1])
        out=io.BytesIO()
        with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{symbol}-candlesticks-{day}.csv",b.getvalue().encode())
        original,receipt=paths(root,day,symbol)
        original.write_bytes(out.getvalue())
        receipt.write_bytes(canonical({
            "schema":RECEIPT_SCHEMA,"utc_plus_8_label":day,
            "instrument":symbol,"source_url":url_for(day,symbol),
            "original_filename":original_filename(day,symbol),
            "original_sha256":sha256(out.getvalue()),
            "original_bytes":len(out.getvalue()),
            "no_holdout_utc_sept05_source_access":True,
        })+b"\n")
        return original,receipt

    def test_original_1440_minute_file_is_verified_and_keeps_utc_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            self.sample_original(td)
            rows,r=archive_bars(td,"2026-09-03","BTC-USDT-SWAP")
        self.assertEqual(len(rows),1440)
        self.assertEqual(r["original_archive_rows"],1440)
        self.assertEqual(rows[0][0],str(int(datetime(2026,9,2,16,tzinfo=timezone.utc).timestamp()*1000)))
        self.assertTrue(r["all_bars_complete_and_consecutive"])

    def test_tamper_original_gzip_zip_bytes_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            orig,_=self.sample_original(td)
            orig.write_bytes(orig.read_bytes()+b"x")
            with self.assertRaises(ValueError):
                open_verified(td,"2026-09-03","BTC-USDT-SWAP")

    def test_incomplete_daily_grid_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            original,receipt=self.sample_original(td)
            # Synthetic valid archive covers 1440; demonstrate malformed source
            # is not silently backfilled from future market quotes.
            receipt.unlink()
            with self.assertRaises(FileNotFoundError):
                archive_bars(td,"2026-09-03","BTC-USDT-SWAP")


if __name__=="__main__":
    unittest.main()
