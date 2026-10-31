import csv
from datetime import datetime, timezone
from decimal import Decimal as D
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import algorithm_band_v36 as b


def geom(bid=D("99.99"),ask=D("100.01")):
    return {"bids":((bid,D(100)),(D("99.95"),D(50)),(D("99.5"),D(100))),
            "asks":((ask,D(100)),(D("100.05"),D(50)),(D("100.5"),D(100)))}


def record(bid=110,ask=50):
    return {"old_bid":"100","old_ask":"100","new_bid":str(bid),"new_ask":str(ask)}


class FixedBandTests(unittest.TestCase):
    def setUp(self):
        b.lab.FEATURES.update(b.replay.EXTRA_FEATURES|b.EXTRA_FEATURES)
        self.defs,_=b.lab.proposals(Path(__file__).resolve().parents[2]/
                                   "docs/trading/ALGORITHM-BAND-PROPOSALS-v36.json")
        self.defs={x["id"]:x for x in self.defs}

    def value(self,name,features):
        return b.lab.expression(self.defs[name]["output"],features,0,0)

    def test_band_stays_anchored_when_new_midpoint_changes(self):
        old=geom()
        new=geom(D("100.00"),D("100.02"))
        a=b.interval(old,old);c=b.interval(old,new)
        self.assertEqual(c["status"],"AVAILABLE")
        self.assertEqual(a["lower"],c["lower"])
        self.assertEqual(a["upper"],c["upper"])
        self.assertEqual(D(c["anchor_mid"]),D(100))
        self.assertEqual(D(c["old_bid"]),D(150))

    def test_outside_band_mass_cannot_change_inside_quantities(self):
        old=geom();new={**old,"bids":old["bids"][:-1]+((D("99.5"),D(999999)),)}
        a=b.interval(old,new)
        self.assertEqual(a["old_bid"],a["new_bid"])

    def test_insufficient_depth_is_not_zero_liquidity(self):
        old=geom();new={s:x[:-1] for s,x in old.items()}
        self.assertEqual(b.interval(old,new)["status"],"DEPTH_TRUNCATED")

    def test_already_crossed_band_abstains(self):
        new={"bids":((D(101),D(100)),(D(99),D(100))),
             "asks":((D("101.01"),D(100)),(D(102),D(100)))}
        self.assertEqual(b.interval(geom(),new)["status"],"PRICE_BAND_CROSSED")

    def test_geometry_copies_mutable_book_state(self):
        book={s:dict(x) for s,x in geom().items()}
        copied=b.geometry(book)
        book["bids"][D("99.99")]=D(900)
        self.assertEqual(copied["bids"][0][1],D(100))

    def test_quote_gap_never_uses_discontiguous_prior_geometry(self):
        h=b.BandHook();book={s:dict(x) for s,x in geom().items()}
        h.observe(0,book,None,{"status":"AVAILABLE"})
        h.observe(120000,book,None,{"status":"AVAILABLE"})
        self.assertEqual(h.intervals[120000]["status"],"PREVIOUS_GEOMETRY_UNAVAILABLE")

    def test_unavailable_quote_cannot_become_an_observed_band(self):
        h=b.BandHook();book={s:dict(x) for s,x in geom().items()}
        h.observe(0,book,None,{"status":"AVAILABLE"})
        h.observe(60000,book,None,{"status":"STALE"})
        h.observe(120000,book,None,{"status":"AVAILABLE"})
        self.assertEqual(h.intervals[60000]["status"],"QUOTE_UNAVAILABLE")
        self.assertEqual(h.intervals[120000]["status"],"PREVIOUS_GEOMETRY_UNAVAILABLE")

    def test_conditional_visible_execution_extrema(self):
        f=b.accounting(record(80,120),{"buy":"10","sell":"50"})
        self.assertAlmostEqual(f["bid_lower"],-1/6)
        self.assertAlmostEqual(f["bid_upper"],3/13)
        self.assertLessEqual(f["bid_lower"],f["bid_upper"])
        self.assertLessEqual(f["ask_lower"],f["ask_upper"])

    def test_contract_unit_scaling_preserves_evidence(self):
        a=b.accounting(record(),{"buy":"40","sell":"10"})
        r={k:str(D(v)*100) for k,v in record().items()}
        z=b.accounting(r,{"buy":"4000","sell":"1000"})
        self.assertEqual(a,z)

    def test_unambiguous_buy_evidence_has_positive_score(self):
        f=b.accounting(record(),{"buy":"40","sell":"10"})
        self.assertGreater(self.value("interval-accounting",f),0)

    def test_short_symmetry_reverses_direction(self):
        long=b.accounting(record(),{"buy":"40","sell":"10"})
        short=b.accounting(record(50,110),{"buy":"10","sell":"40"})
        self.assertAlmostEqual(self.value("interval-accounting",long),
                               -self.value("interval-accounting",short))

    def test_hidden_execution_ambiguity_blocks_point_estimate_alarm(self):
        f=b.accounting(record(100,60),{"buy":"30","sell":"10"})
        self.assertEqual(self.value("interval-accounting",f),0)
        self.assertGreater(self.value("all-visible-point",f),0)

    def test_execution_can_explain_displayed_ask_loss(self):
        f=b.accounting(record(110,90),{"buy":"30","sell":"10"})
        self.assertEqual(self.value("interval-accounting",f),0)
        self.assertGreater(self.value("depth-delta-only",f),0)

    def test_absent_band_flow_is_neutral(self):
        f=b.accounting(record(),{"buy":"0","sell":"0"})
        self.assertEqual(self.value("interval-accounting",f),0)

    def tape(self):
        return [(-1000,"buy",D(1),D(100)),(0,"buy",D(2),D(100)),
                (30000,"sell",D(3),D(100)),(59999,"buy",D(5),D(101)),
                (60000,"buy",D(999),D(100)),(61000,"buy",D(999),D(100))]

    def summed(self,tape):
        return b.trade_sum(tape,[x[0] for x in tape],60000,D(99),D("100.5"))

    def test_time_and_price_boundaries_use_only_required_contracts(self):
        s=self.summed(self.tape())
        self.assertEqual(s,{"status":"AVAILABLE","buy":"2","sell":"3","prints":2})

    def test_future_prints_cannot_change_features_or_availability(self):
        original=self.summed(self.tape())
        changed=self.tape()[:4]+[(60000,"sell",D(999999),D(1))]
        self.assertEqual(original,self.summed(changed))
        self.assertEqual(original,self.summed(self.tape()[:4]))

    def test_stale_trade_observations_fail_closed(self):
        t=self.tape();t[0]=(-7000,*t[0][1:])
        self.assertEqual(self.summed(t)["status"],"TRADE_SPAN_UNAVAILABLE")
        self.assertEqual(self.summed(self.tape()[:3])["status"],"TRADE_SPAN_UNAVAILABLE")

    def test_zero_alarm_is_unpowered_not_a_positive_result(self):
        self.assertEqual(b.screen({"interval-accounting":{"alarms":0}}),"INSUFFICIENT_ALARMS")

    def test_positive_candidate_requires_powered_comparators(self):
        candidate={"alarms":10,"quote_path_unavailable":0,"mean_quote_20bp":2}
        weak={"alarms":0,"quote_path_unavailable":0,"mean_quote_20bp":None}
        self.assertEqual(b.screen({"interval-accounting":candidate,"control":weak}),"CONTROL_UNPOWERED")

    def test_common_coverage_suppresses_all_program_features(self):
        book={"quotes":{0:{"status":"AVAILABLE"},60000:{"status":"AVAILABLE","original_top5_imbalance":"0"}},
              "bins":{60000:{"changes":[0,0,0,0],"snapshot":False}},
              "band_intervals":{60000:{"status":"DEPTH_TRUNCATED"}}}
        rows,_=b.attach([{"t":60000,"ready":True,"features":{"flow":1}}],book)
        self.assertFalse(rows[0]["ready"])
        self.assertFalse(rows[0]["restoration_available"])
        self.assertEqual(rows[0]["band_availability"],"DEPTH_TRUNCATED")
        self.assertTrue(all(rows[0]["features"][k]==0 for k in b.EXTRA_FEATURES))


