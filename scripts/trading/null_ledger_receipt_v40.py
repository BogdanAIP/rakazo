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

Added after GPT 2026-11-09 21:35 Moscow (schema counterexamples):
  - JSON with a repeated key anywhere (ledger or report) is INVALID, as are NaN/Infinity;
  - row fields have the writer's types: fitness a finite number, sharpe_annual_gate a finite
    number or null (and then fitness is exactly -9.0), SHAs 64 lowercase hex, genome an object;
  - the report has exactly the writer's keys and must match the intended invocation
    (--seed, --population, --generations, --first-null, --runs); evaluated <= population x generations;
  - pooled-fitness bound (diagnostic, exact arithmetic plus tolerance): per genome with panel
    Sharpes s_i and panel fitnesses f_i, t = min_i(f_i - s_i/2) and the pooled fitness lies in
    [t + min s_i/2, t + max s_i/2], or is exactly -9.0 if any s_i is null. The run's
    best_fitness must lie in [max lower, max upper], best_sharpe in [max min s_i, max max s_i]
    (null only if no genome has all Sharpes), and each top_fitness value within some genome's
    interval (among genomes with every Sharpe), non-increasing and not above best_fitness. An edit inside the bounds still passes.

Added after GPT 2026-11-09 22:21 Moscow (overflow and unbound cutoff):
  - every fitness, Sharpe and report fitness value must satisfy |x| <= 1e9 (MAX_ABS) before any
    arithmetic, so no derived bound can overflow and a huge integer is INVALID instead of raising;
    a genuine annual Sharpe or fitness is many orders of magnitude smaller;
  - the report's library and search_end_utc must equal the required --library and --search-end
    (the frozen run plan), not merely be self-consistent.

It does not rebuild pooled fitness exactly (the ledger lacks the step counts). Keep the exact null
invocation, its exit code and the two SHA-256s printed here with the receipt.
Stdlib only, plus the pinned module for the library. Reads, writes nothing.

    python null_ledger_receipt_v40.py --ledger L.jsonl --report R.json --panel-sha A --panel-sha B \
        --library LIB --search-end YYYY-MM-DDTHH:MM:SSZ --seed S --population P --generations G --first-null K --runs N
Exit 0 = RECEIPT_OK, 1 = INVALID.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search

ROW_KEYS = {"time_utc", "region", "hypothesis_id", "author", "hypothesis_sha256", "panel_sha256", "genome",
            "sharpe_annual_gate", "fitness"}
REPORT_KEYS = {"search_end_utc", "seed", "population", "generations", "library", "library_sha256", "runs"}
RUN_KEYS = {"null_seed", "evaluated", "best_fitness", "best_sharpe", "top_fitness"}
SHA = re.compile(r"[0-9a-f]{64}")
TOL = 1e-9
MAX_ABS = 1e9
UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


class _Malformed(ValueError):
    pass


def _pairs(pairs):
    out = {}
    for key, val in pairs:
        if key in out:
            raise _Malformed(f"repeated key {key!r}")
        out[key] = val
    return out


def _const(name):
    raise _Malformed(f"non-finite constant {name}")


def _loads(b):
    return json.loads(b, object_pairs_hook=_pairs, parse_constant=_const)


def _num(x) -> bool:
    # abs(x) <= MAX_ABS is False for NaN and +-inf and compares huge ints exactly, without overflow
    return isinstance(x, (int, float)) and not isinstance(x, bool) and abs(x) <= MAX_ABS


def _le(a, b) -> bool:
    return a <= b + TOL * max(1.0, abs(a), abs(b))


def _row_ok(row) -> bool:
    s, f = row["sharpe_annual_gate"], row["fitness"]
    return (isinstance(row["time_utc"], str) and isinstance(row["genome"], dict)
            and all(isinstance(row[k], str) and SHA.fullmatch(row[k]) for k in ("hypothesis_sha256", "panel_sha256"))
            and _num(f) and (s is None and f == -9.0 or _num(s)))


def _interval(group):
    """Bounds on pooled fitness and Sharpe for one genome (None Sharpe bounds if pooled is -9.0)."""
    s = [r["sharpe_annual_gate"] for r in group]
    if any(x is None for x in s):
        return -9.0, -9.0, None
    t = min(r["fitness"] - x / 2 for r, x in zip(group, s))
    return t + min(s) / 2, t + max(s) / 2, (min(s), max(s))


