"""v29 frozen source-only onset and first-passage test constraints."""
from __future__ import annotations

from decimal import Decimal as D
from datetime import datetime,timezone
import unittest

from algorithm_onset_v29 import (
    SCHEMA,DAYS,SYMBOLS,MAX_FUTURE_MINUTES,COOLDOWN_MINUTES,
    decision_grid,time_ms,exact_completed_close,bps,detector_at,
    first_passage,MIN_INTENSITY_RATIO,MIN_SIGNED_FLOW_FRACTION,
    MUTED_PRICE_ABS_BPS,FIRST_PASSAGE_ABS_BPS,
)


class OnsetV29Tests(unittest.TestCase):
    def test_934_grid_and_sep05_prohibition(self):
        grid=decision_grid()
        self.assertEqual(len(grid),934)
        self.assertEqual(len(set(grid)),934)
        self.assertEqual(grid[0],time_ms("2026-09-03",2,0))
        self.assertEqual(grid[420],time_ms("2026-09-03",9,0))
        self.assertEqual(grid[421],time_ms("2026-09-03",14,0))
        self.assertEqual(grid[466],time_ms("2026-09-03",14,45))
        self.assertEqual(grid[-1],time_ms("2026-09-04",14,45))
        self.assertEqual(MAX_FUTURE_MINUTES,60)
        self.assertEqual(COOLDOWN_MINUTES,60)

    def sample_trade_series(self,t,*,price_now="100"):
        trades=[]
        # Historical five-min baseline exactly 10 equal-sized trades.
        for j in range(10):
            trades.append((t-355000+j*20000,"buy" if j%2 else "sell",D(1)))
        # Current one-minute has 5 large aggressive buys.
        for j in range(5):
            trades.append((t-50000+j*10000,"buy",D(10)))
        trades.sort()
        closes={
            t-120000:D("100"),
            t-60000:D(price_now),
            t:D("500"),  # this future minute MUST NOT enter detector
        }
        return trades,[x[0] for x in trades],closes

    def test_real_past_taker_burst_muted_vs_visible_and_no_future(self):
        t=time_ms("2026-09-03",3,0)
        trades,times,prices=self.sample_trade_series(t)
        x=detector_at(t,trades,times,prices)
        self.assertEqual(x["trigger_qualification"],"QUALIFIED_WITHOUT_COOLDOWN")
        self.assertEqual(x["direction"],1)
        self.assertEqual(x["onset_kind"],"MUTED_PRICE_RESPONSE")
        self.assertEqual(x["latest_1min_strictly_before_decision"]["actual_trade_prints"],5)
        self.assertEqual(x["latest_1min_strictly_before_decision"]["taker_buy_contracts"],"50")
        self.assertGreater(D(x["taker_flow_volume_acceleration_ratio"]),MIN_INTENSITY_RATIO)
        # Inserting huge future sells cannot change signal.
        trades2=trades+[(t,"sell",D(1000000)),(t+100,"sell",D(1000000))]
        y=detector_at(t,trades2,[a[0] for a in trades2],prices)
        self.assertEqual(y["direction"],x["direction"])
        self.assertEqual(y["onset_kind"],x["onset_kind"])
        prices[t]=D(1)
        z=detector_at(t,trades,times,prices)
        self.assertEqual(z["onset_kind"],x["onset_kind"])
        self.assertTrue(z["no_future_trades_or_candles_in_detector"])

    def test_visible_when_last_completed_minute_moves(self):
        t=time_ms("2026-09-03",3,0)
        trades,times,prices=self.sample_trade_series(t,price_now="101")
        x=detector_at(t,trades,times,prices)
        self.assertEqual(x["onset_kind"],"VISIBLE_PRICE_RESPONSE")
        self.assertTrue(x["immediate_price_move_is_aligned_with_flow"])
        self.assertEqual(x["direction"],1)

    def test_unexpectedly_small_prior_baseline_must_abstain(self):
        t=time_ms("2026-09-03",3,0)
        trades,times,prices=self.sample_trade_series(t)
        recent=trades[-5:]
        result=detector_at(t,recent,[x[0] for x in recent],prices)
        self.assertEqual(result["trigger_qualification"],"SOURCE_MISSING")
        # Valid source chronology but no volume baseline -> abstain.
        all_trades=[(t-360000,"buy",D(1))]+recent
        result=detector_at(t,all_trades,[x[0] for x in all_trades],prices)
        self.assertEqual(result["trigger_qualification"],"BASELINE_ZERO_ABSTAIN")

    def test_first_passage_favorable_and_future_censoring(self):
        t=time_ms("2026-09-03",4,0)
        asset={}
        for symbol in SYMBOLS:
            vals={t-60000:D(100)}
            for h in range(1,61):
                vals[t+(h-1)*60000]=D(100)
            asset[symbol]=vals
        # Positive 1% barrier first at minute4, adverse thereafter.
        for h in range(4,61):
            asset["NEAR-USDT-SWAP"][t+(h-1)*60000]=D("102") if h<10 else D("98")
        r=first_passage({"decision_ms":t,"direction":1},asset)
        self.assertEqual(r["outcome"],"DIRECTIONAL_100BPS_FIRST")
        self.assertEqual(r["first_passage_minute"],4)
        self.assertEqual(len(r["all_60minute_source_close_trajectory"]),60)
        # Different direction gets adverse outcome first.
        r=first_passage({"decision_ms":t,"direction":-1},asset)
        self.assertEqual(r["outcome"],"ADVERSE_100BPS_FIRST")
        self.assertEqual(r["first_passage_minute"],4)

    def test_no_barrier_results_in_censored_not_profitable(self):
        t=time_ms("2026-09-04",3,0)
        bars={s:{t-60000:D(100),**{t+(h-1)*60000:D(100) for h in range(1,61)}}
              for s in SYMBOLS}
        r=first_passage({"decision_ms":t,"direction":1},bars)
        self.assertEqual(r["outcome"],"CENSORED_60_MINUTES")
        self.assertIsNone(r["first_passage_minute"])

    def test_parameters_frozen(self):
        self.assertEqual(MIN_SIGNED_FLOW_FRACTION,D("0.60"))
        self.assertEqual(MIN_INTENSITY_RATIO,D("3.0"))
        self.assertEqual(MUTED_PRICE_ABS_BPS,D("5.0"))
        self.assertEqual(FIRST_PASSAGE_ABS_BPS,D("100"))


if __name__=="__main__":
    unittest.main()