class PriceRetentionTests(unittest.TestCase):
    def source(self,folder,price="1.25"):
        stamp=int(datetime(2026,10,1,2,tzinfo=timezone.utc).timestamp()*1000)
        stream=io.StringIO();wr=csv.writer(stream)
        wr.writerow(b.lab.source.TRADE_FIELDS)
        wr.writerow(["NEAR-USDT-SWAP","synthetic-1","buy",price,"10",stamp,"0"])
        file=folder/"synthetic.zip"
        with zipfile.ZipFile(file,"w") as z:z.writestr("synthetic.csv",stream.getvalue())
        return file

    def test_price_is_optional_and_does_not_change_contract_units(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=self.source(root)
            with patch.object(b.lab.source,"source_zip",side_effect=lambda *a,**kw:(zipfile.ZipFile(file),"synthetic.csv","fake-sha")):
                old,sha=b.lab.source.load_trades(root,"2026-10-01","NEAR-USDT-SWAP")
                new,sha2=b.lab.source.load_trades(root,"2026-10-01","NEAR-USDT-SWAP",include_price=True)
            self.assertEqual([x[:3] for x in new],old)
            self.assertEqual((sha,sha2),("fake-sha","fake-sha"))
            self.assertEqual(new[0][2:],(D(10),D("1.25")))

    def test_nonfinite_original_price_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=self.source(root,"Infinity")
            with patch.object(b.lab.source,"source_zip",side_effect=lambda *a,**kw:(zipfile.ZipFile(file),"synthetic.csv","fake-sha")):
                with self.assertRaises(ValueError):b.lab.source.load_trades(root,"2026-10-01","NEAR-USDT-SWAP",include_price=True)


if __name__ == "__main__":unittest.main()
