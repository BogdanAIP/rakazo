"""v24 post-outcome robustness audit tests — no trading or horizon selection."""
from decimal import Decimal as D
from pathlib import Path
import tempfile
import unittest

from algorithm_replication_robustness_v24 import (
    AUDIT_SCHEMA,FROZEN_RESULT_SHA,diagnosis,source_result_path,load_and_verify
)


class PostResultRobustnessTests(unittest.TestCase):
    def test_one_big_winner_can_flip_positive_mean_to_negative(self):
        vals=[D("-30"),D("-20"),D("-10"),D("100")]
        r=diagnosis(vals,[1,-1,-1,1])
        self.assertEqual(r["observations"],4)
        self.assertEqual(r["mean_net5_bps"],"10")
        self.assertEqual(r["mean_excluding_one_best_bps"],"-20")
        self.assertEqual(r["mean_excluding_two_best_bps"],"-25")
        self.assertEqual(r["long_count"],2)
        self.assertEqual(r["positive_net5_count"],1)
        self.assertTrue(r["post_hoc_trim_is_not_a_registered_strategy"])

    def test_unregistered_market_day_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                source_result_path(td,"2026-09-05")

    def test_original_result_sha_prevents_fabricated_positive_source(self):
        with tempfile.TemporaryDirectory() as td:
            p=source_result_path(td,"2026-09-03")
            p.parent.mkdir(parents=True)
            p.write_text('{"fake":"all profitable"}')
            with self.assertRaises(ValueError):
                load_and_verify(td,"2026-09-03")


if __name__=="__main__":
    unittest.main()
