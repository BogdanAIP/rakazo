"""v29 genuine book-source corroboration: cannot use future quote values."""
from __future__ import annotations

from decimal import Decimal as D
from pathlib import Path
import tempfile
import unittest

import algorithm_temporal_response_v23 as v23
from algorithm_onset_l2_audit_v29 import (
    SCHEMA,ORIGINAL_ONSET_SHA,asof_original,audit
)


class BookOnsetV29Tests(unittest.TestCase):
    def test_exact_l2_quote_uses_prior_book_and_near_next_bracket_only(self):
        book={"bids":{D("1.999"):D("40"),D("1.998"):D("20")},
              "asks":{D("2.001"):D("10"),D("2.002"):D("30")}}
        state=v23.new_state()
        state["book"]={
            "bids":{str(k):str(v) for k,v in book["bids"].items()},
            "asks":{str(k):str(v) for k,v in book["asks"].items()},
        }
        _,heaps=v23.heaps_from_book(state)
        q=asof_original(book,heaps,1000,1100,1101)
        self.assertEqual(q["status"],"AVAILABLE")
        self.assertEqual(q["original_top5_bid_depth"],"60")
        self.assertEqual(q["original_top5_ask_depth"],"40")
        self.assertEqual(q["midquote"],"2.000")
        self.assertTrue(q["displayed_depth_is_not_executed_volume_or_order_intent"])

    def test_invalid_future_asof_quote_fails_closed(self):
        book={"bids":{D("1"):D("2")},"asks":{D("2"):D("3")}}
        state=v23.new_state()
        state["book"]={"bids":{"1":"2"},"asks":{"2":"3"}}
        _,heaps=v23.heaps_from_book(state)
        with self.assertRaises(ValueError):
            asof_original(book,heaps,1200,1100,1300)
        q=asof_original(book,heaps,1000,1100,12000)
        self.assertEqual(q["status"],"UNAVAILABLE_NO_NEAR_FUTURE_BRACKET")

    def test_corrupt_original_onset_source_rejected_without_replaying_market(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"source.json"
            path.write_text('{"fake":"impossible profits"}')
            with self.assertRaises(ValueError):
                audit(td,path,"2026-09-03")
        self.assertEqual(len(ORIGINAL_ONSET_SHA),64)

    def test_frozen_market_days_no_holdout(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                audit(td,Path(td)/"bogus","2026-09-05")


if __name__=="__main__":
    unittest.main()
