"""Intrinsic-time causal clocks, event-order semantics, and research guardrails."""
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

from alpha_discovery import Candle
from algorithm_event_lab import replay
from algorithm_intrinsic_lab import (
    DirectionalClock, GRAMMAR, PROTOCOL, decisions, development,
    protocol_hash, validate_protocol,
)


def bars(closes):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [Candle(start + timedelta(minutes=15*i), float(p), float(p)*1.001,
                   float(p)*.999, float(p), 100.0) for i,p in enumerate(closes)]


class IntrinsicEventTests(unittest.TestCase):
    def setUp(self):
        self.prices = [100]*16 + [100.9,100.6,100.9,100.6,100.9]+[100.9]*20
        self.data = bars(self.prices)

    def test_preregistration_and_bounded_parameters(self):
        self.assertEqual(len(GRAMMAR),4)
        self.assertEqual(sum(p["role"] == "candidate" for p in GRAMMAR.values()),2)
        self.assertEqual(len(protocol_hash()),64)
        validate_protocol(PROTOCOL)
        altered=copy.deepcopy(PROTOCOL)
        altered["fast_directional_change"] = altered["slow_directional_change"]
        with self.assertRaises(ValueError):
            validate_protocol(altered)

    def test_close_only_directional_change(self):
        clock=DirectionalClock(.002)
        sequence=[100,100.9,100.8,100.6,100.9,100.6]
        self.assertEqual([clock.update(p) for p in sequence],[0,1,0,-1,1,-1])

    def test_no_signal_until_slow_clock_and_ordered_evidence(self):
        a, trace, count=decisions(self.data,"recoil-recovery")
        self.assertEqual(a[:16],[0]*16)
        self.assertEqual(a[16:20],[0,0,1,1])
        self.assertEqual(count["entries"],1)
        self.assertEqual([x["bar"] for x in trace if x["kind"] == "entry"],[18])

    def test_recovery_failure_requires_three_fast_events(self):
        a,trace,count=decisions(self.data,"recovery-failure")
        self.assertEqual(a[16:21],[0,0,0,-1,-1])
        self.assertEqual(count["entries"],1)
        self.assertEqual([x["bar"] for x in trace if x["kind"] == "entry"],[19])

    def test_matched_single_event_and_slow_controls(self):
        a,_,_=decisions(self.data,"first-recoil-control")
        b,_,_=decisions(self.data,"slow-event-control")
        self.assertEqual(a[16:19],[0,-1,-1])
        self.assertEqual(b[16:19],[1,1,1])

    def test_exposure_lease_is_not_renewed(self):
        a,_,_=decisions(self.data,"recoil-recovery")
        self.assertEqual(a[18:26],[1]*8)
        self.assertEqual(a[26:], [0]*(len(a)-26))

    def test_slow_event_overrides_active_exposure(self):
        prices=[100]*16+[100.9,100.6,100.9,99.5,99.5,99.5]
        a,trace,_=decisions(bars(prices),"recoil-recovery")
        self.assertEqual(a[18:21],[1,0,0])
        self.assertTrue(any(x["kind"] == "slow_reset" and x["bar"] == 19 for x in trace))

    def test_future_mutation_does_not_change_earlier_actions(self):
        closes=[100*(1.003 if i%4 < 2 else .997) for i in range(1200)]
        old=bars(closes)
        new=list(old)
        i=700
        c=new[i]
        new[i]=Candle(c.time,c.op,c.hi*2,c.lo/2,c.cl*1.2,10000.0)
        for name in GRAMMAR:
            a,_,_=decisions(old,name)
            b,_,_=decisions(new,name)
            self.assertEqual(a[:i],b[:i])

    def test_independent_slices_do_not_read_final_holdout(self):
        class Guarded(list):
            def __getitem__(self, idx):
                if isinstance(idx,slice) and (idx.stop is None or idx.stop>960):
                    raise AssertionError("Reserved holdout accessed")
                if isinstance(idx,int) and (idx<0 or idx>=960):
                    raise AssertionError("Reserved holdout accessed")
                return super().__getitem__(idx)
        sample=Guarded(bars([100]*1200))
        result=development(sample,[])
        self.assertFalse(result["holdout_used"])
        self.assertEqual(result["reserved_range"],[960,1200])
        self.assertFalse(result["fresh_validation"])

    def test_expiry_not_zero_cost_trade_on_every_bar(self):
        a,_,_=decisions(self.data,"recoil-recovery")
        scored=replay(self.data,a)
        self.assertEqual(scored["entries"],1)
        self.assertEqual(scored["executions"],2)

    def test_adversarial_price_loss_possible(self):
        # Entry decided at index 18; price falls after the *next* open.
        prices=[100]*16+[100.9,100.6,100.9,100.9,90.0,90.0]
        sample=bars(prices)
        actions,_,_=decisions(sample,"recoil-recovery")
        self.assertEqual(actions[18],1)
        self.assertLess(replay(sample, actions)["net_return"],0)

    def test_input_invalid_and_empty_history(self):
        self.assertEqual(decisions([],"recoil-recovery")[0],[])
        bad=bars([100,100])
        bad[1]=Candle(bad[1].time,100,101,99,0,100)
        with self.assertRaises(ValueError):
            decisions(bad,"recoil-recovery")
        with self.assertRaises(ValueError):
            decisions(bars([100]),"typo")


if __name__=="__main__":
    unittest.main()
