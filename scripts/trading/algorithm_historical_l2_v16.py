#!/usr/bin/env python3
"""Offline post-prediction L2 replay from USER-SUPPLIED historical tar.gz/NDJSON.

No network requests of any kind and no bypass of the blocked v11 live quote.
Raw archive and download metadata are UNAUTHENTICATED until independently
proven. Output includes PROVISIONAL quote-crossing arithmetic, NEVER actual
trading PnL, a validated forecast, or authorization for PAPER/live orders.
"""
from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import tarfile
from urllib.parse import urlparse

from algorithm_multiday_registry_v12 import (
    canonical, sha256, strictly_decode, study_plan, read_entries
)
from algorithm_ai_research_v14 import (
    registered, source_only_signal, SIGNAL_SCHEMA
)
from algorithm_ws_buckets_v8 import build_buckets

SCHEMA="algorithm_historical_l2_provisional_v16"
ORIGIN_SCHEMA="algorithm_l2_user_archive_metadata_v16"
HORIZON_MS=300_000
MAX_SOURCE_SIGNAL_REGISTRATION_LAG_MS=15_000
MAX_ENTRY_AGE_MS=500
MAX_EXIT_AGE_MS=5_000
MAX_ARCHIVE_FILE_BYTES=6_000_000_000
MAX_JSON_LINE_BYTES=5_000_000
MAX_EVENTS=5_000_000
MAX_LEVELS_PER_SIDE=5_000
BPS=Decimal(10000)
FEE_BASE=Decimal("0.0005")
FEE_STRESS=Decimal("0.0007")
SYMBOL_PATTERN=re.compile(r"[A-Z0-9]{2,20}-USDT-SWAP\Z")
SHA_PATTERN=re.compile(r"[0-9a-f]{64}\Z")


def decimal(value,*,positive=False,allow_zero=True):
    if type(value) not in (str,int):
        raise ValueError("Price/quantity requires exact decimal or integer text")
    try:
        x=Decimal(str(value))
    except (InvalidOperation,ValueError) as exc:
        raise ValueError("Bad numeric price or quantity") from exc
    if not x.is_finite() or (positive and x<=0) or (not allow_zero and x==0) or x<0:
        raise ValueError("Nonpositive or nonfinite quote/quantity")
    return x


def millis(value):
    if type(value) is int:
        x=value
    elif isinstance(value,str) and re.fullmatch(r"[0-9]{12,15}",value):
        x=int(value)
    else:
        raise ValueError("Invalid UTC exchange millisecond timestamp")
    if not 1_500_000_000_000<=x<=2_500_000_000_000:
        raise ValueError("UTC timestamp out of reasonable research range")
    return x


