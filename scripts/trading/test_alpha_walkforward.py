"""Alpha Discovery v2 temporal safety and negative-control tests.

The favorable price series is SYNTHETIC, never a market profitability claim.
"""
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from alpha_discovery import Candle
from alpha_walkforward import (
    BASELINE, choose_from_past, fold, walk_forward
)
from okx_dataset import export_snapshot, parse_pages
from run_alpha_audited import audited_run
from test_alpha_discovery import sample
from test_okx_dataset import SYMBOL, fixtures

class TemporalTests(unittest.TestCase):
    def test_future_candle_cannot_change_past_selection(self):
        candles = sample(1200, 0.013)
        start, stop = 964, 1156
        before, _, _ = fold(candles, start, stop, seed=7)
        changed = list(candles)
        j = start + 1
        c = changed[j]
        changed[j] = Candle(c.time, c.op, c.hi * 2,
                             c.lo * 0.1, c.cl, c.volume)
        after, _, _ = fold(changed, start, stop, seed=7)
        self.assertEqual(before["strategy"], after["strategy"])
        self.assertEqual(before["selection"], after["selection"])
        self.assertEqual(before["train"], [0, 960])
        self.assertEqual(before["embargo"], [960, 964])
        self.assertNotEqual(before["strategy_result"], after["strategy_result"])

    def test_flat_series_research_fails_and_holdout_not_accessed(self):
        candles = sample(2880, 0)
        result = walk_forward(candles, rounds=2)
        self.assertEqual(result["research_gate"]["status"], "NO_VALIDATED_EDGE")
        self.assertIsNone(result["holdout"])
        self.assertGreaterEqual(len(result["development_folds"]), 4)
        self.assertTrue(all(x["no_trade_decision"] for x in result["development_folds"]))
        self.assertTrue(all(x["selection"]["trials"] >= 48
                            for x in result["development_folds"]))

    def test_positive_synthetic_demo_is_not_authorized_trading(self):
        candles = sample(2880, 0.013)
        result = walk_forward(candles, rounds=1, seed=7)
        self.assertTrue(result["research_gate"]["passed"])
        self.assertIsNotNone(result["holdout"])
        self.assertFalse(result["can_submit_orders"])
        self.assertFalse(result["research_gate"]["statistical_significance_established"])
        development_end = int(2880 * 0.8)
        for frame in result["development_folds"]:
            self.assertLessEqual(frame["train"][1], frame["evaluation"][0] - 4)
            self.assertLessEqual(frame["evaluation"][1], development_end)
        for frame in result["holdout"]["folds"]:
            self.assertGreaterEqual(frame["evaluation"][0], development_end)
            self.assertLessEqual(frame["train"][1], frame["evaluation"][0] - 4)

    def test_holdout_modification_not_used_in_development_folds(self):
        original = sample(2880, 0.013)
        before = walk_forward(original, rounds=1)
        changed = list(original)
        last = changed[-1]
        changed[-1] = Candle(last.time, last.op, last.hi * 5,
                             last.lo * 0.1, last.cl, last.volume)
        after = walk_forward(changed, rounds=1)
        self.assertEqual(before["development_folds"], after["development_folds"])
        self.assertEqual(before["research_gate"], after["research_gate"])

    def test_one_use_registry_applies_to_v2(self):
        pages = fixtures(2880)
        as_of = datetime(2025, 2, 20, tzinfo=timezone.utc)
        candles, receipts = parse_pages(pages, SYMBOL, as_of, 100)
        with tempfile.TemporaryDirectory() as folder:
            f = Path(folder) / "history.csv"
            export_snapshot(candles, receipts, SYMBOL, as_of, f,
                            source="offline_fixture")
            registry = Path(folder) / "registry"
            report = audited_run(f, f.with_suffix(".manifest.json"),
                                 registry, Path(folder) / "result.json",
                                 rounds=1, allow_fixture=True, protocol="v2")
            self.assertEqual(report["protocol"], "alpha_discovery_v2_walkforward")
            self.assertFalse(report["can_submit_orders"])
            self.assertEqual(len(list(registry.glob("*.claim.json"))), 1)
            with self.assertRaises(FileExistsError):
                audited_run(f, f.with_suffix(".manifest.json"),
                            registry, Path(folder) / "attempt2.json",
                            rounds=1, allow_fixture=True, protocol="v2")

    def test_short_data_v2_fails_before_claim(self):
        pages = fixtures(600)
        as_of = datetime(2025, 2, 20, tzinfo=timezone.utc)
        candles, receipts = parse_pages(pages, SYMBOL, as_of, 100)
        with tempfile.TemporaryDirectory() as folder:
            f = Path(folder) / "history.csv"
            export_snapshot(candles, receipts, SYMBOL, as_of, f,
                            source="offline_fixture")
            registry = Path(folder) / "registry"
            with self.assertRaises(ValueError):
                audited_run(f, f.with_suffix(".manifest.json"),
                            registry, Path(folder) / "result.json",
                            rounds=1, allow_fixture=True, protocol="v2")
            self.assertEqual(len(list(registry.glob("*.claim.json"))), 0)

if __name__ == "__main__":
    unittest.main()
