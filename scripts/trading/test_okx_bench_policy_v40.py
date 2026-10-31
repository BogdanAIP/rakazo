import unittest
from unittest.mock import patch
from pathlib import Path
import datetime as dt
import okx_bench_archive_v40 as a

class TestReviewedPolicy(unittest.TestCase):
 def test_clock_edges(self):
  h=2*a.HOUR
  self.assertEqual(a.nominal_funding_hour(h),h)
  self.assertEqual(a.nominal_funding_hour(h+59999),h)
  for t in (h-1,h+60000):
   with self.assertRaises(ValueError):a.nominal_funding_hour(t)
 def test_clock_counters_and_collision(self):
  h=2*a.HOUR; rows=[{'instrument_name':'X-USDT-SWAP','funding_time':str(h+8000),'funding_rate':'.001'}]; audit={}
  with patch.object(a,'read_zip_rows',return_value=iter(rows)):
   e,_,n=a.load_funding(Path('.'),[dt.date(2023,10,1)],audit)
  self.assertEqual(n,1);self.assertIn((h-a.HOUR,'X-USDT-SWAP'),e);self.assertEqual(audit['snapped_events'],1);self.assertEqual(audit['maximum_offset_ms'],8000)
  rows.append({**rows[0],'funding_time':str(h+9000)})
  with patch.object(a,'read_zip_rows',return_value=iter(rows)):
   with self.assertRaises(ValueError):a.load_funding(Path('.'),[dt.date(2023,10,1)])
 def test_duplicate_fields_and_unique_volume(self):
  row={'instrument_name':'X-USDT-SWAP','open_time':str(2*a.HOUR),'open':'1','high':'1','low':'1','close':'1','vol_quote':'7','confirm':'0'}
  with patch.object(a,'read_zip_rows',return_value=iter([row,row.copy()])):
   bars,stats=a.aggregate_day(Path('.'),dt.date(2023,10,1),{})
  self.assertEqual(bars[0][6],7);self.assertEqual(bars[0][8],1);self.assertEqual(stats['identical_duplicate_rows_collapsed'],1);self.assertEqual(stats['missing_source_minutes'],59)
  with patch.object(a,'read_zip_rows',return_value=iter([row,{**row,'close':'2'}])):
   with self.assertRaises(ValueError):a.aggregate_day(Path('.'),dt.date(2023,10,1),{})

if __name__=='__main__':unittest.main()
