"""Forward source audit and fixed-notional scoring without executable orders."""
from decimal import Decimal
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_forward_score_v6 import calc_return, evaluate
from algorithm_forward_prices_v6 import BAR

T=1_793_300_400_000


def freeze():
    return {
        "schema":"algorithm_forward_frozen_v6",
        "_verified_sha256":"a"*64,
        "entry_candle_open_ms":T,
        "diagnostic_exit_candle_open_ms":T+BAR,
        "primary_exit_candle_open_ms":T+4*BAR,
        "side_cost_base":.0007,
        "side_cost_stress":.0014,
        "per_instrument_initial_equity_notional":.1,
        "can_submit_orders":False,
        "can_start_paper":False,
        "candidates":[{
            "rank":i+1,
            "symbol":f"T{i:02d}-USDT-SWAP",
            "source_label":"CO_MOVEMENT" if i<5 else "ABSTAIN_NO_JOINT_CHANGE",
            "primary_direction_for_research_only":1 if i<5 else None,
            "primary_included":i<5,
        } for i in range(50)],
    }


class OutcomeTests(unittest.TestCase):
    def test_net_costs_and_short_notional(self):
        result=calc_return("100","102",1,.0007)
        self.assertEqual(Decimal(result["gross_equity_fraction"]),Decimal("0.002"))
        self.assertAlmostEqual(float(result["net_equity_fraction"]),.0018586,places=9)
        self.assertLess(Decimal(calc_return("100","102",-1,.0007)["net_equity_fraction"]),0)
        with self.assertRaises(ValueError):
            calc_return("0","102",1,.0007)
        with self.assertRaises(ValueError):
            calc_return("100","102",0,.0007)

    def test_full_fifty_with_only_five_primary_entries(self):
        f=freeze()
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            replies=[]
            for k in range(1,11):
                folder=root/f"forward-v6-prices-20261029-batch{k:02d}"
                folder.mkdir()
                slots=[{"request_sent_ms":T+10*BAR+k*100000,
                        "received_complete_ms":T+10*BAR+k*100000+1000}]
                for i in range(5):
                    j=(k-1)*5+i
                    filename=f"candle-{j}.json"
                    (folder/filename).write_bytes(b'{"fake_test_candle":true}')
                    slots.append({"kind":"candles","symbol":f["candidates"][j]["symbol"],
                                  "raw_file":filename,
                                  "request_sent_ms":T+10*BAR+k*100000,
                                  "received_complete_ms":T+10*BAR+k*100000+1000})
                slots.append({"received_complete_ms":T+10*BAR+k*100000+3000})
                replies.append(({"records":slots},f"sha{k}"))
            data={
                T:{"open":"100","confirm":"1"},
                T+BAR:{"open":"101","confirm":"1"},
                T+4*BAR:{"open":"102","confirm":"1"},
            }
            with patch("algorithm_forward_score_v6.verify_batch",side_effect=replies):
                with patch("algorithm_forward_score_v6.validate_candles",return_value=data):
                    out=evaluate(f,root)
        self.assertEqual(out["summary"]["qualifying_events"],5)
        self.assertEqual(out["summary"]["abstaining_markets"],45)
        self.assertEqual(len(out["markets"]),50)
        self.assertIsNone(out["markets"][-1]["primary_return"])
        self.assertGreater(Decimal(out["summary"]["modeled_fixed_notional_equity_fraction_base_sum"]),0)
        self.assertLess(Decimal(out["summary"]["modeled_fixed_notional_equity_fraction_stress_sum"]),
                        Decimal(out["summary"]["modeled_fixed_notional_equity_fraction_base_sum"]))
        self.assertEqual(out["decision"],"INSUFFICIENT_INDEPENDENT_EVIDENCE")
        self.assertIsNone(out["inferential_p_value"])
        self.assertFalse(out["can_submit_orders"])

    def test_forbidden_changes_fail(self):
        bad=freeze()
        bad["can_start_paper"]=True
        with self.assertRaises(ValueError):
            evaluate(bad,".")
        bad=freeze()
        bad["primary_exit_candle_open_ms"]+=BAR
        with self.assertRaises(ValueError):
            evaluate(bad,".")


if __name__=="__main__":
    unittest.main()
