#!/usr/bin/env python3
"""v26 point-in-time NEWS evidence calendar for historical NEAR events.

Curated AFTER observing price outcomes: NOT a prospective news signal or
causal proof. No web calls, paid feeds, accounts, trading or PAPER actions.
The first_available_utc field is evidence and may have weaker provenance
than a primary release-time stamp; keep source reliability visible.
"""
from __future__ import annotations

import argparse
from datetime import datetime,timezone
import json
from pathlib import Path

SOURCE=Path(__file__).resolve().parents[2]/"docs/trading/ALGORITHM-NEWS-PIT-EVENTS-v26-20261031.json"
SCHEMA="algorithm_news_context_v26_events"
OUT_SCHEMA="algorithm_news_pit_context_replay_v26"


def parse_utc(value):
    if type(value) is not str or not value.endswith("Z"):
        raise ValueError("Explicit UTC date-time required")
    parsed=datetime.fromisoformat(value.replace("Z","+00:00"))
    if parsed.tzinfo!=timezone.utc:
        raise ValueError("Non-UTC timestamp")
    return parsed


def load(path=SOURCE):
    obj=json.loads(Path(path).read_text(encoding="utf-8"))
    if obj.get("schema")!=SCHEMA or obj.get("scope")!="POST_HOC_NEWS_RECONSTRUCTION_NOT_PROSPECTIVE_SIGNAL_OR_CAUSAL_PROOF":
        raise ValueError("Invalid news provenance registry")
    if len(obj.get("signals",[]))!=2:
        raise ValueError("Unexpected research signal cohort")
    ids=set()
    for item in obj["events"]:
        if item["id"] in ids:
            raise ValueError("Duplicate news source event")
        ids.add(item["id"])
        event_time=parse_utc(item["event_time_utc"])
        published=item.get("first_available_utc")
        if published is not None:
            publication=parse_utc(published)
            if publication.year!=2026 or publication.month!=9:
                raise ValueError("Event publication outside study period")
        if item.get("causal_source_verified") is not False:
            raise ValueError("Causal conclusion not authorized by evidence")
        if not item["source_url"].startswith("https://"):
            raise ValueError("Missing valid primary contextual source URL")
        if item["day"] not in ("2026-09-03","2026-09-04"):
            raise ValueError("Date excluded from study")
        if event_time.date().isoformat()!=item["day"]:
            raise ValueError("Event registry day inconsistent")
    for signal in obj["signals"]:
        parse_utc(signal["signal_utc"])
    return obj


def contexts(obj):
    outputs=[]
    for signal in obj["signals"]:
        signal_time=parse_utc(signal["signal_utc"])
        candidates=[r for r in obj["events"] if r["day"]==signal_time.date().isoformat()]
        rows=[]
        for item in candidates:
            event_time=parse_utc(item["event_time_utc"])
            availability=item.get("first_available_utc")
            if availability is None:
                classification="HINDSIGHT_ONLY_NOT_KNOWN_BY_SIGNAL"
                age_minutes=None
                time_to_event_minutes=None
            else:
                published=parse_utc(availability)
                age_minutes=round((signal_time-published).total_seconds()/60,2)
                time_to_event_minutes=round((event_time-signal_time).total_seconds()/60,2)
                if published>=signal_time:
                    classification="NOT_AVAILABLE_AT_SIGNAL"
                elif event_time>signal_time:
                    classification="PREANNOUNCED_FUTURE_SCHEDULE"
                else:
                    classification="PUBLISHED_BEFORE_SIGNAL"
            rows.append({
                "event_id":item["id"],"title":item["title"],
                "classification":classification,
                "publication_age_at_signal_minutes":age_minutes,
                "event_time_minus_signal_minutes":time_to_event_minutes,
                "source_url":item["source_url"],
                "publication_provenance":item["timestamp_type"],
                "source_reliability":item["source_reliability"],
                "causal_role_verified":False,
            })
        outputs.append({
            "signal_id":signal["id"],"signal_utc":signal["signal_utc"],
            "event_evidence":rows,
            "news_known_at_signal_only":
                [r["event_id"] for r in rows
                 if r["classification"] in ("PUBLISHED_BEFORE_SIGNAL","PREANNOUNCED_FUTURE_SCHEDULE")],
            "posthoc_market_outcomes_used_to_select_signals":True,
        })
    return {
        "schema":OUT_SCHEMA,
        "scope":"POST_HOC_NEWS_TIMELINE_TO_DEVELOP_NEW_HYPOTHESES_ONLY",
        "signals":outputs,
        "false_catalysts_excluded":obj["excluded_false_catalysts"],
        "true_out_of_sample_test":False,
        "news_causality_established":False,
        "trading_strategy_validated":False,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry",type=Path,default=SOURCE)
    parser.add_argument("--out",type=Path,required=True)
    args=parser.parse_args()
    if args.out.exists():
        raise FileExistsError("Immutable news context output must not be overwritten")
    obj=contexts(load(args.registry))
    with args.out.open("xb") as out:
        out.write((json.dumps(obj,sort_keys=True,ensure_ascii=False,indent=2)+"\n").encode("utf-8"))
    print(json.dumps({
        "status":obj["scope"],
        "signals":[{"signal_utc":s["signal_utc"],
          "pre_known":s["news_known_at_signal_only"],
          "not_valid_as_pre_signal":[r["event_id"] for r in s["event_evidence"]
                         if r["classification"] in ("NOT_AVAILABLE_AT_SIGNAL","HINDSIGHT_ONLY_NOT_KNOWN_BY_SIGNAL")]}
            for s in obj["signals"]],
        "true_out_of_sample_test":False,
        "causality_established":False,"can_trade":False,
    },sort_keys=True,ensure_ascii=False))


if __name__=="__main__":
    main()
