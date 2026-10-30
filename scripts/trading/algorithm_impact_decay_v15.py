#!/usr/bin/env python3
"""v15 deterministic *source-only* price-impact efficiency decay diagnostic.

Pure math on already independently SHA+sequence audited eight one-second
public WS buckets. This neither estimates alpha nor reads future quotes.
This is NOT scientifically novel: transient impact / liquidity adaptation
have existing literature; this only preregisters a particular falsifiable
crypto-source proxy, not a matched maker-order impact.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation

RULE_ID="impact_per_contract_decay_v1"


def number(v):
    try:
        x=Decimal(str(v))
    except (InvalidOperation,TypeError,ValueError) as exc:
        raise ValueError("Invalid source bucket number") from exc
    if not x.is_finite():
        raise ValueError("Nonfinite source bucket number")
    return x


def mid(row):
    a,b=row.get("best_bid"),row.get("best_ask")
    if a is None or b is None:
        return None
    bid,ask=number(a),number(b)
    if bid<=0 or ask<=bid:
        raise ValueError("Crossed, locked or nonpositive public source book")
    return (bid+ask)/2


def impact_decay_signal(source,proposal):
    """Flag slowing signed quote movement per received taker contract, no label.

    Requirement: unchanged NONZERO aggressor sign in the two 4s halves.
    Calculate 0->3 and 3->7 midpoint movements, divide by signed source
    quantity magnitude (same symbol, no cross-symbol notional comparability).
    The late movement must retain early direction but be strictly smaller
    per contract; signal hypothesizes future REVERSION after the 8s window.

    No post-hoc magnitude threshold is allowed. This feature is a noisy
    descriptive proxy, not measured individual-order transient impact.
    """
    if proposal.get("rule_id")!=RULE_ID:
        raise ValueError("Wrong preregistered signal rule")
    if source.get("one_second_bins") is None or len(source["one_second_bins"])!=8:
        raise ValueError("Requires eight already-audited source-second bins")
    rows=source["one_second_bins"]
    if any(row.get("index")!=i for i,row in enumerate(rows)):
        raise ValueError("Source-second order is changed")
    full=sum(row.get("status")=="OBSERVED_BOTH" for row in rows)
    early,late=rows[:4],rows[4:]
    early_fills=sum(row["fill_count"] for row in early)
    late_fills=sum(row["fill_count"] for row in late)
    if any(type(row["fill_count"]) is not int or row["fill_count"]<0
           or type(row["book_update_count"]) is not int
           or row["book_update_count"]<0 for row in rows):
        raise ValueError("Invalid source bucket counters")
    E=sum((number(r["buy_taker_contracts"])-number(r["sell_taker_contracts"])
           for r in early),Decimal(0))
    L=sum((number(r["buy_taker_contracts"])-number(r["sell_taker_contracts"])
           for r in late),Decimal(0))
    source_ok=(full>=6 and early_fills>=5 and late_fills>=5
               and all(rows[i]["status"]=="OBSERVED_BOTH" for i in (0,3,7))
               and rows[7]["book_update_count"]>=1)
    m0,m3,m7=[mid(rows[i]) for i in (0,3,7)]
    direction=None
    reason="SOURCE_QUALITY_ABSTAIN"
    early_impact=late_impact=None
    if source_ok:
        if E==0 or L==0 or E*L<=0:
            reason="NO_PERSISTENT_SAME_SIGN_TAKER_PRESSURE"
        elif m0 is None or m3 is None or m7 is None:
            reason="MISSING_REQUIRED_QUOTES"
        else:
            sign=1 if E>0 else -1
            early_impact=Decimal(sign)*(m3-m0)/abs(E)
            late_impact=Decimal(sign)*(m7-m3)/abs(L)
            if early_impact<=0:
                reason="NO_INITIAL_SIGNED_PRICE_RESPONSE"
            elif late_impact<0:
                reason="PRICE_ALREADY_REVERSED_WITHIN_SOURCE"
            elif late_impact>=early_impact:
                reason="NO_SIGNED_PRICE_IMPACT_DECAY"
            else:
                reason="SOURCE_ONLY_IMPACT_DECAY_EVENT"
                direction=-sign
    return {
        "rule_id":RULE_ID,
        "asof_capture_end_utc_ms":source["window_end_utc_ms"],
        "eligible":direction is not None,
        "hypothetical_direction":direction,
        "eligibility_result":reason,
        "source_qualified_bins":full,
        "early_fill_count":early_fills,
        "late_fill_count":late_fills,
        "early_net_taker_contracts":str(E),
        "late_net_taker_contracts":str(L),
        "mid_second0":str(m0) if m0 is not None else None,
        "mid_second3":str(m3) if m3 is not None else None,
        "mid_second7":str(m7) if m7 is not None else None,
        "early_signed_mid_move_per_contract":str(early_impact) if early_impact is not None else None,
        "late_signed_mid_move_per_contract":str(late_impact) if late_impact is not None else None,
        "contract_units_cross_market_comparable":False,
        "maker_absorption_or_individual_order_impact_proven":False,
        "future_quote_labels_accessed":False,
        "future_profitability":None,
        "can_trade":False,
    }
