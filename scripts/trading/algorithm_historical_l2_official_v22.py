#!/usr/bin/env python3
"""v22 OFFLINE official OKX historical L2 .data archive replay, fixed 5m example.

This is a retrospectively observed MARKET-DATA/ARITHMETIC benchmark, not
a prediction, validated strategy, real execution, or permission to trade.
The original 2026-09-02 BTC candidate exceeded the predeclared 250MiB cap.
This separate NEAR follow-up was chosen by published archive SIZE ONLY
before any prices were read; see explicit feasibility amendment.
"""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import tarfile

from algorithm_historical_l2_v16 import (
    decimal, millis, unpack_event, scenario, sha_file
)
from algorithm_official_archive_download_v22 import URL,ARCHIVE_NAME,CAP,SCHEMA as RECEIPT_SCHEMA
from algorithm_multiday_registry_v12 import canonical,sha256,strictly_decode

SCHEMA="algorithm_historical_real_l2_fixed_benchmark_v22"
SYMBOL="NEAR-USDT-SWAP"
DATE="2026-09-02"
ENTRY_MS=1788350400000  # 2026-09-02 12:00 UTC
EXIT_MS=1788350700000   # 12:05 UTC
HORIZON_MS=300_000
MAX_TARGET_QUOTE_AGE_MS=5_000
MAX_BRACKET_AGE_MS=5_000
MAX_LINE_BYTES=1_000_000
MAX_UNCOMPRESSED_BYTES=1_000_000_000
MAX_SOURCE_EVENTS=2_000_000
REQUIRED_MEMBER="NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.data"


def validate_receipt(folder):
    folder=Path(folder)
    archive=folder/ARCHIVE_NAME
    receipt_path=folder/(ARCHIVE_NAME+".receipt.json")
    receipt_raw=receipt_path.read_bytes()
    r=strictly_decode(receipt_raw)
    expect_fields={
        "schema","source_kind","symbol","archive_date_utc","archive_name",
        "original_archive_sha256","original_bytes","download_completed_utc",
        "http_evidence","independently_cryptographically_venue_signed",
        "no_pricing_values_read","no_orders_or_live_book_calls"
    }
    if not isinstance(r,dict) or set(r)!=expect_fields:
        raise ValueError("Downloaded source receipt structure mismatch")
    http=r["http_evidence"]
    if (r["schema"]!=RECEIPT_SCHEMA
        or r["source_kind"]!="OKX_PUBLIC_OFFICIAL_HISTORICAL_ARCHIVE_NOT_REALTIME_MARKET_BOOK"
        or r["symbol"]!=SYMBOL or r["archive_date_utc"]!=DATE
        or r["archive_name"]!=ARCHIVE_NAME
        or r["independently_cryptographically_venue_signed"] is not False
        or r["no_pricing_values_read"] is not True
        or r["no_orders_or_live_book_calls"] is not True
        or not isinstance(http,dict)
        or http.get("url")!=URL or http.get("response_status")!=200
        or type(r["original_bytes"]) is not int
        or not 0<r["original_bytes"]<=CAP
        or archive.stat().st_size!=r["original_bytes"]
        or sha_file(archive)!=r["original_archive_sha256"]):
        raise ValueError("Original official archive does not match immutable receipt")
    return archive,r,sha256(receipt_raw)


