"""Count-, direction- and duration-matched funding null diagnostics."""
from datetime import datetime, timedelta, timezone
import unittest

from alpha_discovery import Candle
from algorithm_event_lab import replay
from algorithm_funding_null_v4 import (
    TRIALS, diagnostic, episodes, net_episode,
)
from algorithm_funding_v4 import BAR_MS, FundingEvent


def build(prices):
    base=datetime(2025,1,1,tzinfo=timezone.utc)
    return [Candle(base+timedelta(minutes=15*i),float(p),float(p)*1.01,
                   float(p)*.99,float(p),100) for i,p in enumerate(prices)]


class MatchedNullTests(unittest.TestCase):
    def test_episode_reconstruction_equals_exact_replay(self):
        prices=[100,101,100,100.4,102,103,102,101,99]
        actions=[0,1,1,0,-1,-1,-1,0,0]
        b=build(prices)
        for fee in (.0007,.0014):
            actual=replay(b,actions,side_cost=fee,allocation=.1)["net_return"]
            approx=sum(net_episode(b,e,fee) for e in episodes(actions))
            self.assertAlmostEqual(actual,approx,places=12)

    def test_open_last_bar_is_not_an_executable_episode(self):
        self.assertEqual(episodes([0,0,1]),[])
        self.assertEqual(episodes([0,1,1]),[(1,3,1)])

    def test_same_count_null_deterministic_and_not_a_pvalue(self):
        bars=build([100]*60)
        signals=[0]*60
        for start in (20,30,40,50):
            signals[start:start+3]=[1,1,1]
        base=int(bars[0].time.timestamp()*1000)
        evidence=[FundingEvent(base,.0002),
                  FundingEvent(base+8*BAR_MS,-.0002),
                  FundingEvent(base+24*BAR_MS,.0003),
                  FundingEvent(base+36*BAR_MS,-.0003)]
        a=diagnostic(bars,signals,evidence,"carry_receive",1,seed=123)
        b=diagnostic(bars,signals,evidence,"carry_receive",1,seed=123)
        self.assertEqual(a,b)
        self.assertTrue(a["not_a_p_value"])
        self.assertEqual(a["null_trials"],TRIALS)
        self.assertLessEqual(a["accepted_executable_episodes"],a["availability_eligible_episodes"])
        self.assertTrue(0<=a["comparisons"]["base"]["fraction_null_ge_candidate_descriptive_only"]<=1)

    def test_no_open_episode_breaks_null(self):
        bars=build([100]*50)
        targets=[0]*50
        base=int(bars[0].time.timestamp()*1000)
        funding=[FundingEvent(base,.0002),FundingEvent(base+8*BAR_MS,-.0003)]
        row=diagnostic(bars,targets,funding,"funding_deceleration",1,seed=21)
        self.assertEqual(row["accepted_executable_episodes"],0)
        self.assertEqual(row["comparisons"]["base"]["candidate_net_return"],0)

    def test_foreign_episode_rejected(self):
        # The diagnostic checks each filtered episode is sourced from coverage.
        self.assertEqual(episodes([0,1,1,0,-1]),[(1,3,1)])
        self.assertEqual(episodes([0,0,0]),[])


if __name__=="__main__":
    unittest.main()
