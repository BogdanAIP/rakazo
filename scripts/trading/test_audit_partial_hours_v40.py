import unittest
from audit_partial_hours_v40 import geometry
class TestGeometry(unittest.TestCase):
 def test_missing_partition(self):
  g=geometry([2,3,5,58]);self.assertEqual(g['leading_missing'],2);self.assertEqual(g['trailing_missing'],1);self.assertEqual(g['internal_missing'],53);self.assertEqual(g['missing_minutes'],56);self.assertEqual(g['missing_minutes'],g['leading_missing']+g['trailing_missing']+g['internal_missing'])
 def test_complete_and_invalid(self):
  self.assertEqual(geometry(range(60))['missing_minutes'],0)
  for values in ([],[-1],[60]):
   with self.assertRaises(ValueError):geometry(values)
