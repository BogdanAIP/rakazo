"""Independent v40.5 funding lifetime and market-gap fixtures."""
import csv
import math
from pathlib import Path
import tempfile
import unittest
import algorithm_bench_v40 as b

class TestFundingLifetime(unittest.TestCase):
    def panel(self, root, missing_x=False, unknown=True):
        path=root/("panel-%s-%s.csv"%(missing_x,unknown))
        with path.open("w",newline="") as stream:
            writer=csv.writer(stream)
            writer.writerow(["ts","symbol","open","high","low","close","volume","eligible","funding","oi"])
            for t in range(30):
                for s in ("X","Y"):
                    if missing_x and s=="X" and t==10:
                        continue
                    writer.writerow([1700002800000+t*3600000,s,100,100,100,100,1000,1,
                                     "0.002" if t==0 else ("NA" if unknown else ""),""])
        return b.load_panel(path)

    def test_exact_24_hour_expiry_and_NA_blank_invariance(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            unknown=b._base_feature(self.panel(root,unknown=True),"funding")
            blank=b._base_feature(self.panel(root,unknown=False),"funding")
            for s in ("X","Y"):
                self.assertTrue(math.isnan(unknown[s][0]))
                for t in range(1,25):
                    self.assertEqual(unknown[s][t],0.002)
                    self.assertEqual(unknown[s][t],blank[s][t])
                self.assertTrue(math.isnan(unknown[s][25]))

    def test_market_gap_resets_next_decision_without_future_peeking(self):
        with tempfile.TemporaryDirectory() as td:
            features=b._base_feature(self.panel(Path(td),missing_x=True),"funding")
            self.assertEqual(features["X"][9],0.002)
            self.assertTrue(math.isnan(features["X"][11]))
            self.assertEqual(features["Y"][11],0.002)

if __name__=="__main__":unittest.main()
