"""V3 robustness regression checks. All price series are synthetic."""
import unittest

from alpha_discovery import Candle
from alpha_robust import (
    MIN_BARS_V3, NORMAL_BPS_SIDE, STRESS_BPS_SIDE,
    STRESS_FUNDING_BPS_TRADE, robust_walk_forward,
    stress_adjust, test_fold,
)
from test_alpha_discovery import sample


class RobustTests(unittest.TestCase):
    def test_adverse_costs_decrease_net_returns(self):
        raw = [0.01, -0.02, 0.005]
        result = stress_adjust(raw, STRESS_BPS_SIDE, STRESS_FUNDING_BPS_TRADE)
        cost = (2 * (STRESS_BPS_SIDE - NORMAL_BPS_SIDE)
                + STRESS_FUNDING_BPS_TRADE) / 10000
        for old, new in zip(raw, result):
            self.assertAlmostEqual(old - new, cost, places=12)

    def test_no_hidden_zero_funding_claim(self):
        result = robust_walk_forward(sample(MIN_BARS_V3, 0), rounds=1)
        self.assertFalse(result["policy"]["actual_historical_funding_verified"])
        self.assertFalse(result["policy"]["liquidation_simulated"])
        self.assertFalse(result["policy"]["multiple_testing_corrected"])
        self.assertEqual(result["development_gate"]["status"], "NO_VALIDATED_EDGE")
        self.assertIsNone(result["holdout"])

    def test_short_dataset_fail_closed(self):
        with self.assertRaises(ValueError):
            robust_walk_forward(sample(MIN_BARS_V3 - 1, 0))

    def test_no_future_data_used_for_rule_selection(self):
        candles = sample(1200, 0.013)
        a, *_ = test_fold(candles, 964, 1156, seed=42, rounds=1)
        altered = list(candles)
        c = altered[965]
        altered[965] = Candle(c.time, c.op, c.hi * 4,
                              c.lo * 0.01, c.cl, c.volume)
        b, *_ = test_fold(altered, 964, 1156, seed=42, rounds=1)
        self.assertEqual(a["candidate"], b["candidate"])
        self.assertEqual(a["selection"], b["selection"])
        self.assertNotEqual(a["normal"], b["normal"])
        self.assertEqual(a["train"], [0, 960])
        self.assertEqual(a["embargo"], [960, 964])

    def test_synthetic_positive_not_paper_permission(self):
        result = robust_walk_forward(sample(MIN_BARS_V3, 0.013), rounds=1)
        self.assertTrue(result["development_gate"]["passed"])
        self.assertIsNotNone(result["holdout"])
        self.assertFalse(result["can_submit_orders"])
        self.assertFalse(result["development_gate"]["model_selection_bias_corrected"])
        self.assertFalse(result["development_gate"]["statistical_significance_proven"])


if __name__ == "__main__":
    unittest.main()