def _report_ok(run, bounds) -> str | None:
    best, top, bs = run["best_fitness"], run["top_fitness"], run["best_sharpe"]
    if not _num(best) or not isinstance(top, list) or not all(_num(x) for x in top) or len(top) > 5:
        return "report fitness fields malformed"
    if not (_le(max(b[0] for b in bounds), best) and _le(best, max(b[1] for b in bounds))):
        return "best_fitness outside the bound implied by the ledger"
    if any(not _le(b, a) for a, b in zip(top, top[1:])) or any(not _le(x, best) for x in top):
        return "top_fitness not ordered or above best_fitness"
    if any(not any(sh and _le(lo, x) and _le(x, hi) for lo, hi, sh in bounds) for x in top):
        return "top_fitness value outside every genome's bound"
    sh = [b[2] for b in bounds if b[2] is not None]
    if bs is None:
        return None if not sh else "best_sharpe missing although a genome has every panel Sharpe"
    if not _num(bs) or not sh or not (_le(max(lo for lo, _ in sh), bs) and _le(bs, max(hi for _, hi in sh))):
        return "best_sharpe outside the bound implied by the ledger"
    return None


def _bad(reason, **kw):
    return {"verdict": "INVALID", "reason": reason, **kw}


def _count(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x >= 0


def check(ledger_bytes: bytes, report_bytes: bytes, panel_shas, expect: dict) -> dict:
    """expect: the intended null invocation, keys library, search_end, seed, population, generations,
    first_null, runs."""
    out = {"ledger_sha256": hashlib.sha256(ledger_bytes).hexdigest(),
           "report_sha256": hashlib.sha256(report_bytes).hexdigest()}
    k = len(panel_shas)
    if k < 1 or len(set(panel_shas)) != k:
        return _bad("panel SHAs must be given once each", **out)
    try:
        report = _loads(report_bytes)
    except (ValueError, UnicodeDecodeError) as e:
        return _bad(f"report unreadable: {e}", **out)
    if not isinstance(report, dict) or set(report) != REPORT_KEYS:
        return _bad("report is not a null report", **out)
    runs = report["runs"]
    if not isinstance(runs, list) or not runs or not all(isinstance(r, dict) and set(r) == RUN_KEYS for r in runs):
        return _bad("report runs malformed", **out)
    lib = report["library"]
    if not isinstance(lib, str) or lib not in search.LIBRARIES or search.library_sha(lib) != report["library_sha256"]:
        return _bad("report library unknown or its SHA differs from the pinned code", **out)
    if not isinstance(expect["search_end"], str) or not UTC.fullmatch(expect["search_end"]):
        return _bad("--search-end must be YYYY-MM-DDTHH:MM:SSZ", **out)
    if lib != expect["library"] or report["search_end_utc"] != expect["search_end"]:
        return _bad("report library or search_end_utc differs from the run plan",
                    got=[lib, report["search_end_utc"]], expected=[expect["library"], expect["search_end"]], **out)
    first, n = expect["first_null"], expect["runs"]
    got = [report[k] for k in ("seed", "population", "generations")] + [[r["null_seed"] for r in runs]]
    want = [expect[k] for k in ("seed", "population", "generations")] + [list(range(first, first + n))]
    if json.dumps(got) != json.dumps(want):  # also tells 1 from true and 1.0
        return _bad("report settings differ from the intended invocation", got=got, expected=want, **out)
    cap = report["population"] * report["generations"]
    if not all(_count(r["evaluated"]) and 0 < r["evaluated"] <= cap for r in runs):
        return _bad("report evaluated counts missing or above population x generations", **out)

    lines = ledger_bytes.split(b"\n")
    if lines.pop():
        return _bad("ledger ends in a cut-off fragment", **out)
    rows = []
    for i, line in enumerate(lines):
        try:
            row = _loads(line)
        except (ValueError, UnicodeDecodeError) as e:
            return _bad(f"row {i + 1} unreadable: {e}", **out)
        if not isinstance(row, dict) or set(row) != ROW_KEYS or not _row_ok(row):
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
            author, seen, bounds = f"claude-null-{run['null_seed']}", set(), []
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
                bounds.append(_interval(group))
                i += k
            why = _report_ok(run, bounds)
            if why:
                return _bad(f"{author}: {why}", **out)
    finally:
        search.TERMINALS, search.required_terms = prev
    return {"verdict": "RECEIPT_OK", "rows": len(rows), "runs": [[r["null_seed"], r["evaluated"]] for r in runs],
            "library": lib, **out}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Full-ledger receipt for a completed pooled null run")
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--panel-sha", action="append", required=True, help="search export SHA-256, in panel order")
    ap.add_argument("--library", required=True, help="library of the frozen run plan, e.g. r3-f1")
    ap.add_argument("--search-end", required=True, help="search_end_utc of the frozen search export config")
    for flag in ("--seed", "--population", "--generations", "--first-null", "--runs"):
        ap.add_argument(flag, type=int, required=True, help="as given to the null invocation")
    args = ap.parse_args(argv)
    expect = {k: getattr(args, k) for k in ("library", "search_end", "seed", "population", "generations",
                                            "first_null", "runs")}
    res = check(Path(args.ledger).read_bytes(), Path(args.report).read_bytes(), args.panel_sha, expect)
    print(json.dumps(res, sort_keys=True))
    return 0 if res["verdict"] == "RECEIPT_OK" else 1


if __name__ == "__main__":
    sys.exit(main())
