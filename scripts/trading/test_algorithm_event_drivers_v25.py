"""v25 scientific post-hoc book drivers: no future quote values and no trade inference."""
from __future__ import annotations
from decimal import Decimal
import unittest

from algorithm_event_drivers_v25 import (
    SCHEMA,SAMPLES,OFFSETS_S,UPDATE_WINDOWS,signal_time,quote,
    empty_counter,record_update
)


class EventDrivers25Tests(unittest.TestCase):
    def test_samples_are_explicitly_two_winners_two_losers(self):
        self.assertEqual(len(SAMPLES),4)
        self.assertEqual(sum(x[2]=="LARGEST_LONG_WIN" for x in SAMPLES),2)
        self.assertEqual(sum(x[2]=="LOSS_CONTRAST" for x in SAMPLES),2)
        self.assertEqual(OFFSETS_S[0],-300)
        self.assertEqual(OFFSETS_S[-1],3600)
        self.assertEqual(UPDATE_WINDOWS[1],(-30,0))
        self.assertLess(signal_time("2026-09-03","14:45"),
                        signal_time("2026-09-04","19:15"))

    def test_asof_quote_strictly_uses_old_book_and_new_bracket_only(self):
        book={"bids":{Decimal("2.001"):Decimal("50"),
                      Decimal("2.000"):Decimal("20")},
              "asks":{Decimal("2.002"):Decimal("10"),
                      Decimal("2.003"):Decimal("30")}}
        q=quote(book,1000,1100,1101)
        self.assertEqual(q["bid"],"2.001")
        self.assertEqual(q["ask"],"2.002")
        self.assertEqual(q["bid_top5_depth"],"70")
        self.assertEqual(q["ask_top5_depth"],"40")
        self.assertEqual(q["quote_age_ms"],100)
        self.assertEqual(q["first_next_event_utc_ms"],1101)
        with self.assertRaises(ValueError):
            quote(book,1200,1100,1250)
        self.assertEqual(quote(book,1000,6100,6101)["status"],"STALE_ASOF")

    def test_abs_level_qty_changes_not_mislabeled_trade_activity(self):
        t=1_000_000
        counters=[empty_counter(a,b) for a,b in UPDATE_WINDOWS]
        book={"bids":{Decimal("100"):Decimal("10")}, "asks":{Decimal("101"):Decimal("15")}}
        sides={"bids":[(Decimal("100"),Decimal("30"))],
               "asks":[(Decimal("101"),Decimal("4"))]}
        record_update(counters,t-10_000,t,"update",book,sides)
        self.assertEqual(counters[1]["incremental_book_updates"],1)
        self.assertEqual(counters[1]["bid_level_positive_size_change"],Decimal("20"))
        self.assertEqual(counters[1]["ask_level_negative_size_change_magnitude"],Decimal("11"))
        self.assertNotIn("executed_trades",counters[1])
        record_update(counters,t-5000,t,"snapshot",book,sides)
        self.assertEqual(counters[1]["full_snapshot_resets"],1)
        self.assertEqual(counters[1]["incremental_book_updates"],1)


if __name__=="__main__":
    unittest.main()
