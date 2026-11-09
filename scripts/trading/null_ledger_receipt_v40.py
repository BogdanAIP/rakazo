"""Full-ledger receipt for a completed pooled null run (companion to ledger_prefix_check_v40.py).

Why (GPT 2026-11-09 20:30 Moscow): PREFIX_MATCH only says the rerun reproduced the interrupted
rows. It still accepts, after the prefix, a duplicate genome, a row from another null seed, or a
missing pair. This check binds the whole exploration ledger of a completed `null` invocation to
its report, using only how the pinned search writes them:

  - every row is a complete, newline-terminated JSON object;
  - the report lists the runs in order; run k's rows come next, as one ordered group per newly
    evaluated genome with one row per panel in the given `--panel-sha` order (Pooled.evaluate);
  - each row is an exploration row of `claude-null-<k>`, and both rows of a group carry the same
    genome and the hypothesis SHA the pinned code compiles from it under the report's library;
  - no genome repeats within a run, and each run has exactly `evaluated` groups;
  - nothing follows the last run.

It does not rebuild pooled fitness (the ledger lacks the step counts). Keep the exact null
invocation, its exit code and the two SHA-256s printed here with the receipt.
Stdlib only, plus the pinned module for the library. Reads, writes nothing.

    python null_ledger_receipt_v40.py --ledger L.jsonl --report R.json --panel-sha A --panel-sha B
Exit 0 = RECEIPT_OK, 1 = INVALID.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search

ROW_KEYS = {"time_utc", "region", "hypothesis_id", "author", "hypothesis_sha256", "panel_sha256", "genome",
            "sharpe_annual_gate", "fitness"}


def _bad(reason, **kw):
    return {"verdict": "INVALID", "reason": reason, **kw}


def _count(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x >= 0


def check(ledger_bytes: bytes, report_bytes: bytes, panel_shas) -> dict:
    out = {"ledger_sha256": hashlib.sha256(ledger_bytes).hexdigest(),
           "report_sha256": hashlib.sha256(report_bytes).hexdigest()}
    k = len(panel_shas)
    if k < 1 or len(set(panel_shas)) != k:
        return _bad("panel SHAs must be given once each", **out)
    try:
        report = json.loads(report_bytes)
    except (ValueError, UnicodeDecodeError) as e:
        return _bad(f"report unreadable: {e}", **out)
    runs = report.get("runs") if isinstance(report, dict) else None
    if not isinstance(runs, list) or not runs:
        return _bad("report has no runs", **out)
    lib = report.get("library")
    if lib not in search.LIBRARIES or search.library_sha(lib) != report.get("library_sha256"):
        return _bad("report library unknown or its SHA differs from the pinned code", **out)
    seeds = [r.get("null_seed") if isinstance(r, dict) else None for r in runs]
    if not all(_count(s) for s in seeds) or len(set(seeds)) != len(seeds):
        return _bad("report null seeds missing or repeated", **out)
    if not all(_count(r.get("evaluated")) and r["evaluated"] > 0 for r in runs):
        return _bad("report evaluated counts missing", **out)

    lines = ledger_bytes.split(b"\n")
    if lines.pop():
        return _bad("ledger ends in a cut-off fragment", **out)
    rows = []
    for i, line in enumerate(lines):
        try:
            row = json.loads(line)
        except (ValueError, UnicodeDecodeError) as e:
            return _bad(f"row {i + 1} unreadable: {e}", **out)
        if not isinstance(row, dict) or set(row) != ROW_KEYS:
            return _bad(f"row {i + 1} is not a search exploration row", **out)
        rows.append(row)
    need = sum(r["evaluated"] for r in runs) * k
    if len(rows) != need:
        return _bad("ledger rows differ from panels x evaluated", rows=len(rows), expected=need, **out)

    prev = search.TERMINALS, search.required_terms
    try:
        search.use_library(lib)
        i = 0
        for run in runs:
            author, seen = f"claude-null-{run['null_seed']}", set()
            for _ in range(run["evaluated"]):
                group = rows[i:i + k]
                g = group[0]["genome"]
                key = search.genome_key(g) if isinstance(g, dict) else None
                if key is None or key in seen:
                    return _bad(f"row {i + 1}: genome missing or repeated in {author}", **out)
                seen.add(key)
                try:
                    hsha = bench.hypothesis_sha(search.to_hypothesis(g, "search-candidate"))
                except (KeyError, TypeError, ValueError, SystemExit) as e:
                    return _bad(f"row {i + 1}: genome does not compile: {e}", **out)
                for j, (row, sha) in enumerate(zip(group, panel_shas)):
                    n = i + j + 1
                    if (row["region"], row["hypothesis_id"], row["author"]) != ("exploration", "search", author):
                        return _bad(f"row {n}: not an exploration row of {author}", **out)
                    if row["panel_sha256"] != sha:
                        return _bad(f"row {n}: panel out of order", **out)
                    if search.genome_key(row["genome"]) != key or row["hypothesis_sha256"] != hsha:
                        return _bad(f"row {n}: genome or hypothesis SHA differs within its group", **out)
                i += k
    finally:
        search.TERMINALS, search.required_terms = prev
    return {"verdict": "RECEIPT_OK", "rows": len(rows), "runs": [[r["null_seed"], r["evaluated"]] for r in runs],
            "library": lib, **out}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Full-ledger receipt for a completed pooled null run")
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--panel-sha", action="append", required=True, help="search export SHA-256, in panel order")
    args = ap.parse_args(argv)
    res = check(Path(args.ledger).read_bytes(), Path(args.report).read_bytes(), args.panel_sha)
    print(json.dumps(res, sort_keys=True))
    return 0 if res["verdict"] == "RECEIPT_OK" else 1


if __name__ == "__main__":
    sys.exit(main())
