#!/usr/bin/env python3
"""Development-only original L2 restoration-path experiment, bounded AST rules.

Positive/negative displayed quantity changes are observable. Maker identity,
cancellation versus execution, and true replenishment of a specific order are
NOT inferred. Historical source clocks are not network-availability clocks.
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
from pathlib import Path
from statistics import mean

import algorithm_stream_v31 as lab
from algorithm_v30_l2_replay import manifest, asof_original
from algorithm_v30_archive_acquire import digest
from algorithm_historical_l2_v16 import unpack_event
from algorithm_l2_checkpoint_v22 import heaps_from_book, current_best, apply_levels

EXTRA_FEATURES = {"restoration", "fragile_flow", "restoration_change", "book_imbalance"}
MAX_LINE = 5_000_000
MAX_ROWS = 4_000_000


def restoration_share(added, removed):
    return added/(added+removed) if added+removed else 0.5


def positive_and_negative_changes(book, best, sides):
    """At the previously best prices only; snapshots are handled separately."""
    values = [0.0]*4
    for k, side in enumerate(("bids", "asks")):
        for px, qty in sides[side]:
            if px == best[k]:
                delta = float(qty - book[side].get(px, 0))
                values[2*k] += max(0, delta)
                values[2*k+1] += max(0, -delta)
    return values


def extract(root, day, symbol):
    _, spool, _, receipt, onset_sha, _, _ = manifest(root, day, symbol)
    index_path = Path(root)/"l2"/f"{symbol}-{day}-snapshot-index-v30.json"
    idx = json.loads(index_path.read_bytes())
    if idx["original_sha256"] != receipt["original_sha256"] or idx["tape_sha256"] != onset_sha:
        raise ValueError("Original index/source identity changed")
    if idx["spool_bytes"] != spool.stat().st_size or idx["spool_sha256"] != digest(spool):
        raise ValueError("Original uncompressed source SHA mismatch")
    base = lab.source.v29.time_ms(day, 0, 0)
    windows = [(base+60*60000, base+(9*60+16)*60000),
               (base+13*60*60000, base+(15*60+1)*60000)]
    quotes, bins, total_rows = {}, {}, 0
    seq_seen = set()
    for start, end in windows:
        target_minutes = list(range(start, end+1, 60000))
        snap_i = bisect.bisect_right([s["ts"] for s in idx["snapshot_entries"]], start-60000)-1
        if snap_i < 0:
            raise ValueError("No original snapshot before feature window")
        snap = idx["snapshot_entries"][snap_i]
        book, heaps = heaps_from_book({"book": {"bids": {}, "asks": {}}})
        last_ts, seq_enabled, last_seq = None, None, None
        n = 0
        with spool.open("rb") as f:
            f.seek(snap["offset"])
            import hashlib
            if hashlib.sha256(f.readline(MAX_LINE+1)).hexdigest() != snap["line_sha256"]:
                raise ValueError("Original snapshot row changed")
            f.seek(snap["offset"])
            while n < len(target_minutes):
                line = f.readline(MAX_LINE+1)
                if not line or len(line) > MAX_LINE:
                    raise ValueError("Original book truncated")
                ts, action, seq, prev, sides, inst = unpack_event(line)
                if inst != symbol or (last_ts is not None and ts < last_ts):
                    raise ValueError("Original book instrument/time invalid")
                # Strictly prior to each decision, matching tape prints < T.
                while n < len(target_minutes) and ts > target_minutes[n]-1:
                    t = target_minutes[n]
                    quotes[t] = asof_original(book, heaps, last_ts, t-1, ts)
                    n += 1
                if n == len(target_minutes):
                    break
                bucket = ts//60000*60000+60000
                b = bins.setdefault(bucket, {"changes": [0.0]*4, "snapshot": False})
                if action == "snapshot":
                    seq_enabled, last_seq = seq is not None, seq
                    seq_seen.add(seq_enabled)
                    b["snapshot"] = True
                else:
                    if last_ts is None:
                        raise ValueError("Delta before anchor snapshot")
                    if seq_enabled and (seq is None or prev != last_seq or seq < last_seq):
                        raise ValueError("Original exchange sequence gap")
                    if not seq_enabled and seq is not None:
                        raise ValueError("Unexpected sequence introduction")
                    last_seq = seq
                    delta = positive_and_negative_changes(book, current_best(book, heaps), sides)
                    b["changes"] = [x+y for x, y in zip(b["changes"], delta)]
                apply_levels(book, heaps, sides, action)
                current_best(book, heaps)
                last_ts = ts
                total_rows += 1
                if total_rows > MAX_ROWS:
                    raise ValueError("Bounded original replay budget exceeded")
    return {"schema": "original_restoration_path_v32", "day": day, "symbol": symbol,
            "original_archive_sha": receipt["original_sha256"],
            "spool_sha": idx["spool_sha256"], "index_sha": digest(index_path),
            "source_rows": total_rows, "sequence_ids_available": seq_seen == {True},
            "quotes": quotes, "bins": bins,
            "network_availability_certified": False}


def attach(rows, book):
    quotes = {int(t): q for t, q in book["quotes"].items()}
    bins = {int(t): q for t, q in book["bins"].items()}
    previous = 0.0
    for row in rows:
        t = row["t"]
        q = quotes.get(t, {})
        p = quotes.get(t-60000, {})
        b = bins.get(t, {})
        available = (q.get("status") == p.get("status") == "AVAILABLE"
                     and "changes" in b and not b.get("snapshot", True))
        if not available:
            row["ready"] = False
            row["features"].update({k: 0.0 for k in EXTRA_FEATURES})
            row["restoration_available"] = False
            previous = 0.0
            continue
        ba, br, aa, ar = b["changes"]
        bid_share, ask_share = restoration_share(ba, br), restoration_share(aa, ar)
        restoring = bid_share-ask_share
        flow = row["features"]["flow"]
        row["features"].update({"restoration": restoring,
                                "restoration_change": restoring-previous,
                                "fragile_flow": max(0, flow)*(1-ask_share)+min(0, flow)*(1-bid_share),
                                "book_imbalance": float(q["original_top5_imbalance"])})
        row["restoration_available"] = True
        previous = restoring
    return rows, quotes


def quote_outcome(rows, quotes, alarm):
    t, d = alarm["t"], alarm["direction"]
    times = [t+(lab.DELAY+j)*60000 for j in range(lab.HORIZON+1)]
    qs = [quotes.get(x, {}) for x in times]
    if any(q.get("status") != "AVAILABLE" for q in qs):
        return {"status": "QUOTE_PATH_UNAVAILABLE"}
    entry = float(qs[0]["ask" if d > 0 else "bid"])
    threshold = alarm["barrier_bps"]
    label, gross, exit_j = "CENSORED", 0.0, lab.HORIZON
    for j, q in enumerate(qs[1:], 1):
        exit_price = float(q["bid" if d > 0 else "ask"])
        gross = d*10000*math.log(exit_price/entry)
        if abs(gross) >= threshold:
            label, exit_j = ("FAVORABLE" if gross > 0 else "ADVERSE"), j
            break
    return {"status": "QUOTED_TOP_OF_BOOK_SCENARIO", "outcome": label,
            "gross_quote_bps": gross, "after_20bp_fee_bps": gross-20,
            "exit_minutes_after_entry": exit_j, "fill_certified": False,
            "funding_and_additional_slippage": "UNAVAILABLE"}


def evaluate(root, cache_folder, definitions, proposal_sha, action_function=None):
    lab.FEATURES.update(EXTRA_FEATURES)  # fixed reviewed leaves, never arbitrary code
    results = []
    for day, symbol in lab.ORIGINALS:
        p = Path(cache_folder)/f"{symbol}-{day}-restoration-v32.json"
        book = json.loads(p.read_bytes())
        rows, _v29, hashes, scope = lab.load_case(Path(root)/"source", day, symbol)
        labels = lab.episodes(rows, scope)
        rows, quotes = attach(rows, book)
        scores = {}
        for definition in definitions:
            # An unavailable feature interval cannot silently carry prior memory.
            actions = (action_function or causal_available_actions)(definition, rows)
            s = lab.score(rows, actions, scope, labels)
            s["quoted_scenarios"] = [quote_outcome(rows, quotes, a) for a in s["records"]]
            values = [x["after_20bp_fee_bps"] for x in s["quoted_scenarios"]
                      if x["status"] == "QUOTED_TOP_OF_BOOK_SCENARIO"]
            s["quote_path_unavailable"] = len(s["records"])-len(values)
            s["mean_quote_20bp"] = mean(values) if values else None
            scores[definition["id"]] = s
        results.append({"day": day, "symbol": symbol, "source_sha": hashes,
                        "restoration_cache_sha": digest(p), "source_rows": book["source_rows"],
                        "decisions": len(scope), "available_decisions": sum(r["ready"] for r in rows if r["t"] in scope),
                        "episodes": labels, "programs": scores})
    summary = {}
    for d in definitions:
        ss = [r["programs"][d["id"]] for r in results]
        vals = [x["after_20bp_fee_bps"] for s in ss for x in s["quoted_scenarios"]
                if x["status"] == "QUOTED_TOP_OF_BOOK_SCENARIO"]
        summary[d["id"]] = {"alarms": sum(s["alarms"] for s in ss),
                             "detected_early": sum(s["detected_early"] for s in ss),
                             "episodes": sum(s["episodes"] for s in ss),
                             "missing_quote_paths": sum(s["quote_path_unavailable"] for s in ss),
                             "mean_quote_20bp": mean(vals) if vals else None,
                             "per_case_quote_20bp": [s["mean_quote_20bp"] for s in ss],
                             "screen_pass": all(s["alarms"] >= 4 and s["quote_path_unavailable"] == 0
                                                and s["mean_quote_20bp"] is not None
                                                and s["mean_quote_20bp"] > 0 for s in ss)}
    return {"schema": "restoration_v32_development", "proposal_sha": proposal_sha,
            "summary": summary, "cases": results, "independent_validation": False,
            "news_coverage": "UNKNOWN", "realized_PnL_available": False,
            "source_sequence_continuity_and_live_latency_certified": False,
            "effective_algorithm_confirmed": False}


def causal_available_actions(definition, rows):
    state = 0.0
    actions = []
    for row in rows:
        if not row.get("restoration_available"):
            state = 0.0
            actions.append(0)
            continue
        old = state
        state = lab.expression(definition["state"], row["features"], old, 0)
        v = lab.expression(definition["output"], row["features"], old, state)
        actions.append(1 if v >= definition["threshold"] else -1 if v <= -definition["threshold"] else 0)
    return actions


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--day")
    p.add_argument("--symbol")
    p.add_argument("--cache", type=Path)
    p.add_argument("--proposals", type=Path)
    a = p.parse_args()
    if a.out.exists():
        raise FileExistsError("Preserve original experiment result")
    if a.day:
        result = extract(a.root, a.day, a.symbol)
    else:
        lab.FEATURES.update(EXTRA_FEATURES)
        definitions, sha = lab.proposals(a.proposals)
        result = evaluate(a.root, a.cache, definitions, sha)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("x", encoding="utf-8") as f:
        json.dump(result, f, sort_keys=True, allow_nan=False)
    print(json.dumps({"output_sha": digest(a.out), "summary": result.get("summary"),
                      "source_rows": result.get("source_rows"),
                      "quotes": len(result.get("quotes", {}))}, allow_nan=False))


if __name__ == "__main__":
    main()
