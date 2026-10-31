"""v28 original-source 66-anchor posthoc controls, strict feature/outcome boundary."""
from __future__ import annotations
from datetime import datetime,timezone
from decimal import Decimal
import unittest

from algorithm_controls_v28 import (
    DAYS,HORIZONS,MIN_EXTREME_BPS,anchors,day_ms,
    trade_feature,historical_oi_context,outcome_class,
    source_news_at,description,label,close_features
)
from algorithm_news_pit_v26 import load as load_news


class Controls28Tests(unittest.TestCase):
    def test_exact_time_only_66_cohort_and_reserved_evening_excluded(self):
        all_times=anchors()
        self.assertEqual(len(all_times),66)
        self.assertEqual(len(set(all_times)),66)
        for day in DAYS:
            seq=[t for t in all_times if label(t).startswith(day)]
            self.assertEqual(len(seq),33)
            self.assertEqual(seq[0],day_ms(day)+2*3600000)
            self.assertEqual(seq[28],day_ms(day)+9*3600000)
            self.assertEqual(seq[29],day_ms(day)+14*3600000)
            self.assertEqual(seq[-1],day_ms(day)+14*3600000+45*60000)
        self.assertEqual(HORIZONS,(5,15,60))
        self.assertEqual(MIN_EXTREME_BPS,Decimal(100))

    def test_original_executions_before_signal_only_no_future_tape_leak(self):
        t=day_ms("2026-09-03")+8*3600000
        records=[
            (t-300000,"buy",Decimal(10)),
            (t-30000,"buy",Decimal(50)),
            (t-1,"sell",Decimal(5)),
            (t,"sell",Decimal(10000)),
            (t+1,"buy",Decimal(10000)),
        ]
        times=[x[0] for x in records]
        earlier=trade_feature(records,times,t,-300,-30)
        now=trade_feature(records,times,t,-30,0)
        self.assertEqual(earlier["total_taker_contracts"],"10")
        self.assertEqual(now["taker_buy_contracts"],"50")
        self.assertEqual(now["taker_sell_contracts"],"5")
        self.assertEqual(now["executed_trade_rows"],2)
        self.assertEqual(now["buy_share_contracts"],str(Decimal(50)/Decimal(55)))

    def test_oi_uses_preceding_full_hour_not_signal_or_following_hour(self):
        t=day_ms("2026-09-03")+14*3600000+45*60000
        floor=(t//3600000)*3600000
        oi={floor-2*3600000:Decimal(100),
            floor-3600000:Decimal(120),
            floor:Decimal(999999),
            floor+3600000:Decimal(9999999)}
        result=historical_oi_context(oi,t)
        self.assertEqual(result["older_oi_contracts"],"100")
        self.assertEqual(result["latest_oi_contracts"],"120")
        self.assertEqual(result["historical_hourly_oi_change_percent"],"20.0")
        self.assertTrue(result["availability_at_actual_signal_unverified"])

    def test_news_preannounced_is_not_mistaken_for_past_occurrence(self):
        news=load_news()
        t=day_ms("2026-09-03")+14*3600000+45*60000
        event=source_news_at(news,t)
        future_ids=[x["event_id"] for x in event["curated_preannounced_future_within_2h"]]
        self.assertIn("sep03-near-upgrade-scheduled",future_ids)
        past=[x["event_id"] for x in event["curated_past_occurrences_already_published"]]
        self.assertIn("sep03-ism-services",past)
        self.assertNotIn("sep03-market-liquidations-hour-hindsight",past)
        self.assertTrue(event["news_registry_is_INCOMPLETE_not_all_market_news"])

    def test_future_candle_exact_completed_bar_at_hour_targets(self):
        t=day_ms("2026-09-03")+8*3600000
        rows=[]
        for offset in range(-3,61):
            ts=t+offset*60000
            price=Decimal(100) if offset<=-1 else Decimal(300)
            rows.append([str(ts),str(price),str(price),str(price),str(price),"1","1","1","1"])
        calc=close_features(rows,t)
        self.assertEqual(calc["base_close"],"100")
        self.assertEqual(calc["bps"]["60"],"20000")
        self.assertEqual(calc["bps"]["5"],"20000")
        self.assertTrue(calc["no_future_bar_at_time_t_used"])

    def test_outcome_class_applied_with_no_threshold_tuning(self):
        self.assertEqual(outcome_class("-100"),"EXTREME_DOWN")
        self.assertEqual(outcome_class("100"),"EXTREME_UP")
        self.assertEqual(outcome_class("99.999"),"NONEXTREME")
        self.assertEqual(outcome_class(None),"SOURCE_UNAVAILABLE")
        self.assertEqual(description([]),[])


if __name__=="__main__":
    unittest.main()
