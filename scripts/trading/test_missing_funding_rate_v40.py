"""Unavailable source funding is explicit UNKNOWN, never a fabricated zero."""
import datetime as dt
import math
from pathlib import Path
import unittest
from unittest.mock import patch
import okx_bench_archive_v40 as a
import audit_okx_bench_sources_v40 as audit
from audit_funding_missingness_v40 import summarize
from test_funding_coverage_v40 import series, FIRST, SYMBOL

class TestMissingFundingRate(unittest.TestCase):
    def rows(self):
        events=series([8]*5)
        # A marker off the 8h grid used to look like a clean 8h pattern if skipped.
        day=FIRST+dt.timedelta(days=2)
        t=int(dt.datetime.combine(day,dt.time(3),dt.timezone.utc).timestamp()*1000)
        rows=[{"instrument_name":s,"funding_time":str(t+a.HOUR),"funding_rate":str(v)}
              for (t,s),v in events.items()]
        rows.append({"instrument_name":SYMBOL,"funding_time":str(t+a.HOUR),"funding_rate":"None"})
        return rows,events,day,t

    def test_parser_distinguishes_unavailable_zero_and_bad_values(self):
        self.assertIsNone(a.parse_funding_rate("None"))
        self.assertEqual(a.parse_funding_rate("0"),0.0)
        self.assertEqual(a.parse_funding_rate("-0.001"),-0.001)
        for value in ("","NaN","inf","none","broken"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                a.parse_funding_rate(value)

    def test_marker_taints_billing_day_and_prevents_alias_schedule(self):
        rows,expected,day,t=self.rows();unknown=set();clock={}
        with patch.object(a,"read_zip_rows",return_value=iter(rows)):
            events,known,count=a.load_funding(Path("."),[FIRST],clock,unknown)
        self.assertEqual(events,expected)
        self.assertEqual(count,16)
        self.assertEqual(unknown,{(day,SYMBOL)})
        self.assertNotIn((t,SYMBOL),events)
        self.assertFalse(known) # both adjacent patterns also fail closed
        self.assertEqual(clock["unknown_rate_events"],1)
        self.assertEqual(clock["numeric_rate_events"],15)

    def test_explicit_unknown_stays_NA_and_zero_or_blank_cannot_replace_it(self):
        rows,_,day,t=self.rows();unknown=set()
        with patch.object(a,"read_zip_rows",return_value=iter(rows)):
            events,known,_=a.load_funding(Path("."),[FIRST],unknown_rate_days=unknown)
        row={"ts":str(t),"symbol":SYMBOL,"eligible":"1","funding":"NA"}
        result=summarize([row],events,known,unknown)["2023-10"]
        self.assertEqual(result["eligible_unknown_rows"],1)
        self.assertEqual(result["eligible_unknown__source_unknown_rate"],1)
        for fake in ("","0"):
            with self.assertRaises(ValueError):
                summarize([{**row,"funding":fake}],events,known,unknown)

    def test_duplicate_unknown_record_still_aborts(self):
        rows,_,_,_=self.rows();rows.append(rows[-1].copy())
        with patch.object(a,"read_zip_rows",return_value=iter(rows)):
            with self.assertRaisesRegex(ValueError,"Duplicate settlement"):
                a.load_funding(Path("."),[FIRST])

    def test_diagnostics_count_unknown_markers_separately_from_numeric_rates(self):
        result=audit.funding_diagnostics({(0,"X"):None,(8*a.HOUR,"X"):0.0},set())
        self.assertEqual(result["observed_events"],2)
        self.assertEqual(result["unknown_rate_events"],1)
        self.assertEqual(result["numeric_rate_events"],1)


    def test_off_hour_unavailable_marker_does_not_widen_numeric_clock_policy(self):
        rows,expected,day,_=self.rows()
        marker=rows.pop()
        marker["funding_time"]=str(int(marker["funding_time"])+120000)
        rows.append(marker);unknown=set();clock={}
        with patch.object(a,"read_zip_rows",return_value=iter(rows)):
            events,known,count=a.load_funding(Path("."),[FIRST],clock,unknown)
        self.assertEqual(events,expected)
        self.assertEqual(count,16)
        self.assertFalse(known)
        self.assertEqual(unknown,{(day,SYMBOL)})
        self.assertEqual(clock["unknown_rate_events"],1)
        self.assertEqual(clock["unavailable_off_hour_markers"],1)
        self.assertEqual(clock["outside_window_events"],1)
        for value in ("0","0.001"):
            with self.subTest(value=value), patch.object(a,"read_zip_rows",return_value=iter([{**marker,"funding_rate":value}])):
                with self.assertRaisesRegex(ValueError,"outside reviewed"):
                    a.load_funding(Path("."),[FIRST])

    def test_midnight_unknown_marker_taints_both_days_and_duplicates_abort(self):
        day=FIRST+dt.timedelta(days=2)
        t=int(dt.datetime.combine(day,dt.time(0,2),dt.timezone.utc).timestamp()*1000)
        row={"instrument_name":SYMBOL,"funding_time":str(t),"funding_rate":"None"}
        unknown=set();clock={}
        with patch.object(a,"read_zip_rows",return_value=iter([row])):
            events,known,count=a.load_funding(Path("."),[FIRST],clock,unknown)
        self.assertEqual(events,{})
        self.assertFalse(known)
        self.assertEqual(count,1)
        self.assertEqual(unknown,{(day,SYMBOL),(day-dt.timedelta(days=1),SYMBOL)})
        self.assertEqual(clock["unknown_rate_events"],1)
        with patch.object(a,"read_zip_rows",return_value=iter([row,row.copy()])):
            with self.assertRaisesRegex(ValueError,"Duplicate settlement marker"):
                a.load_funding(Path("."),[FIRST])

if __name__=="__main__":unittest.main()
