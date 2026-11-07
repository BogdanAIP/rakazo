"""Offline tests for the J7 margin simulator. Synthetic paths only, no network."""
from __future__ import annotations

import unittest
from dataclasses import replace

import margin_sim_v40 as sim

# One decision at bar 3 (long asset 0, short asset 1), entry at bar 4's open, exit at bar 7's open.
P = sim.Params(slippage=0.0, fee=0.0005, stop_floor=0.02, stop_k=0.0, hold=3, legs_per_side=1, lookback=3)


def path(long_bars=None, funding=None, max_leverage=(20, 20)):
    """Asset 0 rises to 103 then stays flat, asset 1 falls to 97; bars given as
    {bar: (open, high, low, close)} override asset 0."""
    closes = [[100, 101, 102, 103, 103, 103, 103, 103], [100, 99, 98, 97, 97, 97, 97, 97]]
    out = {k: [[float(x) for x in c] for c in closes] for k in ("open", "high", "low", "close")}
    for t, (o, h, l, c) in (long_bars or {}).items():
        out["open"][0][t], out["high"][0][t], out["low"][0][t], out["close"][0][t] = o, h, l, c
    out["funding"] = [[0.0] * 8, [0.0] * 8]
    for t, rate in (funding or {}).items():
        out["funding"][0][t] = rate
    out["max_leverage"] = list(max_leverage)
    return out


class TestMechanics(unittest.TestCase):
    def test_same_notional_equal_pnl_until_liquidation(self):
        bars = {4: (103, 104, 102.5, 103.5), 5: (103.5, 104, 102, 102.5), 6: (102.5, 103, 102, 102.8)}
        a = sim.simulate_path(path(bars), P)
        b = sim.simulate_path(path(bars), replace(P, variant="x1_same_notional"))
        self.assertEqual((a["entries"], a["liquidations"], a["stops"]), (2, 0, 0))
        self.assertAlmostEqual(a["terminal_equity"], b["terminal_equity"], places=9)
        self.assertNotAlmostEqual(a["terminal_equity"], 1000.0, places=3)

    def test_liquidation_loses_margin_and_fee_and_beats_the_stop(self):
        st = sim.simulate_path(path({5: (103, 103, 98.0, 99)}), P)  # same bar crosses stop and liquidation
        self.assertEqual((st["liquidations"], st["stops"]), (1, 0))
        fee = 600 * 0.0005
        self.assertAlmostEqual(st["terminal_equity"], 1000 - 30 - fee - 2 * fee, places=9)  # short leg flat

    def test_stop_fills_at_a_gapped_open(self):
        st = sim.simulate_path(path({5: (100.0, 100.0, 99.9, 100)}), P)  # opens below the 100.94 stop
        self.assertEqual((st["stops"], st["liquidations"]), (1, 0))
        qty, fee = 600 / 103, 600 * 0.0005
        long = qty * (100.0 - 103) - fee - 0.0005 * qty * 100.0
        self.assertAlmostEqual(st["terminal_equity"], 1000 + long - 2 * fee, places=9)
        self.assertGreater(st["stop_loss_ratio"][0], 1.0)  # a gap costs more than planned

    def test_funding_debit_moves_liquidation(self):
        self.assertGreater(sim.liquidation_price(1, 103, 600 / 103, 24, 0.005),
                           sim.liquidation_price(1, 103, 600 / 103, 30, 0.005))
        bars = {5: (103, 103, 99.0, 100)}
        dry = sim.simulate_path(path(bars), P)
        paid = sim.simulate_path(path(bars, funding={4: 0.01}), P)  # longs pay 6 of the 30 margin
        self.assertEqual((dry["stops"], dry["liquidations"]), (1, 0))
        self.assertEqual((paid["stops"], paid["liquidations"]), (0, 1))
        self.assertAlmostEqual(paid["funding"], 6.0, places=9)

    def test_unavailable_leverage_is_skipped_not_lowered(self):
        st = sim.simulate_path(path(max_leverage=(10, 20)), P)
        self.assertEqual(st["skips"], {"leverage_unavailable": 1})
        self.assertEqual(st["entries"], 1)
        same_margin = sim.simulate_path(path(max_leverage=(10, 20)), replace(P, variant="x1_same_margin"))
        self.assertEqual(same_margin["entries"], 2)

    def test_book_and_stress_caps_bind(self):
        st = sim.simulate_path(path(), replace(P, book_cap=0.04))
        self.assertEqual((st["entries"], st["skips"]), (1, {"book_cap": 1}))
        st = sim.simulate_path(path(), replace(P, stress_cap=0.04))
        self.assertEqual((st["entries"], st["skips"]), (1, {"stress_cap": 1}))

    def test_gap_past_liquidation_at_the_exit_open_loses_only_the_margin(self):
        """GPT review 11-07: the scheduled exit must not pay out below zero (isolated margin)."""
        at_exit = sim.simulate_path(path({7: (90, 90, 90, 90)}), P)
        before = sim.simulate_path(path({6: (90, 90, 90, 90)}), P)
        fee = 600 * 0.0005
        for st in (at_exit, before):
            self.assertEqual((st["liquidations"], st["exits"]), (1, 1))
            self.assertAlmostEqual(st["terminal_equity"], 1000 - 30 - fee - 2 * fee, places=9)

    def test_zero_stake_is_skipped(self):
        st = sim.simulate_path(path(), replace(P, margin_cap=0.0))
        self.assertEqual((st["entries"], st["skips"]), (0, {"zero_stake": 2}))

    def test_wide_stop_inside_liquidation_is_refused(self):
        st = sim.simulate_path(path(), replace(P, stop_floor=0.035))  # 1.5 x 3.5% > 4.5% to liquidation
        self.assertEqual((st["entries"], st["skips"]), (0, {"liquidation_inside_buffer": 2}))


