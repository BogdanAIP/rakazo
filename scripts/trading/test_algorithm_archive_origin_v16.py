"""v16 provenance sidecar generator never asserts trusted historical origin."""
import json
from pathlib import Path
import tempfile
import unittest
from algorithm_archive_origin_v16 import make_origin

class OriginSidecarTests(unittest.TestCase):
    def test_local_archive_is_hashed_but_not_exchange_attested(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"archive.tar.gz"
            p.write_bytes(b"local-only fake example")
            meta=make_origin(p,"BTC-USDT-SWAP",
                   "https://www.okx.com/en-us/historical-data",1794000000000)
            self.assertEqual(meta["schema"],"algorithm_l2_user_archive_metadata_v16")
            self.assertFalse(meta["exchange_origin_independently_verified"])
            self.assertEqual(len(meta["archive_sha256"]),64)
            self.assertEqual(meta["claimed_download_complete_utc_ms"],1794000000000)

    def test_not_https_or_missing_raw_archive_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"archive.tar.gz";p.write_bytes(b"data")
            with self.assertRaises(ValueError):
                make_origin(p,"BTC-USDT-SWAP","http://example.com/a",1794000000000)
            with self.assertRaises(ValueError):
                make_origin(p,"BAD MARKET","https://www.okx.com",1794000000000)
            with self.assertRaises(FileNotFoundError):
                make_origin(p.parent/"missing.tar.gz","BTC-USDT-SWAP",
                            "https://www.okx.com",1794000000000)

if __name__=="__main__":
    unittest.main()
