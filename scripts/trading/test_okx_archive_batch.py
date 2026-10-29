"""Bounded official archive manual-batch controls, no real HTTP."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from okx_archive_batch import run_batch


class ArchiveBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)
        self.universe=self.path/"universe.json"
        self.universe.write_text(json.dumps({
            "schema":"okx_usdt_swap_universe_v1",
            "source":"official_okx_public_rest",
            "selected":[{"symbol":s} for s in (
                "BTC-USDT-SWAP","ETH-USDT-SWAP","SOL-USDT-SWAP")]
        }),encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_bounded_no_unattended_mass_collection(self):
        with self.assertRaises(ValueError):
            run_batch(self.universe,self.path,count=3)
        with self.assertRaises(ValueError):
            run_batch(self.universe,self.path,offset=-1)

    def test_stop_after_first_429_without_retry(self):
        calls=[]
        def denied(command):
            calls.append(command)
            return subprocess.CompletedProcess(command,1,"","HTTP_429")
        result=run_batch(self.universe,self.path,count=2,downloader=denied)
        self.assertEqual(len(calls),1)
        self.assertEqual(result["symbols_attempted"],1)
        self.assertEqual(result["new_archives_downloaded"],0)
        self.assertEqual(result["results"][0]["status"],"RATE_LIMITED_STOP")
        self.assertFalse(result["trade_execution_enabled"])

    def test_invalid_official_universe_rejected(self):
        self.universe.write_text(json.dumps({
            "schema":"incorrect","source":"official_okx_public_rest",
            "selected":[{"symbol":"BTC-USDT-SWAP"}]
        }))
        with self.assertRaises(ValueError):
            run_batch(self.universe,self.path,count=1)


if __name__=="__main__":
    unittest.main()
