"""v7 freeze integrity, aligned abstention and nontrading price scoring."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_microstructure_forward_v7 import (
    read_lock, adapted, fractional_proxy, evaluate, LOCKED_ROOT
)
from algorithm_forward_prices_v6 import BAR

T=1793313000000


def locked():
    return {
        "schema":"algorithm_microstructure_forward_lock_v7",
        "market_count":50,"qualifying_count":26,
        "independent_test":False,
        "can_start_paper":False,"can_submit_orders":False,
        "trades_sample_last100_not_fixed_interval":True,
        "entry_open_utc_ms":T,
        "primary_exit_open_utc_ms":T+4*BAR,
        "diagnostic_exit_open_utc_ms":T+BAR,
        "earliest_outcome_read_utc_ms":T+5*BAR,
        "per_included_initial_equity_notional":"0.01923076923076923076923076923",
        "cost_per_side_base":"0.0007",
        "cost_per_side_stress":"0.0014",
        "candidates":[{
            "rank":i+1,"symbol":f"M{i:02d}-USDT-SWAP",
            "observed_relation":"opposite_sign" if i<26 else "aligned_sign",
            "primary_hypothetical_direction":1 if i<26 else None,
            "include_in_primary":i<26
        } for i in range(50)],
    }


class V7ForwardTests(unittest.TestCase):
    def test_exact_sha_and_no_trading(self):
        f=locked()
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"lock.json"
            p.write_bytes(json.dumps(f).encode())
            sha=hashlib.sha256(p.read_bytes()).hexdigest()
            output=read_lock(p,sha)
            self.assertEqual(output["qualifying_count"],26)
            mapped=adapted(output,sha)
            self.assertEqual(mapped["earliest_primary_outcome_collection_ms"],T+5*BAR)
            with self.assertRaises(ValueError):
                read_lock(p,"a"*64)
            f["candidates"][27]["primary_hypothetical_direction"]=1
            p.write_bytes(json.dumps(f).encode())
            with self.assertRaises(ValueError):
                read_lock(p,hashlib.sha256(p.read_bytes()).hexdigest())

    def test_exact_fixed_notional_costs_and_not_a_fill(self):
        w=__import__("decimal").Decimal("0.5")/__import__("decimal").Decimal(26)
        x=fractional_proxy("100","102",1,w,"0.0007")
        self.assertGreater(float(x["net_fraction"]),0)
        self.assertLess(float(x["net_fraction"]),float(x["gross_fraction"]))
        self.assertLess(float(fractional_proxy("100","102",-1,w,"0.0007")["net_fraction"]),0)
        with self.assertRaises(ValueError):
            fractional_proxy("100","102",0,w,"0.0007")

    def test_full_50_outcomes_have_24_abstentions(self):
        f=locked()
        self.assertEqual(f["qualifying_count"],26)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            batches=[]
            bars={T:{"open":"100","confirm":"1"},
                  T+BAR:{"open":"100.5","confirm":"1"},
                  T+4*BAR:{"open":"102","confirm":"1"}}
            for k in range(1,11):
                p=root/f"{LOCKED_ROOT}{k:02d}"
                p.mkdir()
                records=[{"request_sent_ms":T+6*BAR+k*30_000,
                          "received_complete_ms":T+6*BAR+k*30_000+100}]
                for j in range(5):
                    sym=f["candidates"][(k-1)*5+j]["symbol"]
                    raw=f"candles-{k}-{j}.json"
                    (p/raw).write_text("{}")
                    records.append({"symbol":sym,"kind":"candles","raw_file":raw,
                                    "received_complete_ms":T+6*BAR+k*30_000+100})
                records.append({"received_complete_ms":T+6*BAR+k*30_000+500})
                batches.append(({"records":records},f"manifest{k}"))
            with patch("algorithm_microstructure_forward_v7.verify_batch",side_effect=batches):
                with patch("algorithm_microstructure_forward_v7.validate_candles",
                           return_value=bars):
                    result=evaluate(f,"a"*64,root)
        self.assertEqual(result["summary"]["eligible_positions"],26)
        self.assertEqual(result["summary"]["abstain"],24)
        self.assertEqual(len(result["all_markets"]),50)
        self.assertIsNone(result["all_markets"][-1]["primary_position_hypothetical"])
        self.assertFalse(result["can_trade"])
        self.assertFalse(result["independent_performance_validated"])
        self.assertEqual(result["decision"],"INSUFFICIENT_INDEPENDENT_EVIDENCE")


if __name__=="__main__":
    unittest.main()
