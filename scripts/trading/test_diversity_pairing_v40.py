"""Synthetic evidence for the r3/r4 diversity-pairing review (J14); pinned code unchanged.

`diverse_top` correlates step returns by list position (`_corr` truncates both lists to
the shorter prefix). Genomes whose step series start on different decision bars are then
compared on shifted dates, so a duplicate can look uncorrelated. `j8_replay` pairs by
decision bar inside each panel and does not have this defect.
Run from scripts/trading: python -m unittest test_diversity_pairing_v40 -v
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search

DAY = 86_400_000
LATE = {"h": 7, "off": [[1, "ret120"]], "on": [[-1, "vrev5"]], "regime": "mdisp_high", "w": "equal"}
EARLY = {"h": 7, "blend": [[-1, "vrev5"]], "w": "equal"}


def _aligned(a, b):
    """Reference pairing by decision bar (fixture only)."""
    da, db = dict(zip(a["steps_t"], a["returns"])), dict(zip(b["steps_t"], b["returns"]))
    common = sorted(da.keys() & db.keys())
    return [da[t] for t in common], [db[t] for t in common]


class TestPositionalPairing(unittest.TestCase):
    def test_offset_duplicate_passes_diverse_top(self):
        signal = [1.0, 1.0, -1.0, -1.0] * 5  # decision bars 0..19
        a = {"fitness": 2.0, "sharpe": 1.0, "halves": [1.0], "steps_t": list(range(20)), "returns": signal}
        b = {"fitness": 1.0, "sharpe": 1.0, "halves": [1.0], "steps_t": list(range(1, 20)), "returns": signal[1:]}
        seen = {json.dumps({"blend": [[1, "x"]], "h": 1, "w": "equal"}, sort_keys=True): a,
                json.dumps({"blend": [[1, "y"]], "h": 1, "w": "equal"}, sort_keys=True): b}
        self.assertLess(abs(search._corr(a["returns"], b["returns"])), 0.7)  # positional: shifted dates
        self.assertAlmostEqual(search._corr(*_aligned(a, b)), 1.0)  # same bars: one signal
        self.assertEqual(len(search.diverse_top(SimpleNamespace(seen=seen), 5)), 2)  # both promoted


def _j14_walk(order, verdict):
    """J14 as clarified: retained-only references in frozen order; every required pair must be NEW."""
    kept, record = [], {}
    for c in order:
        pairs = {r: verdict(r, c) for r in kept}
        if any(v == "PENDING" for v in pairs.values()):
            return kept, record, "PENDING"  # invalid or missing receipt: stop, reconcile first
        bad = [r for r, v in pairs.items() if v != "NEW"]
        record[c] = "kept" if not bad else ("duplicate of " if pairs[bad[0]] == "NOT_NEW" else "undefined vs ") + bad[0]
        if not bad:
            kept.append(c)
    return kept, record, "DONE"


class TestJ14Walk(unittest.TestCase):
    def test_gpt_chain_keeps_a_and_c(self):
        x, y = [1.0, 1.0, -1.0, -1.0] * 4, [1.0, -1.0, 1.0, -1.0] * 4
        s = {"A": [0.8 * p + 0.6 * q for p, q in zip(x, y)], "B": x, "C": [0.8 * p - 0.6 * q for p, q in zip(x, y)]}
        verdict = lambda r, c: "NOT_NEW" if abs(search._corr(s[r], s[c])) >= 0.7 else "NEW"
        self.assertAlmostEqual(search._corr(s["A"], s["C"]), 0.28)
        kept, record, state = _j14_walk("ABC", verdict)
        self.assertEqual((kept, state), (["A", "C"], "DONE"))  # all-edges dropping would leave A only
        self.assertEqual(record["B"], "duplicate of A")

    def test_undefined_drops_and_pending_stops(self):
        kept, record, _ = _j14_walk("ABC", lambda r, c: "UNDEFINED" if c == "B" else "NEW")
        self.assertEqual((kept, record["B"]), (["A", "C"], "undefined vs A"))
        kept, _, state = _j14_walk("ABC", lambda r, c: "PENDING" if c == "C" else "NEW")
        self.assertEqual((kept, state), (["A", "B"], "PENDING"))

    def test_at_most_ten_replays_for_five(self):
        calls = []
        _j14_walk("12345", lambda r, c: calls.append((r, c)) or "NEW")
        self.assertEqual(len(calls), 10)


class TestEngineOffsets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bench-diversity-"))
        src = cls.tmp / "p.csv"
        search.synthesize_regime_daily(src, symbols=30, days=900, seed=17, plant=0.1)
        cls.panel = bench.load_panel(src)
        t0 = cls.panel.times[0]
        cls.cfg = bench.freeze_config(cls.panel, 0.25, cls.tmp / "cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                      holdout_start_ts=t0 + 675 * DAY, search_end_ts=t0 + 400 * DAY)
        cls.previous = next(k for k, v in search.LIBRARIES.items() if v is search.TERMINALS)

    @classmethod
    def tearDownClass(cls):
        search.use_library(cls.previous)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_r3_regime_genome_starts_later_and_j8_pairs_by_bar(self):
        search.use_library("r3-f1")
        ev = search.Evaluator(self.panel, self.cfg, self.tmp / "e.jsonl")
        late, early = ev.evaluate(LATE), ev.evaluate(EARLY)
        self.assertGreater(late["steps_t"][0], early["steps_t"][0])  # real engine: unequal warm-up
        self.assertEqual(late["steps_t"], early["steps_t"][len(early["steps_t"]) - len(late["steps_t"]):])
        positional, by_bar = search._corr(late["returns"], early["returns"]), search._corr(*_aligned(late, early))
        out = search.j8_replay([(self.panel, self.cfg, 2, None)], self.tmp / "j8.jsonl", EARLY, LATE,
                               "r3-f1", "r3-f1")
        self.assertAlmostEqual(out["panels"][0]["rho"], by_bar, places=12)
        self.assertGreater(abs(by_bar - positional), 0.05)  # the two pairings disagree materially


if __name__ == "__main__":
    unittest.main()
