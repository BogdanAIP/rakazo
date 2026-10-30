"""v15 preregistered signed impact decay: pure source, no outcome or trading."""
from decimal import Decimal
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

from algorithm_impact_decay_v15 import impact_decay_signal, RULE_ID
from algorithm_ai_research_v14 import check_proposal, source_only_signal,propose,registered,overview
from test_algorithm_ai_research_v14 import candidate,OCT30
from test_algorithm_manual_runner_v13 import init


def rows(*,flow="buy",late_flow="buy",flat_late=False,reverse_late=False,
         early_response=True,first_half_only=False,late_missing=False):
    base=Decimal("100")
    source=[]
    for i in range(8):
        early=i<4
        if first_half_only and not early:
            buy,sell="2","2"
        elif (flow if early else late_flow)=="buy":
            buy,sell="4","1"
        else:
            buy,sell="1","4"
        if i<=3:
            mid=base+(Decimal(i)*Decimal("0.2") if early_response else Decimal(0))
        else:
            diff=Decimal(0) if flat_late else (Decimal("-0.2") if reverse_late else Decimal("0.025"))
            mid=base+Decimal("0.6")+Decimal(i-3)*diff
        bid=mid-Decimal("0.05")
        ask=mid+Decimal("0.05")
        source.append({
            "index":i,"status":"OBSERVED_BOTH","fill_count":4,"book_update_count":1,
            "buy_taker_contracts":buy,"sell_taker_contracts":sell,
            "best_bid":str(bid),"best_ask":str(ask)
        })
    if late_missing:
        source[7]["status"]="ABSTAIN_INCOMPLETE_SECOND"
        source[7]["book_update_count"]=0
        source[7]["best_bid"]=None
        source[7]["best_ask"]=None
    return {
        "schema":"algorithm_ws_microstructure_seconds_v8",
        "one_second_bins":source,
        "window_end_utc_ms":OCT30+10_000,
        "can_trade":False
    }


def impact_proposal():
    p=candidate()
    p.update({
        "id":"impact-decay-check-20261030",
        "title":"Signed per-contract price impact deceleration",
        "rule_id":RULE_ID,
        "mechanism":"Price moves with repeated signed taker flow early, but later moves less per received contract.",
        "signal_definition":"With E*L>0 and signed mid quote progress early positive, require late signed movement nonnegative and its amount per taker contract smaller; then forecast against flow.",
        "prior_hypotheses_comparison":"Unlike v14 flow-flip, this requires same-sign taker pressure in both halves and compares per-contract price impact rather than absolute imbalance.",
    })
    return p


class ImpactDecaySourceTests(unittest.TestCase):
    def test_source_only_decay_triggers_sell_for_buy_flow(self):
        p=impact_proposal()
        self.assertEqual(check_proposal(p),p)
        x=source_only_signal(rows(),p)
        self.assertTrue(x["eligible"])
        self.assertEqual(x["hypothetical_direction"],-1)
        self.assertEqual(x["eligibility_result"],"SOURCE_ONLY_IMPACT_DECAY_EVENT")
        self.assertGreater(Decimal(x["early_signed_mid_move_per_contract"]),Decimal(x["late_signed_mid_move_per_contract"]))
        self.assertFalse(x["maker_absorption_or_individual_order_impact_proven"])
        self.assertIsNone(x["future_profitability"])
        self.assertFalse(x["can_trade"])

    def test_symmetric_sell_taker_pressure_hypothesizes_buy(self):
        x=rows(flow="sell",late_flow="sell")
        for r in x["one_second_bins"]:
            bid=Decimal(r["best_bid"])
            ask=Decimal(r["best_ask"])
            r["best_bid"]=str(Decimal(200)-ask)
            r["best_ask"]=str(Decimal(200)-bid)
        r=impact_decay_signal(x,impact_proposal())
        self.assertTrue(r["eligible"])
        self.assertEqual(r["hypothetical_direction"],1)

    def test_no_decaying_quote_impact_abstains(self):
        x=rows()
        for i in range(4,8):
            r=x["one_second_bins"][i]
            midpoint=Decimal("100.6")+Decimal(i-3)*Decimal("0.5")
            r["best_bid"]=str(midpoint-Decimal("0.05"))
            r["best_ask"]=str(midpoint+Decimal("0.05"))
        r=impact_decay_signal(x,impact_proposal())
        self.assertEqual(r["eligibility_result"],"NO_SIGNED_PRICE_IMPACT_DECAY")
        self.assertFalse(r["eligible"])

    def test_no_persistent_aggression_or_already_reversed_abstains(self):
        a=impact_decay_signal(rows(late_flow="sell"),impact_proposal())
        self.assertEqual(a["eligibility_result"],"NO_PERSISTENT_SAME_SIGN_TAKER_PRESSURE")
        b=impact_decay_signal(rows(reverse_late=True),impact_proposal())
        self.assertEqual(b["eligibility_result"],"PRICE_ALREADY_REVERSED_WITHIN_SOURCE")
        c=impact_decay_signal(rows(early_response=False),impact_proposal())
        self.assertEqual(c["eligibility_result"],"NO_INITIAL_SIGNED_PRICE_RESPONSE")

    def test_incomplete_quote_and_wrong_order_fail_closed(self):
        x=impact_decay_signal(rows(late_missing=True),impact_proposal())
        self.assertFalse(x["eligible"])
        self.assertEqual(x["eligibility_result"],"SOURCE_QUALITY_ABSTAIN")
        src=rows()
        src["one_second_bins"][1]["index"]=99
        with self.assertRaises(ValueError):
            impact_decay_signal(src,impact_proposal())
        src=rows()
        src["one_second_bins"][3]["best_bid"]="999"
        with self.assertRaises(ValueError):
            impact_decay_signal(src,impact_proposal())

    def test_pre_registered_two_distinct_source_rule_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            study=init(tmp)
            first=Path(tmp)/"first.json"
            first.write_text(json.dumps(candidate()))
            second=Path(tmp)/"second.json"
            second.write_text(json.dumps(impact_proposal()))
            propose(study,first,now=OCT30+100)
            propose(study,second,now=OCT30+200)
            self.assertEqual(len(registered(study)),2)
            o=overview(study)
            self.assertEqual(o["proposals_registered"],2)
            self.assertEqual(o["future_quote_labels_verified"],0)
            self.assertEqual(o["validated_profitability_models"],0)
            self.assertFalse(o["can_trade"])


if __name__=="__main__":
    unittest.main()
