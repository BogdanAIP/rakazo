"""v30 research-only invariants and negative examples; offline, no orders."""
from __future__ import annotations
import unittest
from datetime import datetime,timezone,timedelta
from decimal import Decimal as D
from algorithm_v30_archive_acquire import registered
from algorithm_v30_trade_onset import cohort,load_bars,load_trades
from algorithm_v30_summary import ORIGINALS,EVENTS,wilson
from algorithm_onset_v29 import detector_at,time_ms,MIN_TRADE_PRINTS,MIN_INTENSITY_RATIO,MIN_SIGNED_FLOW_FRACTION

class V30ResearchTests(unittest.TestCase):
    def test_frozen_original_archive_cohort_without_reserved_holdout(self):
        self.assertEqual(len(ORIGINALS),4)
        self.assertEqual({x[0] for x in ORIGINALS},{"2026-09-10","2026-09-17"})
        self.assertEqual({x[1] for x in ORIGINALS},{"NEAR-USDT-SWAP","SOL-USDT-SWAP"})
        for day,sym in ORIGINALS:
            a=cohort(day)
            self.assertEqual(len(a),467)
            self.assertEqual(len(set(a)),467)
            self.assertEqual(a[0],time_ms(day,2,0))
            self.assertEqual(a[420],time_ms(day,9,0))
            self.assertEqual(a[421],time_ms(day,14,0))
            self.assertEqual(a[-1],time_ms(day,14,45))
    def test_only_official_preregistered_sources_accepted(self):
        for day,sym in ORIGINALS:
            for kind in ("L2","trades","candlesticks"):
                name,url=registered(day,sym,kind)
                self.assertIn(day,name)
                self.assertIn(sym,name)
                self.assertTrue(url.startswith("https://static.okx.com/"))
            for forbidden in ("2026-09-05","2026-11-02","2026-09-04"):
                with self.assertRaises(ValueError):registered(forbidden,sym,"L2")
        for sym in ("BTC-USDT-SWAP","ETH-USDT-SWAP"):
            registered("2026-09-10",sym,"candlesticks")
            with self.assertRaises(ValueError):registered("2026-09-10",sym,"trades")
            with self.assertRaises(ValueError):registered("2026-09-10",sym,"L2")
    def test_detector_does_not_use_future_trade_even_if_extreme(self):
        t=time_ms("2026-09-10",4,0)
        baseline=[(t-350000+j*25000,"sell",D(1)) for j in range(10)]
        recent=[(t-50000+j*10000,"buy",D(20)) for j in range(5)]
        rows=sorted(baseline+recent)
        close={t-120000:D(100),t-60000:D(100)}
        info=detector_at(t,rows,[x[0] for x in rows],close)
        self.assertEqual(info["trigger_qualification"],"QUALIFIED_WITHOUT_COOLDOWN")
        self.assertEqual(info["direction"],1)
        self.assertEqual(info["onset_kind"],"MUTED_PRICE_RESPONSE")
        future=sorted(rows+[(t,"sell",D(1000000)),(t+1000,"sell",D(1000000))])
        info2=detector_at(t,future,[x[0] for x in future],close)
        self.assertEqual(info["direction"],info2["direction"])
        self.assertEqual(info["taker_flow_volume_acceleration_ratio"],info2["taker_flow_volume_acceleration_ratio"])
        self.assertEqual(MIN_TRADE_PRINTS,5)
        self.assertEqual(MIN_INTENSITY_RATIO,D("3.0"))
        self.assertEqual(MIN_SIGNED_FLOW_FRACTION,D("0.60"))
    def test_liquidity_alignment_sign_is_not_outcome(self):
        signed_flow=1
        i_prev=D("0.05");i_now=D("0.08")
        a=D(signed_flow)*(i_now-i_prev)
        self.assertTrue(a>0)
        opposite=D(-1)*(i_now-i_prev)
        self.assertTrue(opposite<0)
        flat=D(-1)*(i_now-i_now)
        self.assertEqual(flat,0)
        self.assertFalse(flat>0)
    def test_wilson_small_sample_and_invalid_samples(self):
        self.assertEqual(wilson(0,0),None)
        self.assertAlmostEqual(wilson(4,14)[0],.1172,places=4)
        self.assertAlmostEqual(wilson(3,7)[1],.7495,places=4)
        self.assertGreater(wilson(4,14)[1],wilson(3,7)[0])
    def test_news_asof_boundary_and_postdated_press(self):
        table={x["key"]:datetime.fromisoformat(x["utc"]) for x in EVENTS}
        signal=datetime.fromisoformat("2026-09-10T14:30:00+00:00")
        self.assertEqual(signal-table["PPI"],timedelta(minutes=120))
        morning=datetime.fromisoformat("2026-09-17T08:17:00+00:00")
        self.assertTrue(table["NEAR-PR"]>morning)
        self.assertGreater(morning-table["FOMC"],timedelta(minutes=120))
if __name__=="__main__":unittest.main()
