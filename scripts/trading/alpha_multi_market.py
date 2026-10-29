#!/usr/bin/env python3
"""Offline 50+ crypto research admission and bounded v3 batch runner.

No network calls, no exchange keys, no orders and no recurrence.
Must have >=50 verified uninterrupted 90d snapshots before ANY evaluation.
"""
import argparse
import json
from pathlib import Path

from alpha_robust import MIN_BARS_V3
from run_alpha_audited import audited_run, verify_snapshot

SCHEMA = "okx_usdt_swap_universe_v1"
MIN_MARKETS = 50
MAX_BATCH = 5


def inspect(universe_file, data_dir):
    record = json.loads(Path(universe_file).read_text(encoding="utf-8"))
    if (record.get("schema") != SCHEMA or
            record.get("source") != "official_okx_public_rest" or
            not isinstance(record.get("selected"), list)):
        raise ValueError("Valid official public-market universe required")
    seen, ready, rejected = set(), [], {}
    for entry in record["selected"]:
        symbol = entry.get("symbol", "")
        if (symbol in seen or not symbol.endswith("-USDT-SWAP") or
                entry.get("history_90d_verified") is not False):
            raise ValueError("Bad or repeated research-universe instrument")
        seen.add(symbol)
        csv_path = Path(data_dir) / (symbol + ".csv")
        manifest = csv_path.with_suffix(".manifest.json")
        if not csv_path.is_file() or not manifest.is_file():
            rejected[symbol] = "MISSING_IMMUTABLE_HISTORY"
            continue
        try:
            candles, provenance, digest = verify_snapshot(csv_path, manifest)
            if len(candles) < MIN_BARS_V3:
                raise ValueError("SHORT_OF_90_DAY_MINIMUM")
            if provenance["symbol"] != symbol or provenance["source"] != "public_get":
                raise ValueError("UNVERIFIED_MARKET_PROVENANCE")
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            rejected[symbol] = str(exc)[:100]
            continue
        ready.append({"symbol": symbol, "bars": len(candles),
                      "sha256": digest, "csv": str(csv_path),
                      "manifest": str(manifest)})
    return {
        "protocol": "alpha_crypto_universe_v3",
        "universe_as_of": record.get("fetched_at_utc"),
        "eligible_market_candidates": len(record["selected"]),
        "source": "OKX_READ_ONLY_CANDIDATES",
        "historical_membership_verified": False,
        "minimum_markets": MIN_MARKETS,
        "ready_markets": len(ready),
        "status": "READY_TO_RESEARCH" if len(ready) >= MIN_MARKETS
                  else "INSUFFICIENT_HISTORY_NO_RESEARCH",
        "ready": ready,
        "missing_or_rejected": rejected,
    }


def run():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--universe", type=Path, required=True)
    cli.add_argument("--data-dir", type=Path, required=True)
    cli.add_argument("--registry", type=Path, required=True)
    cli.add_argument("--reports-dir", type=Path, required=True)
    cli.add_argument("--offset", type=int, default=0)
    cli.add_argument("--count", type=int, default=5)
    cli.add_argument("--seed", type=int, default=42)
    cli.add_argument("--check-only", action="store_true")
    args = cli.parse_args()
    result = inspect(args.universe, args.data_dir)
    summary = {key: result[key] for key in (
        "protocol", "universe_as_of", "eligible_market_candidates",
        "minimum_markets", "ready_markets", "status"
    )}
    if args.check_only or result["status"] != "READY_TO_RESEARCH":
        print(json.dumps(summary, sort_keys=True))
        return
    if args.offset < 0 or not 1 <= args.count <= MAX_BATCH:
        raise ValueError("Strictly bounded <=5 markets/run")
    batch = result["ready"][args.offset:args.offset+args.count]
    if not batch:
        raise ValueError("Batch outside verified candidate range")
    results = []
    for row in batch:
        out = args.reports_dir / (row["symbol"] + "-v3.json")
        # audited_run claims the specific immutable CSV before reading holdout.
        report = audited_run(
            row["csv"], row["manifest"], args.registry, out,
            seed=args.seed, rounds=2, allow_fixture=False, protocol="v3"
        )
        results.append({
            "symbol": row["symbol"],
            "development_gate": report["development_gate"]["status"],
            "holdout_used": report["holdout"] is not None,
            "paper_authorized": False,
        })
    print(json.dumps({"processed": len(results), "research": results}, sort_keys=True))


if __name__ == "__main__":
    run()
