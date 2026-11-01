"""Offline regressions for conservative funding absence inference."""
import datetime as dt
from pathlib import Path
import unittest
from unittest.mock import patch
import okx_bench_archive_v40 as a

SYMBOL = "X-USDT-SWAP"
FIRST = dt.date(2023, 10, 1)

def daily(day, interval=8):
    start = int(dt.datetime.combine(day, dt.time(), dt.timezone.utc).timestamp() * 1000)
    return {(start + h*a.HOUR, SYMBOL): 0.001
            for h in range(interval-1, 24, interval)}

def series(intervals):
    events = {}
    for n, interval in enumerate(intervals):
        if interval:
            events.update(daily(FIRST+dt.timedelta(days=n), interval))
    return events

class TestFundingCoverage(unittest.TestCase):
    def test_three_of_three_eight_hour_and_source_edges(self):
        audit = {}
        known = a.interval_consistent_funding_days(series([8]*5), audit)
        self.assertEqual(known, {(FIRST+dt.timedelta(days=n), SYMBOL) for n in (1,2,3)})
        self.assertEqual(audit["known_days_by_interval_hours"], {"8":3})
        self.assertFalse(audit["schedule_provenance_certified"])

    def test_missing_one_of_three_is_unknown_and_neighbours_fail_closed(self):
        events = series([8]*5)
        events.pop(next(k for k in daily(FIRST+dt.timedelta(days=2)) if k[0] % a.DAY == 15*a.HOUR))
        self.assertFalse(a.interval_consistent_funding_days(events))

    def test_six_of_six_four_hour(self):
        known = a.interval_consistent_funding_days(series([4]*3))
        self.assertEqual(known, {(FIRST+dt.timedelta(days=1), SYMBOL)})

    def test_interval_change_boundary_days_unknown(self):
        known = a.interval_consistent_funding_days(series([8,8,8,4,4,4]))
        self.assertEqual(known, {(FIRST+dt.timedelta(days=n), SYMBOL) for n in (1,4)})

    def test_partial_listing_day_unknown(self):
        events = series([8]*4)
        events.pop(next(iter(daily(FIRST))))
        known = a.interval_consistent_funding_days(events)
        self.assertEqual(known, {(FIRST+dt.timedelta(days=2), SYMBOL)})

    def test_missing_calendar_day_not_bridged(self):
        self.assertFalse(a.interval_consistent_funding_days(series([8,8,None,8,8])))

    def test_one_and_two_hour_patterns_and_irregular_phase(self):
        for interval in (1,2):
            self.assertEqual(len(a.interval_consistent_funding_days(series([interval]*3))), 1)
        events = {((t+a.HOUR), s): rate for (t,s),rate in series([8]*3).items()}
        self.assertFalse(a.interval_consistent_funding_days(events))

    def test_contracts_do_not_supply_each_others_neighbours(self):
        events = series([8]*3)
        events = {(t, SYMBOL if t//a.DAY % 2 else "Y-USDT-SWAP"): r
                  for (t,_),r in events.items()}
        self.assertFalse(a.interval_consistent_funding_days(events))

    def test_zero_rate_is_an_observed_settlement(self):
        events = {key:0.0 for key in series([8]*3)}
        self.assertEqual(len(a.interval_consistent_funding_days(events)), 1)

    def test_midnight_settlement_bills_preceding_day(self):
        events = series([8]*3)
        rows = [{"instrument_name":s, "funding_time":str(t+a.HOUR+8000),
                 "funding_rate":str(r)} for (t,s),r in events.items()]
        audit = {}
        with patch.object(a, "read_zip_rows", return_value=iter(rows)):
            loaded, known, count = a.load_funding(Path("."), [FIRST], audit)
        self.assertEqual(loaded, events)
        self.assertEqual(count, 9)
        self.assertEqual(known, {(FIRST+dt.timedelta(days=1), SYMBOL)})
        self.assertEqual(audit["snapped_events"], 9)

    def test_observed_rates_preserved_on_unknown_day(self):
        events = daily(FIRST)
        rows = [{"instrument_name":s, "funding_time":str(t+a.HOUR),
                 "funding_rate":str(r)} for (t,s),r in events.items()]
        with patch.object(a, "read_zip_rows", return_value=iter(rows)):
            loaded, known, count = a.load_funding(Path("."), [FIRST])
        self.assertEqual(loaded, events)
        self.assertEqual(count, 3)
        self.assertFalse(known)

if __name__ == "__main__":
    unittest.main()
