"""Offline first-observation and exact source-volume fixtures."""
import unittest
import audit_listing_boundaries_v40 as b

class TestListingBoundaries(unittest.TestCase):
    def fixture(self):
        case={"symbol":"X-USDT-SWAP","hour_utc":"2023-10-06T03:00:00+00:00","first_minute":56}
        ts=b.milliseconds("2023-10-06T03:56:00+00:00")
        rows=[{"instrument_name":case["symbol"],"open_time":str(ts+i*60000),"vol_quote":vol}
              for i,vol in enumerate(("0","0.1","0.2","0","999"))]
        announced={case["symbol"]:"2023-10-06T04:00:00+00:00"}
        return case,rows,announced

    def test_exact_volume_dedup_and_excludes_launch_minute(self):
        c,r,a=self.fixture()
        v=b.summarize_rows(r+[r[1].copy()], [c], a)[0]
        self.assertTrue(v["case_is_first_archived_minute"])
        self.assertTrue(v["first_observation_same_utc_day_as_announcement"])
        self.assertEqual(v["preannouncement_sum_vol_quote"],"0.3")
        self.assertEqual(v["preannouncement_distinct_minutes"],4)
        self.assertEqual(v["preannouncement_positive_volume_minutes"],2)
        self.assertEqual(v["cause"],"UNKNOWN")

    def test_earlier_archive_observation_invalidates_first_case(self):
        c,r,a=self.fixture()
        r.append({**r[0],"open_time":str(b.milliseconds("2023-10-05T23:00:00+00:00"))})
        v=b.summarize_rows(r,[c],a)[0]
        self.assertFalse(v["case_is_first_archived_minute"])
        self.assertFalse(v["first_observation_same_utc_day_as_announcement"])

    def test_conflicting_duplicate_or_bad_volume_rejected(self):
        c,r,a=self.fixture()
        with self.assertRaises(ValueError):
            b.summarize_rows(r+[{**r[0],"vol_quote":"1"}],[c],a)
        for value in ("NaN","-1"):
            with self.assertRaises(ValueError):
                b.summarize_rows([{**r[0],"vol_quote":value}],[c],a)

if __name__=="__main__":unittest.main()