def quote(book,asof_ms,target_ms,bracket_ms):
    if asof_ms is None or bracket_ms is None:
        raise ValueError("Historical data do not bracket target")
    if not 0<=target_ms-asof_ms<=MAX_TARGET_QUOTE_AGE_MS:
        raise ValueError("Historical best quote is stale or from the future")
    if not 0<bracket_ms-target_ms<=MAX_BRACKET_AGE_MS:
        raise ValueError("Historical file does not establish target coverage")
    bids,asks=book["bids"],book["asks"]
    if not bids or not asks:
        raise ValueError("Cannot replay a two-sided order book")
    best_bid=max(bids)
    best_ask=min(asks)
    if not 0<best_bid<best_ask:
        raise ValueError("Historical book is crossed/locked/invalid")
    return {
        "target_exchange_utc_ms":target_ms,
        "last_update_exchange_utc_ms":asof_ms,
        "first_event_after_target_exchange_utc_ms":bracket_ms,
        "book_quote_age_ms":target_ms-asof_ms,
        "bid":str(best_bid),
        "ask":str(best_ask),
        "bid_size_contracts":str(bids[best_bid]),
        "ask_size_contracts":str(asks[best_ask]),
        "book_does_not_ensure_market_fill":True,
    }


def replay_fixed(archive):
    archive=Path(archive)
    if archive.name!=ARCHIVE_NAME or archive.stat().st_size>CAP:
        raise ValueError("Wrong immutable source archive/size")
    book={"bids":{},"asks":{}}
    entry=None
    exit_quote=None
    snapshot_seen=False
    seq_available=None
    prior_seq=None
    asof=None
    previous_event_ts=None
    count=0
    snapshots=0
    applied=0
    bracket_entry=None
    bracket_exit=None
    with tarfile.open(archive,"r|gz") as tf:
        member=next(iter(tf),None)
        if (member is None or not member.isfile() or member.issym() or member.islnk()
            or member.name!=REQUIRED_MEMBER
            or not 0<member.size<=MAX_UNCOMPRESSED_BYTES):
            raise ValueError("Unexpected genuine OKX L2 tar member/layout")
        stream=tf.extractfile(member)
        if stream is None:
            raise ValueError("Historical member not readable")
        while True:
            line=stream.readline(MAX_LINE_BYTES+1)
            if not line:
                break
            if len(line)>MAX_LINE_BYTES or not line.strip():
                raise ValueError("Empty/oversized NDJSON row")
            count+=1
            if count>MAX_SOURCE_EVENTS:
                raise ValueError("Unbounded original historical frames")
            ts,action,seq,prev,sides,instrument=unpack_event(line)
            if instrument!=SYMBOL:
                raise ValueError("Historical row instrument does not match source receipt")
            if previous_event_ts is not None and ts<previous_event_ts:
                raise ValueError("Historical book timestamps are out of order")
            previous_event_ts=ts
            if ts>ENTRY_MS and entry is None:
                if not snapshot_seen:
                    raise ValueError("No earlier full snapshot before first target")
                bracket_entry=ts
                entry=quote(book,asof,ENTRY_MS,bracket_entry)
            if ts>EXIT_MS:
                if not snapshot_seen:
                    raise ValueError("Missing initial full snapshot")
                bracket_exit=ts
                exit_quote=quote(book,asof,EXIT_MS,bracket_exit)
                break
            if action=="snapshot":
                book={"bids":{},"asks":{}}
                snapshot_seen=True
                snapshots+=1
                prior_seq=seq
                seq_available=seq is not None
            elif not snapshot_seen:
                # No price can be inferred until a full snapshot exists.
                continue
            elif seq_available:
                if seq is None or prev!=prior_seq or seq<prior_seq:
                    raise ValueError("Source order book sequence gap")
                prior_seq=seq
            elif seq is not None:
                raise ValueError("Source sequence availability changed")
            for side in ("bids","asks"):
                for price,qty in sides[side]:
                    if qty==0:
                        book[side].pop(price,None)
                    else:
                        book[side][price]=qty
            if snapshot_seen:
                if not book["bids"] or not book["asks"] or max(book["bids"])>=min(book["asks"]):
                    raise ValueError("Corrupted historical orderbook state")
                asof=ts
                applied+=1
    if entry is None or exit_quote is None:
        raise ValueError("Official archive insufficient for both fixed targets")
    return {
        "symbol":SYMBOL,
        "date_utc":DATE,
        "feature_time_basis":"EXCHANGE_ARCHIVE_EVENT_TIMESTAMP",
        "entry":entry,
        "exit":exit_quote,
        "horizon_ms":HORIZON_MS,
        "original_member_name":REQUIRED_MEMBER,
        "archive_events_examined_through_exit_bracket":count,
        "source_events_applied":applied,
        "full_snapshots_seen_before_exit":snapshots,
        "source_seq_fields_available":seq_available is True,
        "gapless_book_updates_independently_verified":seq_available is True,
        "no_future_lookahead_at_entry_or_exit":True,
        "price_from_ohlcv_substituted":False,
    }


