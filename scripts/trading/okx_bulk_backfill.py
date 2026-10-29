#!/usr/bin/env python3
"""Explicitly triggered multi-instrument OKX historical backfill scheduler-free.

At most three symbols and up to two pages per symbol per invocation.
Resumable immutable snapshots and stop-everything-on-429 semantics.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from okx_backfill import backfill, MIN_SPACING_SECONDS
from okx_dataset import SYMBOL

MAX_MARKETS_PER_RUN = 3
MAX_PAGES_PER_MARKET = 2


def run_batch(universe_path, output_root, offset=0, count=1, pages=1,
              fetcher=None, sleeper=time.sleep):
    if offset < 0 or not 1 <= count <= MAX_MARKETS_PER_RUN:
        raise ValueError("Market batch must be 1..3")
    if not 1 <= pages <= MAX_PAGES_PER_MARKET:
        raise ValueError("Each market may request at most two pages")
    universe = json.loads(Path(universe_path).read_text(encoding="utf-8"))
    if (universe.get("schema") != "okx_usdt_swap_universe_v1" or
            universe.get("source") != "official_okx_public_rest" or
            not isinstance(universe.get("selected"), list)):
        raise ValueError("Official market research snapshot required")
    members = universe["selected"][offset:offset+count]
    if len(members) != count or len(set(x.get("symbol") for x in members)) != count:
        raise ValueError("Invalid or repeated universe members")
    report = []
    for index, member in enumerate(members):
        symbol = member.get("symbol")
        if not isinstance(symbol, str) or not SYMBOL.fullmatch(symbol):
            raise ValueError("Invalid symbol")
        if index:
            sleeper(MIN_SPACING_SECONDS)
        options = dict(max_new_pages=pages, sleeper=sleeper)
        if fetcher is not None:
            options["fetcher"] = fetcher
        status = backfill(Path(output_root) / symbol, symbol, **options)
        report.append(status)
        if status["status"] == "RATE_LIMITED_STOPPED_NO_RETRY":
            break
    return {
        "scope": "OFFLINE_RESEARCH_DATA_COLLECTION_ONLY",
        "markets_attempted": len(report),
        "total_new_pages": sum(x["new_pages_saved"] for x in report),
        "stopped_due_to_429": any(
            x["status"] == "RATE_LIMITED_STOPPED_NO_RETRY" for x in report
        ),
        "markets": report,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--universe", required=True, type=Path)
    parser.add_argument("--sessions-root", required=True, type=Path)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--pages-per-market", type=int, default=1)
    args = parser.parse_args()
    result = run_batch(
        args.universe, args.sessions_root, args.offset, args.count,
        args.pages_per_market
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