class TestScenarios(unittest.TestCase):
    SC = sim.Scenario(paths=3, assets=8, bars=24 * 20, seed=4)

    def test_planted_edge_changes_only_the_drift(self):
        self.assertEqual(sim.scenario_sha(sim.Scenario()),
                         "9b5ce69eea458829d1ca26f160d1691667cc8bafc383dfcf86a83f8f967363a1")
        a = sim.generate(self.SC)[0]
        b = sim.generate(replace(self.SC, momentum_drift_daily=0.01))[0]
        self.assertEqual(a["open"][0][:24 * 7 + 1], b["open"][0][:24 * 7 + 1])
        self.assertNotEqual(a["close"], b["close"])
        p = sim.Params(variant="lev1", hold=24)
        flat = sim.run(self.SC, p, ["lev1"])["variants"]["lev1"]["terminal_return_median"]
        edge = sim.run(replace(self.SC, momentum_drift_daily=0.01), p, ["lev1"])["variants"]["lev1"]
        self.assertGreater(edge["terminal_return_median"], flat)

    def test_paths_are_deterministic_and_shared(self):
        a, b = sim.generate(self.SC), sim.generate(self.SC)
        self.assertEqual(a, b)
        self.assertNotEqual(a, sim.generate(replace(self.SC, seed=5)))
        self.assertEqual(sim.scenario_sha(self.SC), sim.scenario_sha(replace(self.SC)))

    def test_margin_never_exceeds_the_cap(self):
        for v in ("fixed20", "adaptive20", "buffered20", "x1_same_margin"):
            p = sim.Params(variant=v, hold=4)
            for pth in sim.generate(self.SC):
                log = []
                sim.simulate_path(pth, p, log)
                self.assertTrue(log)
                for _, _, _, e, m, _ in log:
                    self.assertLessEqual(m, p.margin_cap * e + 1e-9, v)

    def test_decisions_never_read_later_bars(self):
        pth = sim.generate(self.SC)[0]
        cut = 24 * 12
        short = {k: [row[:cut] for row in v] if k != "max_leverage" else v for k, v in pth.items()}
        p = sim.Params(hold=4)
        full, part = [], []
        sim.simulate_path(pth, p, full)
        sim.simulate_path(short, p, part)
        last = cut - 1 - p.hold - 1
        self.assertEqual([x for x in full if x[0] < last], [x for x in part if x[0] < last])
        self.assertTrue(part)

    def test_report_is_deterministic(self):
        sc = replace(self.SC, paths=2)
        self.assertEqual(sim.run(sc, sim.Params(hold=4)), sim.run(sc, sim.Params(hold=4)))


if __name__ == "__main__":
    unittest.main()
