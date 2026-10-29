"""Source-verified 50-row audit, causal readiness and duplicate batch rejection."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_microstructure_audit_v7 import assemble

BASE=1793311300000


def synthetic_batches():
    universe={"members":[{"rank":i+1,"symbol":f"S{i:02d}-USDT-SWAP"} for i in range(50)]}
    outputs=[]
    for k in range(10):
        ss=[r["symbol"] for r in universe["members"][k*5:(k+1)*5]]
        t=BASE+k*12_000
        rec=[{"kind":"time","sent_ms":t,"received_ms":t+100}]
        for j,sym in enumerate(ss):
            start=t+500+j*1500
            rec.extend([
              {"kind":"book","symbol":sym,"received_ms":start,
               "observed":{"top5_depth_imbalance":"0.25","spread_bps":"2",
                           "stale":False}},
              {"kind":"trades","symbol":sym,"received_ms":start+200,
               "observed":{"last100_taker_imbalance":"-0.4","sample_span_ms":2500,
                           "trade_count":100,"sample_at_least_ten":True,
                           "newest_trade_stale":False}},
            ])
        rec.append({"kind":"time","sent_ms":t+9000,"received_ms":t+9500})
        outputs.append(({"symbols":ss,"records":rec},f"sha{k}"))
    return universe,outputs


class AuditTests(unittest.TestCase):
    def run_audit(self,universe,outputs):
        with tempfile.TemporaryDirectory() as folder:
            with patch("algorithm_microstructure_audit_v7.frozen_universe",
                       return_value=(universe,"f"*64)):
                with patch("algorithm_microstructure_audit_v7.verify",
                           side_effect=outputs):
                    return assemble(folder,Path(folder)/"universe.json")

    def test_exact_fifty_and_no_trading(self):
        uni,batches=synthetic_batches()
        result=self.run_audit(uni,batches)
        self.assertEqual(result["counts"]["eligible"],50)
        self.assertEqual(result["counts"]["opposite_sign"],50)
        self.assertEqual(len(result["symbols"]),50)
        self.assertEqual(result["trade_sample_span_min_ms"],2500)
        self.assertFalse(result["can_trade"])
        self.assertFalse(result["independent_performance_validated"])

    def test_bad_ranking_or_out_of_order_batches_fails(self):
        uni,batches=synthetic_batches()
        bad=list(batches)
        m=dict(bad[2][0])
        m["symbols"]=list(reversed(m["symbols"]))
        bad[2]=(m,bad[2][1])
        with self.assertRaises(ValueError):
            self.run_audit(uni,bad)
        bad=list(batches)
        m=dict(bad[2][0])
        m["records"]=[dict(x) for x in m["records"]]
        m["records"][0]["sent_ms"]=BASE
        bad[2]=(m,bad[2][1])
        with self.assertRaises(ValueError):
            self.run_audit(uni,bad)


if __name__=="__main__":
    unittest.main()
