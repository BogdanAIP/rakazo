"""Synthetic funding event validation; never claim exchange-origin proof."""
import unittest
from datetime import datetime, timedelta, timezone

from okx_funding_events import known_settlement_cashflow, validate

SYMBOL = "BTC-USDT-SWAP"
NOW = datetime(2025, 5, 1, tzinfo=timezone.utc)
BASE = int((NOW - timedelta(days=2)).timestamp() * 1000)


def pages():
    return [{"code":"0","data":[
        {"instId": SYMBOL, "fundingTime": str(BASE + 8*3600000),
         "realizedRate": "-0.0003", "fundingRate": "-0.0001"},
        {"instId": SYMBOL, "fundingTime": str(BASE),
         "realizedRate": "0.0002", "fundingRate": "0.0004"},
    ]}]


class FundingTests(unittest.TestCase):
    def test_only_realized_rate_matters_and_signs_are_correct(self):
        result = validate(pages(), SYMBOL, NOW)
        self.assertEqual(result["events_count"], 2)
        self.assertFalse(result["calendar_completeness_verified"])
        entry, exit = BASE - 1, BASE + 8 * 3600000
        long = known_settlement_cashflow(1, entry, exit, result["events"])
        short = known_settlement_cashflow(-1, entry, exit, result["events"])
        self.assertAlmostEqual(long["observed_cashflow_per_notional"], 0.0001)
        self.assertAlmostEqual(short["observed_cashflow_per_notional"], -0.0001)
        self.assertEqual(long["observed_settlements"], 2)

    def test_no_observed_funding_is_not_certified_zero(self):
        result = validate(pages(), SYMBOL, NOW)
        start = BASE + 1
        end = BASE + 100
        record = known_settlement_cashflow(1, start, end, result["events"])
        self.assertEqual(record["observed_settlements"], 0)
        self.assertFalse(record["coverage_certified"])
        self.assertFalse(record["no_settlement_observed_means_zero_funding"])

    def test_reject_forecast_only_duplicate_unsorted_or_foreign(self):
        import copy
        bad = copy.deepcopy(pages())
        del bad[0]["data"][0]["realizedRate"]
        with self.assertRaises(ValueError):
            validate(bad, SYMBOL, NOW)
        bad = copy.deepcopy(pages())
        bad[0]["data"][1]["fundingTime"] = bad[0]["data"][0]["fundingTime"]
        with self.assertRaises(ValueError):
            validate(bad, SYMBOL, NOW)
        bad = copy.deepcopy(pages())
        bad[0]["data"][0]["instId"] = "SOL-USDT-SWAP"
        with self.assertRaises(ValueError):
            validate(bad, SYMBOL, NOW)
        bad = copy.deepcopy(pages())
        bad[0]["data"][0]["fundingTime"] = str(int((NOW + timedelta(days=1)).timestamp()*1000))
        with self.assertRaises(ValueError):
            validate(bad, SYMBOL, NOW)

    def test_funding_interval_not_fixed_at_eight_hours(self):
        p = pages()
        # Legitimate altcoins can settle more frequently, so don't assume 8h.
        p[0]["data"][0]["fundingTime"] = str(BASE + 3600000)
        result = validate(p, SYMBOL, NOW)
        self.assertEqual(result["events_count"], 2)


if __name__ == "__main__":
    unittest.main()
