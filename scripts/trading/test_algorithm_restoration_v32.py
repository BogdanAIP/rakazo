import unittest
from decimal import Decimal as D

import algorithm_restoration_v32 as r


class RestorationTests(unittest.TestCase):
    def test_quantity_changes_count_only_previously_best_price(self):
        book = {"bids": {D(99): D(10), D(98): D(500)},
                "asks": {D(101): D(20)}}
        sides = {"bids": [(D(99), D(15)), (D(98), D(900))],
                 "asks": [(D(101), D(12))]}
        self.assertEqual(r.positive_and_negative_changes(book, (D(99), D(101)), sides),
                         [5., 0., 0., 8.])
        self.assertEqual(book["bids"][D(99)], D(10))

    def test_missing_interval_resets_state_instead_of_filling_data(self):
        definition = {"state": ["add", ["previous"], ["feature", "restoration"]],
                      "output": ["current"], "threshold": 1.5}
        rows = [{"restoration_available": True, "features": {"restoration": 1}},
                {"restoration_available": True, "features": {"restoration": 1}},
                {"restoration_available": False, "features": {"restoration": 999}},
                {"restoration_available": True, "features": {"restoration": 1}}]
        self.assertEqual(r.causal_available_actions(definition, rows), [0,1,0,0])

    def test_flat_midpoint_pays_observed_spread_and_fee(self):
        qs = {k*60000: {"status": "AVAILABLE", "bid": "99.99", "ask": "100.01"}
              for k in range(1,17)}
        a = {"t": 0, "direction": 1, "barrier_bps": 100}
        o = r.quote_outcome([], qs, a)
        self.assertAlmostEqual(o["gross_quote_bps"], -2., places=5)
        self.assertAlmostEqual(o["after_20bp_fee_bps"], -22., places=5)
        a["direction"] = -1
        self.assertAlmostEqual(r.quote_outcome([], qs, a)["after_20bp_fee_bps"], -22., places=5)

    def test_incomplete_quote_path_cannot_become_profitable(self):
        qs = {60000: {"status": "AVAILABLE", "bid": "99", "ask": "101"}}
        self.assertEqual(r.quote_outcome([], qs, {"t": 0, "direction": 1,
                                                "barrier_bps": 20})["status"],
                         "QUOTE_PATH_UNAVAILABLE")

    def test_no_activity_is_neutral_not_perfect_restoration(self):
        self.assertEqual(r.restoration_share(0,0), .5)
        self.assertEqual(r.restoration_share(10,0), 1)
        self.assertEqual(r.restoration_share(0,10), 0)


if __name__ == "__main__":
    unittest.main()
