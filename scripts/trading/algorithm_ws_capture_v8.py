#!/usr/bin/env python3
"""Explicitly-invoked <=8s OKX PUBLIC WebSocket books/trades-all collection.

One instrument and one synchronized fixed-length interval, no accounts,
orders, scheduler, looping background workers, or price outcome research.
Logical websocket JSON message payload bytes and complete UTC receive times
are captured with cryptographic provenance; each WS has its own ordering.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import re
import time

SCHEMA = "algorithm_ws_microstructure_capture_v8"
BOOK_URL = "wss://ws.okx.com:8443/ws/v5/public"
TRADE_URL = "wss://ws.okx.com:8443/ws/v5/business"
SYMBOL = re.compile(r"[A-Z0-9]{2,20}-USDT-SWAP\Z")
CHANNELS = {"book": "books", "trade": "trades-all"}
OBSERVATION_SECONDS = 8
MAX_EVENTS = 12_000
MAX_BYTES = 12_000_000
MAX_PAYLOAD = 400_000


class CaptureRejected(ValueError):
    pass


def safe_symbol(symbol):
    if not isinstance(symbol, str) or not SYMBOL.fullmatch(symbol):
        raise CaptureRejected("Only plain USDT-SWAP symbols")


def subscribe_message(source, symbol):
    safe_symbol(symbol)
    if source not in CHANNELS:
        raise CaptureRejected("Unsupported WebSocket source")
    return json.dumps({"op": "subscribe", "args": [{
        "channel": CHANNELS[source], "instId": symbol,
    }]}, separators=(",", ":"))


def parse_event(source, symbol, raw):
    if source not in CHANNELS:
        raise CaptureRejected("Unknown channel")
    if not isinstance(raw, str):
        raise CaptureRejected("Expected unmodified WebSocket text payload")
    binary = raw.encode("utf-8")
    if not 0 < len(binary) <= MAX_PAYLOAD:
        raise CaptureRejected("WebSocket payload size limit")
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise CaptureRejected("Malformed WebSocket JSON") from exc
    if not isinstance(obj, dict):
        raise CaptureRejected("Unexpected source envelope")
    if obj.get("event") in ("subscribe", "notice"):
        if obj.get("event") == "subscribe":
            arg = obj.get("arg", {})
            if arg.get("channel") != CHANNELS[source] or arg.get("instId") != symbol:
                raise CaptureRejected("Unexpected subscription acknowledgement")
        return obj, "ack" if obj["event"] == "subscribe" else "notice"
    if "event" in obj:
        raise CaptureRejected("Unexpected WS control/error")
    arg=obj.get("arg")
    if not isinstance(arg,dict) or arg.get("channel") != CHANNELS[source] or arg.get("instId") != symbol:
        raise CaptureRejected("Mixed source or instrument")
    rows=obj.get("data")
    if not isinstance(rows,list) or len(rows)==0:
        raise CaptureRejected("Empty data event")
    if source=="book":
        if obj.get("action") not in ("snapshot","update"):
            raise CaptureRejected("Missing book action")
        if len(rows)!=1:
            raise CaptureRejected("Unexpected aggregated book frame")
        return obj,obj["action"]
    if len(rows)!=1:
        raise CaptureRejected("trades-all is per-fill, not aggregated trades")
    return obj,"trade"


async def collect(symbol, *, seconds=OBSERVATION_SECONDS):
    safe_symbol(symbol)
    if seconds != OBSERVATION_SECONDS:
        raise CaptureRejected("Pilot observation duration is frozen to 8 seconds")
    try:
        from websockets.asyncio.client import connect
    except ImportError as exc:
        raise CaptureRejected("Requires installed websockets package") from exc
    events=[]
    counts={"book":0,"trade":0}
    ready={"book_ack":False,"trade_ack":False,"snapshot":False}
    connected=asyncio.Event()
    read_errors=[]
    total_bytes=0
    start_ms=end_ms=None

    async def consume(conn, source):
        nonlocal total_bytes
        try:
            async for raw in conn:
                ms=time.time_ns()//1_000_000
                mono=time.monotonic_ns()
                obj,kind=parse_event(source,symbol,raw)
                blob=raw.encode("utf-8")
                total_bytes+=len(blob)
                if total_bytes>MAX_BYTES or len(events)>=MAX_EVENTS:
                    raise CaptureRejected("Source exceeded bounded observation size")
                entry={"ordinal_source":counts[source], "source":source,
                       "kind":kind,"received_complete_utc_ms":ms,
                       "received_monotonic_ns":mono,
                       "raw_sha256":hashlib.sha256(blob).hexdigest(),
                       "raw":raw}
                counts[source]+=1
                events.append(entry)
                if kind=="ack":
                    ready[source+"_ack"]=True
                if source=="book" and kind=="snapshot":
                    ready["snapshot"]=True
                if all(ready.values()):
                    connected.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            read_errors.append(f"{source}: {type(exc).__name__}: {exc}")
            connected.set()

    async with connect(BOOK_URL,open_timeout=5,close_timeout=1,
                       max_size=MAX_PAYLOAD) as book_conn, connect(
                       TRADE_URL,open_timeout=5,close_timeout=1,
                       max_size=MAX_PAYLOAD) as trade_conn:
        await asyncio.gather(
            book_conn.send(subscribe_message("book",symbol)),
            trade_conn.send(subscribe_message("trade",symbol)))
        tasks=[asyncio.create_task(consume(book_conn,"book")),
               asyncio.create_task(consume(trade_conn,"trade"))]
        try:
            await asyncio.wait_for(connected.wait(),timeout=4)
            if read_errors or not all(ready.values()):
                raise CaptureRejected("Missing subscription ACK/snapshot: "+str(read_errors))
            # Start window only when both streams ACK and full book state exists.
            start_ms=time.time_ns()//1_000_000
            await asyncio.sleep(seconds)
            end_ms=time.time_ns()//1_000_000
            if read_errors or any(t.done() for t in tasks):
                raise CaptureRejected("Disconnected or invalid during window: "+str(read_errors))
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
    if not all(ready.values()) or start_ms is None or end_ms is None:
        raise CaptureRejected("Incomplete live source")
    return {"schema":SCHEMA,"symbol":symbol,"source_urls":{
        "book":BOOK_URL,"trade":TRADE_URL},
        "source_channels":CHANNELS,
        "book_checksum_deprecated":True,
        "trades_channel_is_per_fill":True,
        "start_utc_ms":start_ms,"end_utc_ms":end_ms,
        "observation_seconds":seconds,"observed_ack_and_snapshot":ready,
        "event_count_by_stream":counts,
        "event_count":len(events),
        "stream_trade_exchange_gapless_proven":False,
        "cross_stream_total_order_proven":False,
        "no_price_outcomes_queried":True,
        "can_trade":False,"can_start_paper":False},events


def save_capture(destination, manifest, events):
    p=Path(destination)
    if p.exists():
        raise FileExistsError("Immutable capture exists; refusing overwrite")
    if not p.parent.is_dir():
        raise FileNotFoundError("Research parent directory missing")
    p.mkdir()
    rows=[]
    for x in events:
        rows.append(json.dumps(x,sort_keys=True,separators=(",",":"),
                               ensure_ascii=False,allow_nan=False).encode("utf-8")+b"\n")
    payload=b"".join(rows)
    (p/"messages.jsonl").write_bytes(payload)
    manifest={**manifest,"messages_sha256":hashlib.sha256(payload).hexdigest(),
              "messages_bytes":len(payload)}
    (p/"manifest.json").write_bytes(
        (json.dumps(manifest,indent=2,sort_keys=True,allow_nan=False)+"\n").encode("utf-8"))
    return hashlib.sha256((p/"manifest.json").read_bytes()).hexdigest()


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--symbol",required=True)
    cli.add_argument("--out-dir",required=True,type=Path)
    args=cli.parse_args()
    safe_symbol(args.symbol)
    if args.out_dir.exists():
        raise FileExistsError("No overwriting prior raw market observation")
    manifest,events=asyncio.run(collect(args.symbol))
    sha=save_capture(args.out_dir,manifest,events)
    print(json.dumps({"symbol":args.symbol,
                      "manifest_sha256":sha,
                      "messages":len(events),
                      "range_utc_ms":[manifest["start_utc_ms"],manifest["end_utc_ms"]],
                      "can_trade":False}))


if __name__=="__main__":
    main()