def benchmark(folder):
    archive,receipt,receipt_sha=validate_receipt(folder)
    historical=replay_fixed(archive)
    entry=historical["entry"]
    exit_=historical["exit"]
    entry_bid=decimal(entry["bid"],positive=True)
    entry_ask=decimal(entry["ask"],positive=True)
    exit_bid=decimal(exit_["bid"],positive=True)
    exit_ask=decimal(exit_["ask"],positive=True)
    by_direction={
        "long":scenario(1,entry_bid,entry_ask,exit_bid,exit_ask),
        "short":scenario(-1,entry_bid,entry_ask,exit_bid,exit_ask),
    }
    return {
        "schema":SCHEMA,
        "scientific_scope":"RETROSPECTIVE_MARKET_DATA_ARITHMETIC_BENCHMARK_NOT_PROSPECTIVE_FORECAST",
        "original_btc_benchmark_status":"ARCHIVE_SIZE_OVER_PREDECLARED_250_MIB_CAP",
        "benchmark_reason":"SUPPLEMENTARY_NEAR_SELECTED_BEFORE_PRICES_FROM_PUBLIC_ARCHIVE_FILE_SIZE_ONLY",
        "official_archive_url":URL,
        "archive_filename":ARCHIVE_NAME,
        "archive_original_sha256":receipt["original_archive_sha256"],
        "archive_original_bytes":receipt["original_bytes"],
        "download_receipt_sha256":receipt_sha,
        "http_source_evidence":receipt["http_evidence"],
        "venue_signed_data":False,
        "historical_orderbook":historical,
        "bid_ask_crossing_hypothetical_bps_both_directions":by_direction,
        "fee_assumptions":"5bps/side baseline, 7bps/side stress; not actual account fee",
        "funding_spread_slippage_note":"Quoted spread included; unobserved slippage/funding/lot sizes/liquidity execution not modelled",
        "realized_pnl":None,
        "prospectively_precommitted_model_signal_used":False,
        "counts_toward_validated_alpha":False,
        "successful_prediction_established":False,
        "source_archive_seq_fields_missing_means_completeness_unproven":
            not historical["source_seq_fields_available"],
        "status":"HISTORICAL_L2_REPLAY_AND_FEE_MATH_ONLY",
        "can_trade":False,"can_start_paper":False,
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-archive-dir",required=True,type=Path)
    parser.add_argument("--out",required=True,type=Path)
    a=parser.parse_args()
    if a.out.exists():
        raise FileExistsError("Benchmark output already exists: no overwrite")
    b=benchmark(a.original_archive_dir)
    with a.out.open("xb") as out:
        out.write(canonical(b)+b"\n")
    print(json.dumps({
        "status":b["status"],
        "symbol":SYMBOL,
        "archive_sha256":b["archive_original_sha256"],
        "entry":b["historical_orderbook"]["entry"],
        "exit":b["historical_orderbook"]["exit"],
        "scenario_bps":b["bid_ask_crossing_hypothetical_bps_both_directions"],
        "source_seq_fields_available":b["historical_orderbook"]["source_seq_fields_available"],
        "counts_toward_validated_alpha":False,
        "output_sha256":sha256(a.out.read_bytes()),
        "can_trade":False
    },ensure_ascii=False,sort_keys=True))


if __name__=="__main__":
    main()
