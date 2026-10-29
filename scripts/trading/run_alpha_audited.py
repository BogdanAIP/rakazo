#!/usr/bin/env python3
"""One-use holdout evaluator for immutable Alpha Discovery snapshots.

A registry claim is created before evaluation and never silently reclaimed.
No execution permission, account keys, scheduler, or exchange access.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path

from alpha_discovery import discover, load_csv
from okx_dataset import INTERVAL_MS, SYMBOL


def verify_snapshot(csv_path: Path, manifest_path: Path, allow_fixture=False):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "okx_public_15m_research_v1":
        raise ValueError("Unsupported snapshot format")
    if manifest.get("source") not in ("public_get", "offline_fixture"):
        raise ValueError("Invalid source")
    if manifest["source"] == "offline_fixture" and not allow_fixture:
        raise ValueError("Synthetic fixtures require explicit --allow-fixture")
    if not SYMBOL.fullmatch(manifest.get("symbol", "")):
        raise ValueError("Not a validated USDT perpetual symbol")
    digest = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    if digest != manifest.get("csv_sha256"):
        raise ValueError("CSV hash does not match manifest")
    bars, verified = load_csv(csv_path)
    if verified != digest or len(bars) != manifest.get("closed_bars"):
        raise ValueError("Snapshot coverage mismatch")
    first = int(bars[0].time.timestamp() * 1000)
    last = int(bars[-1].time.timestamp() * 1000)
    if (first != manifest.get("first_open_ms")
            or last != manifest.get("last_open_ms")):
        raise ValueError("Snapshot temporal bounds mismatch")
    as_of = datetime.fromisoformat(manifest["captured_as_of_utc"])
    if as_of.tzinfo is None or as_of.utcoffset() != timedelta(0):
        raise ValueError("Invalid capture UTC timestamp")
    if last + INTERVAL_MS > int(as_of.timestamp() * 1000):
        raise ValueError("Unclosed last bar")
    with csv_path.open(encoding="utf-8-sig") as f:
        header = f.readline()
        # The immutable SHA verifies remaining rows; reject mixed symbols explicitly.
        for row in __import__("csv").DictReader(f, fieldnames=header.strip().split(",")):
            if row["symbol"] != manifest["symbol"]:
                raise ValueError("Mixed symbols")
    return bars, manifest, digest


def audited_run(csv_path, manifest_path, registry_dir, out, seed=42,
                rounds=3, allow_fixture=False, protocol="v1"):
    bars, manifest, digest = verify_snapshot(
        Path(csv_path), Path(manifest_path), allow_fixture=allow_fixture
    )
    if protocol not in ("v1", "v2"):
        raise ValueError("Unsupported research protocol")
    if protocol == "v2" and len(bars) < 2880:
        raise ValueError("V2 requires >=2880 verified closed bars")
    registry_dir, out = Path(registry_dir), Path(out)
    if out.exists() or out.resolve() == Path(csv_path).resolve():
        raise FileExistsError("Output already exists")
    registry_dir.mkdir(parents=True, exist_ok=True)
    claim_path = registry_dir / (digest + ".claim.json")
    claim = {
        "data_sha256": digest,
        "protocol": "alpha-discovery-" + protocol,
        "note": "Single-use holdout claim. If failed, investigate; do not unlock and retest.",
        "strategy_seed": seed,
        "search_rounds": rounds,
        "source": manifest["source"],
    }
    # Creation is atomic on local NTFS; only the first research run gets this holdout.
    with claim_path.open("x", encoding="utf-8") as f:
        json.dump(claim, f, indent=2, sort_keys=True)
        f.write("\n")
    if protocol == "v2":
        from alpha_walkforward import walk_forward
        result = walk_forward(bars, seed=seed, rounds=rounds)
    else:
        result = discover(bars, seed=seed, rounds=rounds)
    result["audited_snapshot"] = {
        "source": manifest["source"], "sha256": digest,
        "claim_path": str(claim_path),
        "holdout_reuse_allowed": False,
        "exchange_origin_cryptographically_attested": False,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x", encoding="utf-8") as f:
        json.dump(result, f, indent=2, sort_keys=True)
        f.write("\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--allow-fixture", action="store_true")
    parser.add_argument("--protocol", choices=("v1", "v2"), default="v2")
    args = parser.parse_args()
    result = audited_run(args.csv, args.manifest, args.registry, args.out,
                         args.seed, args.rounds, args.allow_fixture, args.protocol)
    if args.protocol == "v2":
        print(json.dumps({"status": result["research_gate"]["status"],
                          "folds": len(result["development_folds"]),
                          "holdout_used": result["holdout"] is not None}))
    else:
        print(json.dumps({"status": result["status"],
                          "candidates": result["search"]["tried"],
                          "accepted": result["search"]["accepted"],
                          "holdout_used": result["holdout"] is not None}))


if __name__ == "__main__":
    main()
