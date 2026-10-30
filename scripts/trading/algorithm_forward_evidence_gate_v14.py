#!/usr/bin/env python3
"""Offline evidence quality gate for external future OKX quotes (NO WEB REQUESTS).

Local SHA256 plus plausible timestamps do not authenticate an exchange quote.
Consequently this gate NEVER releases a future label, PnL, PAPER, order or
execution claim. No bypass of previously blocked live source collection.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

from algorithm_multiday_registry_v12 import strictly_decode, sha256
from algorithm_microstructure_capture_v7 import analyze_book, book_url
from algorithm_ai_research_v14 import registered

SCHEMA="algorithm_external_forward_quote_candidate_v14"
RESULT_SCHEMA="algorithm_quote_authenticity_gate_v14"
MAX_AGE_MS=5000
MAX_RESPONSE_WINDOW_MS=30_000


def inspect_candidate(study,candidate_id,source_end_ms,folder):
    found={x["id"]:x for _,x in registered(study)}
    if candidate_id not in found:
        raise ValueError("Hypothesis must be committed before evidence inspection")
    p=found[candidate_id]
    if type(source_end_ms) is not int or source_end_ms<=0:
        raise ValueError("Invalid source end receipt")
    folder=Path(folder)
    metadata=strictly_decode((folder/"manifest.json").read_bytes())
    raw=(folder/"raw.json").read_bytes()
    if not 0<len(raw)<=100_000:
        raise ValueError("Invalid raw response length")
    keys={"schema","symbol","source_end_utc_ms","request_sent_utc_ms",
          "response_complete_utc_ms","raw_sha256","request_url",
          "network_origin_attestation"}
    if not isinstance(metadata,dict) or set(metadata)!=keys:
        raise ValueError("Unrecognized external evidence schema")
    if metadata["schema"]!=SCHEMA or metadata["network_origin_attestation"] is not None:
        raise ValueError("Cannot self-declare a trusted exchange attestation")
    if metadata["symbol"] not in ("BTC-USDT-SWAP","SOL-USDT-SWAP"):
        # This is just a narrow illustrative verifier for two independently
        # known markets, not an arbitrary replacement source.
        raise ValueError("Unsupported external quote instrument")
    if (metadata["request_url"]!=book_url(metadata["symbol"])
        or metadata["source_end_utc_ms"]!=source_end_ms
        or metadata["raw_sha256"]!=sha256(raw)):
        raise ValueError("External quote evidence not bound to declared source")
    start=source_end_ms+p["forward_horizon_ms"]
    sent=metadata["request_sent_utc_ms"]
    received=metadata["response_complete_utc_ms"]
    if (type(sent) is not int or type(received) is not int
        or not start<=sent<=received<=start+MAX_RESPONSE_WINDOW_MS):
        raise ValueError("Quote request/receipt violates frozen horizon")
    book=analyze_book(raw,received)
    generation=book["exchange_generation_ms"]
    if not start<=generation<=received+1000 or not 0<=received-generation<=MAX_AGE_MS:
        raise ValueError("Book generation is stale/future or before horizon")
    if book["stale"]:
        raise ValueError("Stale book source")
    return {
        "schema":RESULT_SCHEMA,"candidate_id":candidate_id,
        "external_manifest_sha256":sha256((folder/"manifest.json").read_bytes()),
        "original_payload_sha256":sha256(raw),
        "book_schema_and_timestamps_plausible":True,
        "original_exchange_origin_independently_verified":False,
        "cryptographic_exchange_signature_verified":False,
        "source_usable_for_future_labels":False,
        "future_price_label":None,
        "pnl_calculation_authorized":False,
        "real_bid_ask_fills_verified":False,
        "status":"UNVERIFIED_EXTERNAL_QUOTE_ORIGIN_DO_NOT_SCORE",
        "no_network_calls_made":True,
        "can_trade":False,"can_start_paper":False
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--study",type=Path,required=True)
    p.add_argument("--candidate-id",required=True)
    p.add_argument("--source-end-ms",type=int,required=True)
    p.add_argument("--external-folder",required=True,type=Path)
    args=p.parse_args()
    print(json.dumps(inspect_candidate(args.study,args.candidate_id,
                                       args.source_end_ms,args.external_folder),
                     sort_keys=True,allow_nan=False))


if __name__=="__main__":
    main()
