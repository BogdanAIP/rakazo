"""Synthetic diagnostics of existing r2 correlation semantics; no gate changes.

Run from scripts/trading with python -m unittest test_j8_correlation_diagnostics_v40 -v.
These tests document traps a J8 replay/reviewer must distinguish from novelty.
They neither authorize validation nor modify the frozen evaluator.
"""
import math
import unittest

from algorithm_search_v40 import _corr


def matched(a_times, a_returns, b_times, b_returns):
    """Fixture alignment only: reject lossy zip/dict conversions."""
    for ts, rs in ((a_times, a_returns), (b_times, b_returns)):
        if len(ts) != len(rs) or len(set(ts)) != len(ts):
            raise ValueError("length mismatch or duplicate timestamp")
        if not all(math.isfinite(r) for r in rs):
            raise ValueError("nonfinite return")
    a, b = dict(zip(a_times, a_returns)), dict(zip(b_times, b_returns))
    times = sorted(a.keys() & b.keys())
    return times, [a[t] for t in times], [b[t] for t in times]


class J8CorrelationDiagnostics(unittest.TestCase):
    def test_prefix_can_reverse_timestamp_matched_conclusion(self):
        xs = [math.sin(t * math.pi / 5) for t in range(30)]
        ts, a, b = matched(list(range(30)), xs, list(range(5, 35)), xs)
        self.assertEqual(len(ts), 25)
        self.assertAlmostEqual(_corr(xs, xs), 1.0)
        self.assertAlmostEqual(_corr(a, b), -1.0)

    def test_panel_labels_are_part_of_step_identity(self):
        # Same bar index on different exchanges is not the same observation.
        a = [("OKX", t) for t in range(20)]
        b = [("Binance", t) for t in range(20)]
        ts, _, _ = matched(a, list(range(20)), b, list(range(20)))
        self.assertEqual(ts, [])

    def test_opposite_panel_correlations_can_cancel_when_pooled(self):
        xs = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]
        neg = [-x for x in xs]
        self.assertAlmostEqual(_corr(xs, xs), 1.0)
        self.assertAlmostEqual(_corr(xs, neg), -1.0)
        self.assertAlmostEqual(_corr(xs + xs, xs + neg), 0.0)

    def test_short_series_zero_is_existing_sentinel_not_valid_correlation(self):
        self.assertEqual(_corr(list(range(9)), list(range(9))), 0.0)

    def test_constant_series_zero_is_existing_sentinel_not_novelty(self):
        self.assertEqual(_corr([1.0] * 20, list(range(20))), 0.0)

    def test_alignment_rejects_duplicates_lengths_and_nonfinite(self):
        good = (list(range(20)), list(range(20)))
        for bad in (([0, 0], [1, 2]), ([0, 1], [1]), ([0, 1], [1, float("nan")])):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                matched(*bad, *good)


if __name__ == "__main__":
    unittest.main()
