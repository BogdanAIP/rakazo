"""The 50-market admission gate never runs on missing unverified history."""
import json
import tempfile
import unittest
from pathlib import Path
from alpha_multi_market import inspect


def universe(symbols):
    return {
        "schema": "okx_usdt_swap_universe_v1",
        "source": "official_okx_public_rest",
        "fetched_at_utc": "2026-10-29T00:00:00+00:00",
        "selected": [{"symbol": x, "history_90d_verified": False} for x in symbols],
    }


class BatchAdmissionTests(unittest.TestCase):
    def test_requires_fifty_complete_history_files(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "u.json"
            p.write_text(json.dumps(universe(
                [f"COIN{i}-USDT-SWAP" for i in range(80)]
            )), encoding="utf-8")
            result = inspect(p, Path(d))
            self.assertEqual(result["eligible_market_candidates"], 80)
            self.assertEqual(result["ready_markets"], 0)
            self.assertEqual(result["status"], "INSUFFICIENT_HISTORY_NO_RESEARCH")
            self.assertEqual(len(result["missing_or_rejected"]), 80)

    def test_reject_duplicate_universe_members(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "u.json"
            p.write_text(json.dumps(universe([
                "BTC-USDT-SWAP", "BTC-USDT-SWAP"
            ])), encoding="utf-8")
            with self.assertRaises(ValueError):
                inspect(p, Path(d))


if __name__ == "__main__":
    unittest.main()