def sha_file(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as inp:
        for buf in iter(lambda:inp.read(1<<20),b""):
            h.update(buf)
    return h.hexdigest()


def unpack_event(raw):
    e=strictly_decode(raw,MAX_JSON_LINE_BYTES)
    if not isinstance(e,dict) or e.get("action") not in ("snapshot","update"):
        raise ValueError("Unsupported historical L2 NDJSON event/action")
    data=e.get("data")
    if data is not None:
        if not isinstance(data,list) or len(data)!=1 or not isinstance(data[0],dict):
            raise ValueError("Unexpected nested book payload")
        e={**data[0],"action":e["action"]}
    ts=millis(e.get("ts"))
    action=e["action"]
    seq=e.get("seqId")
    prev=e.get("prevSeqId")
    if (seq is None)!=(prev is None):
        raise ValueError("Incomplete book sequence identifier pair")
    if seq is not None and (type(seq) is not int or type(prev) is not int):
        raise ValueError("Invalid book sequence integers")
    instrument=e.get("instId",e.get("symbol"))
    if instrument is not None and (not isinstance(instrument,str) or
                                   not SYMBOL_PATTERN.fullmatch(instrument)):
        raise ValueError("Invalid instrument identifier inside archive")
    sides={}
    if action=="snapshot" and not all(x in e for x in ("bids","asks")):
        raise ValueError("Snapshot must include bid and ask lists")
    for side in ("bids","asks"):
        rows=e.get(side,[])
        if not isinstance(rows,list) or len(rows)>MAX_LEVELS_PER_SIDE:
            raise ValueError("Invalid number of L2 levels")
        seen=set()
        levels=[]
        for r in rows:
            if not isinstance(r,list) or len(r)<2:
                raise ValueError("Unsupported L2 price/quantity row")
            price=decimal(r[0],positive=True)
            qty=decimal(r[1])
            if price in seen:
                raise ValueError("Duplicate price in a source frame")
            seen.add(price)
            levels.append((price,qty))
        sides[side]=levels
    if action=="update" and not sides["bids"] and not sides["asks"]:
        # Empty keepalive cannot prove an independently recent book.
        raise ValueError("Empty non-snapshot book event")
    return ts,action,seq,prev,sides,instrument


def replay_tar_gz(path,target_ms,*,expected_symbol=None):
    """One bounded tar.gz NDJSON member. First snapshot before target required.

    Returns as-of bid/ask <= target, with a following event > target proving
    coverage across the targeted time. Does not infer any actual fills.
    """
    target_ms=millis(target_ms)
    if expected_symbol is not None and not SYMBOL_PATTERN.fullmatch(expected_symbol):
        raise ValueError("Invalid expected instrument")
    path=Path(path)
    if not path.is_file() or not 0<path.stat().st_size<=MAX_ARCHIVE_FILE_BYTES:
        raise ValueError("Archive missing, empty or outside resource cap")
    bidbook,askbook={},{}
    last_ts=None
    last_book_ts=None
    first_snapshot_ts=None
    bracket_ts=None
    prior_seq=None
    saw_seq=None
    count=0
    accepted=0
    members=0
    instrument_seen=False
    with tarfile.open(path,"r|gz") as tf:
        for member in tf:
            if not member.isfile() or member.issym() or member.islnk():
                raise ValueError("Archive must contain exactly one regular NDJSON file")
            if "/" in member.name or "\\" in member.name or member.name.startswith("."):
                raise ValueError("Unsafe archive member name")
            if Path(member.name).suffix.lower() not in (".json",".jsonl",".ndjson"):
                raise ValueError("Unsupported archive member format")
            members+=1
            if members!=1:
                raise ValueError("More than one historical archive member")
            stream=tf.extractfile(member)
            if stream is None:
                raise ValueError("Cannot read archive member")
            while True:
                line=stream.readline(MAX_JSON_LINE_BYTES+1)
                if not line:
                    break
                if len(line)>MAX_JSON_LINE_BYTES or not line.strip():
                    raise ValueError("Oversized or empty NDJSON event")
                count+=1
                if count>MAX_EVENTS:
                    raise ValueError("Archive requires more than bounded event budget")
                ts,action,seq,prev,sides,inst=unpack_event(line)
                if inst is not None:
                    if expected_symbol is not None and inst!=expected_symbol:
                        raise ValueError("Archive instrument differs from frozen source")
                    instrument_seen=True
                if last_ts is not None and ts<last_ts:
                    raise ValueError("Nonmonotonic exchange event timestamps")
                last_ts=ts
                if ts>target_ms:
                    bracket_ts=ts
                    break
                if action=="snapshot":
                    bidbook,askbook={},{}
                    first_snapshot_ts=ts
                    prior_seq=seq
                    saw_seq=(seq is not None)
                else:
                    if first_snapshot_ts is None:
                        # History updates before the first full snapshot have
                        # no known book state: skip until snapshot.
                        continue
                    if (seq is not None)!=(saw_seq is True):
                        raise ValueError("Changing archive sequence availability")
                    if saw_seq:
                        if prev!=prior_seq:
                            raise ValueError("Book sequence gap in historical source")
                        prior_seq=seq
                for side,book in (("bids",bidbook),("asks",askbook)):
                    for px,qty in sides[side]:
                        if qty==0:
                            book.pop(px,None)
                        else:
                            book[px]=qty
                if first_snapshot_ts is not None:
                    accepted+=1
                    if not bidbook or not askbook:
                        raise ValueError("Empty side in historical reconstructed book")
                    best_bid=max(bidbook)
                    best_ask=min(askbook)
                    if best_bid>=best_ask:
                        raise ValueError("Crossed or locked historical top of book")
                    last_book_ts=ts
            # Intentionally stop at one event past target; do not let future
            # prices contaminate the lookahead-free as-of quote.
    if members!=1 or first_snapshot_ts is None or bracket_ts is None:
        raise ValueError("No complete snapshot or no future bracket event")
    if last_book_ts is None or target_ms-last_book_ts>MAX_EXIT_AGE_MS:
        raise ValueError("No sufficiently recent archival quote at target")
    if bracket_ts-target_ms>MAX_EXIT_AGE_MS:
        raise ValueError("Archive cannot certify target coverage within five seconds")
    return {
        "archive_target_utc_ms":target_ms,
        "snapshot_exchange_ts":first_snapshot_ts,
        "latest_book_exchange_ts":last_book_ts,
        "first_after_target_exchange_ts":bracket_ts,
        "best_bid":str(max(bidbook)),
        "best_ask":str(min(askbook)),
        "bid_qty_at_best":str(bidbook[max(bidbook)]),
        "ask_qty_at_best":str(askbook[min(askbook)]),
        "original_event_lines_scanned":count,
        "source_events_applied_since_full_snapshot":accepted,
        "sequence_counters_present":saw_seq,
        "sequence_integrity_checked_if_available":saw_seq is True,
        "archive_instrument_present_and_matching":instrument_seen,
        "archive_format_real_sample_confirmed":False,
        "is_actual_order_fill":False,
    }


def original_signal(study,candidate,day,symbol):
    study=Path(study)
    plan,plan_sha=study_plan(study)
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise ValueError("Invalid swap symbol")
    split=next((b["split"] for b in plan["calendar"] if
                b["date_utc"]==day and symbol in b["symbols"]),None)
    if split!="development":
        raise ValueError("v16 is restricted to preregistered DEVELOPMENT sources")
    candidates={p["id"]:(r,p) for r,p in registered(study)}
    if candidate not in candidates:
        raise ValueError("Candidate not preregistered")
    ledger,proposal=candidates[candidate]
    signalpath=(study/"ai-research-v14"/"source-signals"/
                f"{day}-{symbol}-{candidate}.json")
    signal_raw=signalpath.read_bytes()
    stored=strictly_decode(signal_raw)
    if (stored.get("schema")!=SIGNAL_SCHEMA or
        stored.get("proposal_id")!=candidate or
        stored.get("proposal_sha256")!=ledger["proposal_sha256"] or
        stored.get("study_plan_sha256")!=plan_sha or
        stored.get("symbol")!=symbol or
        stored.get("date_utc")!=day or
        stored.get("can_trade") is not False or
        stored.get("realized_pnl") is not None):
        raise ValueError("Invalid source-only prediction registration")
    source=next((e["observation"] for e in read_entries(study,plan,recheck_source=True)
                 if e["observation"]["date_utc"]==day and
                 e["observation"]["symbol"]==symbol and
                 e["observation"]["status"]=="SOURCE_VERIFIED_NO_OUTCOME"),None)
    if source is None:
        raise ValueError("Missing immutable verified underlying WS source")
    start=source["capture_start_utc_ms"]
    end=source["capture_end_utc_ms"]
    created=stored.get("registered_at_utc_ms")
    if (type(created) is not int or
        not end<=created<=end+MAX_SOURCE_SIGNAL_REGISTRATION_LAG_MS or
        ledger["registered_utc_ms"]>=start):
        raise ValueError("Signal not precommitted early enough for future assessment")
    original=build_buckets(source["capture_path"])
    if (original["source_manifest_sha256"]!=source["source_manifest_sha256"]
        or original["source_messages_sha256"]!=source["source_messages_sha256"]):
        raise ValueError("Underlying source hash/audit mismatch")
    rule=source_only_signal(original,proposal)
    if stored.get("source_only_result")!=rule or not rule["eligible"] or type(rule["hypothetical_direction"]) is not int:
        raise ValueError("Reconstructed source hypothesis differs or abstains")
    last=original["one_second_bins"][7]
    asof=last.get("book_end_asof_ms")
    if (type(asof) is not int or not 0<=end-asof<=MAX_ENTRY_AGE_MS):
        raise ValueError("Entry quote too stale before source decision")
    entry_bid=decimal(last["best_bid"],positive=True)
    entry_ask=decimal(last["best_ask"],positive=True)
    if entry_bid>=entry_ask:
        raise ValueError("Crossed entry quote")
    if proposal["forward_horizon_ms"]!=HORIZON_MS:
        raise ValueError("Different or retuned signal horizon")
    return stored,source,sha256(signal_raw),rule,entry_bid,entry_ask


def scenario(direction,entry_bid,entry_ask,exit_bid,exit_ask):
    if type(direction) is not int or direction not in (-1,1):
        raise ValueError("Unregistered forecast direction")
    entry=entry_ask if direction==1 else entry_bid
    exit_px=exit_bid if direction==1 else exit_ask
    ratio=exit_px/entry
    gross=BPS*(ratio-1 if direction==1 else 1-ratio)
    return {
        "direction":direction,
        "gross_crossing_quote_bps":str(gross),
        "base_five_bps_per_side_proxy_net_bps":
            str(gross-BPS*FEE_BASE*(1+ratio)),
        "stress_seven_bps_per_side_proxy_net_bps":
            str(gross-BPS*FEE_STRESS*(1+ratio)),
        "realized_pnl":None,
        "fill_prices_or_executability_verified":False,
    }


def label_provisional(study,candidate,day,symbol,archive,origin_metadata):
    signal,source,sig_hash,rule,entry_bid,entry_ask=original_signal(
        study,candidate,day,symbol)
    archive=Path(archive)
    metadata_raw=Path(origin_metadata).read_bytes()
    meta=strictly_decode(metadata_raw)
    keys={"schema","symbol","archive_sha256","download_source_url",
          "claimed_download_complete_utc_ms","exchange_origin_independently_verified"}
    if not isinstance(meta,dict) or set(meta)!=keys or meta.get("schema")!=ORIGIN_SCHEMA:
        raise ValueError("Unrecognized user archive provenance schema")
    archive_sha=sha_file(archive)
    target=source["capture_end_utc_ms"]+HORIZON_MS
    claimed=meta["claimed_download_complete_utc_ms"]
    uri=meta["download_source_url"]
    parsed=urlparse(uri) if isinstance(uri,str) else None
    if (meta["symbol"]!=symbol or meta["archive_sha256"]!=archive_sha
        or meta["exchange_origin_independently_verified"] is not False
        or type(claimed) is not int or claimed<=target
        or parsed is None or parsed.scheme!="https"
        or not parsed.netloc or parsed.username or parsed.password):
        raise ValueError("Untrusted, mismatched or pre-outcome archive declaration")
    archive_book=replay_tar_gz(archive,target,expected_symbol=symbol)
    exit_bid=decimal(archive_book["best_bid"],positive=True)
    exit_ask=decimal(archive_book["best_ask"],positive=True)
    if exit_bid>=exit_ask:
        raise ValueError("Invalid future price quote")
    arithmetic=scenario(rule["hypothetical_direction"],
                        entry_bid,entry_ask,exit_bid,exit_ask)
    return {
        "schema":SCHEMA,
        "date_utc":day,"symbol":symbol,"candidate_id":candidate,
        "source_only_signal_sha256":sig_hash,
        "source_manifest_sha256":source["source_manifest_sha256"],
        "source_messages_sha256":source["source_messages_sha256"],
        "archive_sha256":archive_sha,
        "archive_origin_metadata_sha256":sha256(metadata_raw),
        "claimed_download_complete_utc_ms":claimed,
        "archive_generation_url_declared_not_authenticated":uri,
        "fixed_horizon_ms":HORIZON_MS,
        "source_capture_end_utc_ms":source["capture_end_utc_ms"],
        "entry_quote":{"bid":str(entry_bid),"ask":str(entry_ask)},
        "future_archived_quote":archive_book,
        "hypothetical_quote_crossing_math":arithmetic,
        "provenance_status":"USER_SUPPLIED_UNAUTHENTICATED_OFFLINE_ARCHIVE",
        "is_prospective_authenticated_test":False,
        "exchange_archive_vs_local_capture_clock_skew_verified":False,
        "five_minute_horizon_is_approximate_due_to_clock_domains":True,
        "is_tradeable_realized_pnl":False,
        "counts_toward_validated_alpha":False,
        "risk_of_missing_book_updates_not_eliminated":
            not archive_book["sequence_integrity_checked_if_available"],
        "forecast_quality_only_exploratory":True,
        "requires_real_official_archive_sample_validation":True,
        "can_trade":False,"can_start_paper":False,
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",type=Path,required=True)
    p.add_argument("--candidate",required=True)
    p.add_argument("--date",required=True)
    p.add_argument("--symbol",required=True)
    p.add_argument("--archive",type=Path,required=True)
    p.add_argument("--origin-metadata",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    if args.out.exists():
        raise FileExistsError("Do not overwrite prior experimental outcome")
    result=label_provisional(args.study,args.candidate,args.date,args.symbol,
                             args.archive,args.origin_metadata)
    with args.out.open("xb") as out:
        out.write(canonical(result)+b"\n")
    print(json.dumps({
        "status":result["provenance_status"],
        "provisional_gross_bps":
            result["hypothetical_quote_crossing_math"]["gross_crossing_quote_bps"],
        "provisional_net_bps":
            result["hypothetical_quote_crossing_math"]["base_five_bps_per_side_proxy_net_bps"],
        "counts_toward_validated_alpha":False,
        "can_trade":False
    },sort_keys=True))


if __name__=="__main__":
    main()
