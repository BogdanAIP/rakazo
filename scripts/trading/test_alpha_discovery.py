"""Deterministic offline regression checks for Alpha Discovery."""
import csv
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from alpha_discovery import (Candle, Rule, adaptive, discover, load_csv, replay,
                             signal, trade)

START = datetime(2025, 1, 1, tzinfo=timezone.utc)

def sample(n=600, move=0.013):
    items, prev = [], 100.0
    for i in range(n):
        op = prev
        close = op * (1 + move)
        high = max(op, close) * (1.005 if move else 1)
        low = min(op, close) * (0.999 if move else 1)
        items.append(Candle(START + timedelta(minutes=15 * i),
                            op, high, low, close, 1000.0))
        prev = close
    return items

class DiscoveryTests(unittest.TestCase):
    def test_closed_bar_signal_and_next_bar_only(self):
        bars = sample(10)
        rule = Rule("trend", 2, 0.001, 0.006, 0.009)
        a = trade(bars, rule, 4)
        self.assertIsNotNone(a)
        altered = list(bars)
        altered[5] = Candle(altered[5].time, altered[5].op,
                            altered[5].op * 2, altered[5].op * 0.5,
                            altered[5].cl, altered[5].volume)
        self.assertEqual(signal(bars, rule, 4), signal(altered, rule, 4))
        self.assertNotEqual(a, trade(altered, rule, 4))

    def test_stop_first_when_both_levels_hit(self):
        bars = sample(5)
        rule = Rule("trend", 2, 0.001, 0.006, 0.009)
        old = bars[3]
        bars[3] = Candle(old.time, old.op, old.op * 1.02,
                         old.op * 0.98, old.cl, old.volume)
        self.assertAlmostEqual(trade(bars, rule, 2), -0.006 - 0.0014, places=9)

    def test_no_lookahead_into_holdout_during_selection(self):
        bars = sample()
        cutoff = int(len(bars) * 0.8)
        a = discover(bars, seed=7, rounds=3)
        modified = list(bars)
        # Change OHLC after holdout begins, without changing its first boundary.
        for i in range(cutoff + 2, len(bars)):
            b = modified[i]
            modified[i] = Candle(b.time, b.op, b.hi * 3, b.lo * 0.1,
                                 b.cl, b.volume)
        b = discover(modified, seed=7, rounds=3)
        self.assertEqual(a["selected"], b["selected"])
        self.assertEqual(a["search"], b["search"])
        self.assertIsNotNone(a["holdout"])

    def test_rejection_still_searches_new_rules(self):
        flat = sample(move=0.0)
        report = discover(flat, rounds=3)
        self.assertEqual(report["status"], "NO_VALIDATED_EDGE")
        self.assertEqual(report["search"]["accepted"], 0)
        self.assertIsNone(report["holdout"])
        self.assertGreaterEqual(report["search"]["tried"], 48)
        self.assertEqual(report["execution"], "OFFLINE_ONLY")

    def test_adaptation_can_stay_flat(self):
        flat = sample(move=0.0)
        s = Rule("trend", 4, 0.001, 0.006, 0.009)
        result = adaptive(flat, [s], 480, 600)
        self.assertEqual(result["trades"], 0)
        self.assertGreater(result["no_trade_bars"], 0)

    def test_reject_gaps_and_non_utc(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "data.csv"
            with p.open("w", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                w.writerow(["timestamp", "open", "high", "low", "close", "volume", "symbol"])
                for bar in sample(480, 0):
                    w.writerow([bar.time.isoformat(), bar.op, bar.hi, bar.lo,
                                bar.cl, bar.volume, "BTC-USDT-SWAP"])
            candles, digest = load_csv(p)
            self.assertEqual(len(candles), 480)
            self.assertEqual(len(digest), 64)
            rows = p.read_text()
            p.write_text(rows.replace("+00:00", "", 1))
            with self.assertRaises(ValueError):
                load_csv(p)

if __name__ == "__main__":
    unittest.main()
