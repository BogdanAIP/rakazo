import datetime as dt
import unittest
from audit_funding_missingness_v40 import reason_for_day, summarize
from test_funding_coverage_v40 import series, FIRST, SYMBOL
import okx_bench_archive_v40 as a

class TestMissingnessAudit(unittest.TestCase):
    def test_month_denominators_and_missing_adjacent_reason(self):
        events=series([8]*3)
        known=a.interval_consistent_funding_days(events)
        t=int(dt.datetime.combine(FIRST,dt.time(),dt.timezone.utc).timestamp()*1000)
        rows=[{"ts":str(t),"symbol":SYMBOL,"eligible":"1","funding":"NA"},
              {"ts":str(t+a.DAY),"symbol":SYMBOL,"eligible":"1","funding":""},
              {"ts":str(t),"symbol":SYMBOL,"eligible":"0","funding":"NA"}]
        month=summarize(rows,events,known)["2023-10"]
        self.assertEqual(month["eligible_rows"],2)
        self.assertEqual(month["eligible_unknown_rows"],1)
        self.assertEqual(month["eligible_unknown_share"],0.5)
        self.assertEqual(month["all_unknown__adjacent_pattern_missing_or_irregular"],2)

    def test_change_and_missing_reason(self):
        d=FIRST+dt.timedelta(days=1)
        self.assertEqual(reason_for_day(d,SYMBOL,{}),"own_pattern_missing_or_irregular")
        patterns={(d,SYMBOL):8,(FIRST,SYMBOL):8,(d+dt.timedelta(days=1),SYMBOL):4}
        self.assertEqual(reason_for_day(d,SYMBOL,patterns),"adjacent_interval_different")

    def test_blank_cell_must_be_known_absence(self):
        # A blank cell bills zero funding, so it is only legal on an inferred-known
        # day and on a bar without an observed settlement; anything else fails closed.
        events=series([8]*3)
        known=a.interval_consistent_funding_days(events)
        t=int(dt.datetime.combine(FIRST,dt.time(),dt.timezone.utc).timestamp()*1000)
        with self.assertRaises(ValueError):  # first day has no earlier neighbour
            summarize([{"ts":str(t),"symbol":SYMBOL,"eligible":"1","funding":""}],events,known)
        settled=min(ts for (ts,s) in events if ts>=t+a.DAY)
        with self.assertRaises(ValueError):  # observed rate dropped
            summarize([{"ts":str(settled),"symbol":SYMBOL,"eligible":"1","funding":""}],events,known)
        month=summarize([{"ts":str(t+a.DAY),"symbol":SYMBOL,"eligible":"1","funding":""}],events,known)
        self.assertEqual(month["2023-10"]["all_unknown_share"],0)

if __name__=="__main__":unittest.main()
