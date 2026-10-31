"""Offline tests of funding-coverage diagnostics; no expected schedule is fabricated."""
import datetime as dt
import unittest

import audit_okx_bench_sources_v40 as audit


class TestFundingCoverageDiagnostics(unittest.TestCase):
    def test_original_off_hour_clock_is_reported_without_rounding(self):
        t = int(dt.datetime(2023, 10, 1, 8, tzinfo=dt.timezone.utc).timestamp() * 1000) + 8000
        events = {(t, "X"): 0.001}
        result = audit.funding_diagnostics(events, {("2023-10-01", "X")})
        self.assertEqual(result["non_hour_aligned_events"], 1)
        self.assertEqual(result["hour_offset_histogram_ms"], {8000: 1})
        self.assertFalse(result["hour_bucket_rounding_performed"])
        self.assertEqual(next(iter(events))[0], t)

    def test_zero_rate_is_an_observed_settlement_not_absent_data(self):
        t = int(dt.datetime(2023, 10, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        events = {(t + h * 3_600_000, "X"): 0.0 for h in (0, 8, 16)}
        result = audit.funding_diagnostics(events, {("2023-10-01", "X")})
        self.assertEqual(result["settlement_count_histogram_full_days"], {3: 1})
        self.assertEqual(result["zero_observed_settlement_full_days"], 0)
        self.assertFalse(result["coverage_certified"])

    def test_variable_and_zero_event_days_are_flagged_without_assuming_eight_hours(self):
        t = int(dt.datetime(2023, 10, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        events = {(t + h * 3_600_000, "X"): 0.001 for h in (0, 8, 16, 24, 40)}
        full = {("2023-10-01", "X"), ("2023-10-02", "X"), ("2023-10-03", "X")}
        result = audit.funding_diagnostics(events, full)
        self.assertEqual(result["settlement_count_histogram_full_days"], {0: 1, 2: 1, 3: 1})
        self.assertEqual(result["symbols_with_varying_full_day_counts"], ["X"])
        self.assertEqual(result["gaps_greater_than_eight_hours"], 1)
        self.assertFalse(result["historical_settlement_schedule_verified"])


if __name__ == "__main__":
    unittest.main()
