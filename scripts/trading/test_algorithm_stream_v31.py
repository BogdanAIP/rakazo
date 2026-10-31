"""Meaningful causal and outcome-boundary tests; no source downloads."""
import copy
import tempfile
import unittest
from pathlib import Path

from algorithm_stream_v31 import (
    FEATURES, barrier, digest, episodes, features_from_minutes, outcome,
    proposals, run_program, score, validate,
)


def minutes(n):
    return [{"t": (i+1)*60000, "close": 100+i/100, "buy": 10+(i%5),
             "sell": 8, "volume": 18+(i%5), "early_flow": .1,
             "late_flow": .3, "return_bps": (i%7)-3, "market_bps": .2}
            for i in range(n)]


class StreamTests(unittest.TestCase):
    def test_whitelist_rejects_instructions_and_current_state_recursion(self):
        for node in (["eval", "anything"], ["feature", "future_return"],
                     ["constant", float("nan")], ["current"]):
            with self.assertRaises(ValueError):
                validate(node)
        validate(["current"], True)

    def test_feature_and_state_prefix_invariance(self):
        m = minutes(150)
        rows = features_from_minutes(m)
        changed = copy.deepcopy(m)
        for x in changed[100:]:
            x.update(buy=100000, volume=100008, return_bps=-999, late_flow=-1)
        amended = features_from_minutes(changed)
        self.assertEqual(rows[:100], amended[:100])
        p = {"state": ["add", ["mul", ["constant", .85], ["previous"]],
                       ["feature", "surprise"]],
             "output": ["current"], "threshold": .5}
        self.assertEqual(run_program(p, rows)[:100], run_program(p, amended)[:100])

    def test_current_minute_never_changes_its_own_normalization(self):
        m = minutes(100)
        a = features_from_minutes(m)
        m[-1]["return_bps"] = 100000
        m[-1]["volume"] = 100000
        b = features_from_minutes(m)
        self.assertEqual(a[-1]["sigma"], b[-1]["sigma"])

    def test_zero_volume_is_real_abstention_not_nonfinite_input(self):
        m = minutes(100)
        for x in m:
            x.update(buy=0, sell=0, volume=0)
        rows = features_from_minutes(m)
        self.assertFalse(any(x["ready"] for x in rows))
        self.assertTrue(all(set(x["features"]) == FEATURES for x in rows))

    def test_entry_delay_and_adverse_first_even_if_later_profitable(self):
        rows = [{"t": i*60000, "close": 100., "sigma": 1., "ready": True}
                for i in range(30)]
        rows[1]["close"] = 110  # A pre-entry jump is not a captured profit.
        for x in rows[2:]:
            x["close"] = 110
        self.assertAlmostEqual(outcome(rows, 0, 1)["gross_close_proxy_bps"], 0)
        rows[2]["close"] = 109
        rows[3]["close"] = 112
        r = outcome(rows, 0, 1)
        self.assertEqual(r["outcome"], "ADVERSE")
        self.assertEqual(r["exit_i"], 2)

    def test_complete_horizon_required(self):
        rows = [{"close": 100, "sigma": 1}] * 10
        with self.assertRaises(ValueError):
            outcome(rows, 0, 1)

    def test_labels_do_not_depend_on_detector_and_late_alarm_is_not_early(self):
        rows = [{"t": i*60000, "close": 100., "sigma": 1., "ready": True}
                for i in range(50)]
        rows[3]["close"] = 101
        scope = {x["t"] for x in rows[:20]}
        labels = episodes(rows, scope)
        self.assertEqual(labels[0]["anchor"], 0)
        actions = [0]*len(rows)
        actions[2] = 1
        result = score(rows, actions, scope, labels)
        self.assertEqual(result["detected_early"], 0)
        self.assertGreater(result["missed"], 0)

    def test_cooldown_prevents_overlapping_exposures_and_charges_every_alarm(self):
        rows = [{"t": i*60000, "close": 100., "sigma": 1., "ready": True}
                for i in range(60)]
        result = score(rows, [1]*60, {i*60000 for i in range(40)}, [])
        self.assertEqual([r["t"]//60000 for r in result["records"]], [0,16,32])
        self.assertEqual(result["mean_cost_proxy_bps"]["20"], -20)

    def test_duplicate_proposal_keys_and_semantics_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/"bad.json"
            p.write_text('{"schema":"tape_memory_v31","schema":"other","programs":[]}', encoding="utf-8")
            with self.assertRaises(ValueError):
                proposals(p)


if __name__ == "__main__":
    unittest.main()
