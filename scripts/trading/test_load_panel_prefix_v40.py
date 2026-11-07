"""Does evaluation before end_ts depend on rows at or after it? Offline, synthetic, stdlib only.

load_panel(end_ts=...) truncates the numeric arrays but derives the symbol roster
(tradable_only), the OI allocation and the grid from the whole file. These tests pin
what that metadata can and cannot change: every operator except `ref` is invariant,
because cross-sectional operators, csmean (beta) and the cohort only use symbols
eligible at the bar. `ref` reads its symbol regardless of eligibility, so a contract that
is ineligible before end_ts but eligible later is visible to it only through future
metadata. No registered, promoted or search rule uses `ref` (ledger has none); the
pinned bench is not changed here.
"""
from __future__ import annotations

import csv
import random
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
from test_algorithm_bench_v40 import random_expression_v2

BARS, CUT, LATE = 600, 400, "SYN999-USDT-SWAP"


def _write(path: Path, header, rows) -> None:
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


class PrefixInvariance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        base = d / "base.csv"
        bench.synthesize(base, symbols=24, bars=BARS, seed=7)
        with open(base, newline="") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            rows = list(reader)
        c_oi = header.index("oi")
        t0 = int(rows[0][0])
        cut_ts = t0 + CUT * 3_600_000
        rng = random.Random(11)
        late, px = [], 20.0
        for t in range(BARS):
            px *= 1.0 + rng.gauss(0, 0.01)
            ts = t0 + t * 3_600_000
            late.append([ts, LATE, f"{px:.8g}", f"{px * 1.002:.8g}", f"{px * 0.998:.8g}", f"{px:.8g}",
                         "1000.0", 1 if ts >= cut_ts else 0, "", ""])
        full = []
        for row in rows + late:
            row = list(row)
            if int(row[0]) < cut_ts:
                row[c_oi] = ""  # OI first appears after the cut: has_oi differs between the two loads
            full.append(row)
        full.sort(key=lambda r: (int(r[0]), r[1]))
        _write(d / "full.csv", header, full)
        _write(d / "prefix.csv", header, [r for r in full if int(r[0]) < cut_ts])
        cls.full = bench.load_panel(d / "full.csv", tradable_only=True, end_ts=cut_ts)
        cls.prefix = bench.load_panel(d / "prefix.csv", tradable_only=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_metadata_differs_as_expected(self):
        self.assertEqual(self.full.times, self.prefix.times)
        self.assertIn(LATE, self.full.symbols)
        self.assertNotIn(LATE, self.prefix.symbols)
        self.assertFalse(any(self.full.eligible[LATE]))

    def test_non_ref_rules_are_invariant(self):
        rng = random.Random(5)
        variants = ({}, {"weighting": "inverse_vol", "vol_window": 24},
                    {"neutralize": "beta", "beta_window": 48})
        checked = 0
        while checked < 24:
            expr = random_expression_v2(rng)
            if "'ref'" in repr(expr):
                continue
            hyp = bench.validate_hypothesis({"id": f"inv-{checked}", "author": "test", "score": ["csrank", expr],
                                             "horizon_bars": rng.choice([1, 4, 8, 24]), "min_symbols": 8,
                                             **variants[checked % 3]})
            a = bench.simulate(self.full, hyp, 1, CUT - 1, [0, 10])
            b = bench.simulate(self.prefix, hyp, 1, CUT - 1, [0, 10])
            self.assertEqual(repr(a), repr(b), expr)
            checked += 1

    def test_ref_sees_future_roster(self):
        # Pinned current behaviour, not a requirement: a future bench revision that derives
        # the roster from rows before end_ts (or makes ref eligibility-aware) should flip this.
        expr = ["ref", LATE, ["field", "ret"]]
        a = bench.evaluate_expression(expr, self.full)
        b = bench.evaluate_expression(expr, self.prefix)
        s = self.prefix.symbols[0]
        self.assertTrue(any(x == x for x in a[s]))
        self.assertFalse(any(x == x for x in b[s]))


if __name__ == "__main__":
    unittest.main()
