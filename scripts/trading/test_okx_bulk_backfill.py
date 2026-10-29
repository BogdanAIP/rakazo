"""Bounded multi-market backfill; stops whole batch after first 429."""
import json
import tempfile
import unittest
from pathlib import Path

from okx_backfill import RateLimited
from okx_bulk_backfill import run_batch
from test_okx_dataset import fixtures


def universe_file(folder):
    p = Path(folder)/"universe.json"
    doc = {
        "schema": "okx_usdt_swap_universe_v1",
        "source": "official_okx_public_rest",
        "selected": [{"symbol": symbol} for symbol in
                     ["BTC-USDT-SWAP", "SOL-USDT-SWAP", "ETH-USDT-SWAP", "XRP-USDT-SWAP"]]
    }
    p.write_text(json.dumps(doc), encoding="utf-8")
    return p


class BulkTests(unittest.TestCase):
    def test_halts_all_markets_after_first_429(self):
        with tempfile.TemporaryDirectory() as d:
            source = universe_file(d)
            calls = []
            def deny(symbol, cursor, limit):
                calls.append(symbol)
                raise RateLimited("simulated 429")
            result = run_batch(source, Path(d)/"sessions", count=3,
                               pages=2, fetcher=deny, sleeper=lambda _:None)
            self.assertTrue(result["stopped_due_to_429"])
            self.assertEqual(result["markets_attempted"], 1)
            self.assertEqual(result["total_new_pages"], 0)
            self.assertEqual(calls, ["BTC-USDT-SWAP"])

    def test_three_markets_each_one_page(self):
        with tempfile.TemporaryDirectory() as d:
            source = universe_file(d)
            calls = []
            def fetch(symbol, cursor, limit):
                calls.append((symbol, cursor, limit))
                return fixtures(600)[0]
            report = run_batch(source, Path(d)/"sessions",
                               count=3, pages=1, fetcher=fetch,
                               sleeper=lambda _:None)
            self.assertEqual(report["markets_attempted"], 3)
            self.assertEqual(report["total_new_pages"], 3)
            self.assertFalse(report["stopped_due_to_429"])
            self.assertEqual(len(calls), 3)

    def test_reject_unbounded_work(self):
        with tempfile.TemporaryDirectory() as d:
            f = universe_file(d)
            with self.assertRaises(ValueError):
                run_batch(f, Path(d), count=4)
            with self.assertRaises(ValueError):
                run_batch(f, Path(d), pages=3)


if __name__ == "__main__":
    unittest.main()
