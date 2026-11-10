"""J15 early-fail comparison for r3 (agreed by both 11-10 15:09 Moscow): real best vs nulls 0..K-1.

J3 promotes a round only if its unfiltered real best fitness is strictly greater than every null
maximum. A missing null can only raise that maximum, so if the real best is <= the maximum of the
completed nulls, the round has failed J3 whatever the missing null would give.

This helper only does the comparison, from the saved reports as the pinned search writes them:

  - real report (`run`): exactly the writer's keys; `history` is generations 0..G-1 in order with
    finite best_fitness, non-decreasing best_fitness and evaluated_total (elites are kept and the
    fitness cache is exact), history[0].evaluated_total <= population and the final
    evaluated_total == `evaluated` <= population x generations. Real best = max(history
    best_fitness), the exact float the evaluator saw (every evaluated genome is scored in some
    generation; GPT checked bit-identity on the pinned CLI 11-10 15:09);
  - null reports (`null`, one or more, e.g. resumed segments): exactly the writer's keys, the same
    seed, population and generations as given, every run's evaluated in (0, population x generations];
  - all reports: the same library (registered, SHA equal to the pinned code) and search_end_utc as given;
  - the null seeds across all null reports are exactly 0..K-1 with no seed twice (J9-C1: no choice
    between two runs of one seed); JSON with repeated keys or NaN/Infinity is INVALID.

Verdicts (exit code):
  EARLY_FAIL     (0) real best <= max null best; `blocking` lists every null seed whose best is >= the
                     real best. J15 still requires, for the real run and for at least one blocking null,
                     the full receipts (preserved original invocation, exit 0, completion hashes,
                     GEN0_OK, null_ledger RECEIPT_OK; PREFIX_MATCH for null6) before "no discovery" is recorded.
  NO_EARLY_FAIL  (2) real best > every given null; the null18 replay condition (Log 11-10 13:12) applies.
  INVALID        (1) anything above fails; nothing is concluded.
It is not a receipt: it does not read ledgers or bind seeds. Stdlib plus the pinned module; reads only.

    python j15_precheck_v40.py --run-report R.json --null-report N1.json [--null-report N2.json ...] \
        --library r3-f1 --search-end YYYY-MM-DDTHH:MM:SSZ --seed 43 --population 80 --generations 30 --nulls 18
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import algorithm_search_v40 as search
from null_ledger_receipt_v40 import REPORT_KEYS, RUN_KEYS, UTC, _count, _loads, _num

RUN_REPORT_KEYS = {"round", "search_end_utc", "evaluated", "library", "library_sha256", "history", "top"}
HIST_KEYS = {"generation", "best_fitness", "evaluated_total"}


def _bad(reason, **kw):
    return {"verdict": "INVALID", "reason": reason, **kw}


def _lib_ok(rep, expect) -> str | None:
    lib = rep["library"]
    if not isinstance(lib, str) or lib not in search.LIBRARIES or search.library_sha(lib) != rep["library_sha256"]:
        return "library unknown or its SHA differs from the pinned code"
    if lib != expect["library"] or rep["search_end_utc"] != expect["search_end"]:
        return "library or search_end_utc differs from the run plan"
    return None


def real_best(rep, expect) -> tuple[float | None, str | None]:
    if not isinstance(rep, dict) or set(rep) != RUN_REPORT_KEYS:
        return None, "run report is not a search run report"
    why = _lib_ok(rep, expect)
    if why:
        return None, f"run report: {why}"
    pop, gens, hist = expect["population"], expect["generations"], rep["history"]
    if not isinstance(hist, list) or len(hist) != gens:
        return None, "run report history length differs from --generations"
    prev_f = prev_n = None
    for i, h in enumerate(hist):
        if not isinstance(h, dict) or set(h) != HIST_KEYS or not _count(h["generation"]) or h["generation"] != i:
            return None, f"history entry {i} malformed or out of order"
        f, n = h["best_fitness"], h["evaluated_total"]
        if not _num(f) or not _count(n) or n == 0:
            return None, f"history entry {i}: best_fitness or evaluated_total invalid"
        if prev_f is not None and (f < prev_f or n < prev_n):
            return None, f"history entry {i}: best_fitness or evaluated_total decreased"
        prev_f, prev_n = f, n
    ev = rep["evaluated"]
    if hist[0]["evaluated_total"] > pop or ev != hist[-1]["evaluated_total"] or not _count(ev) or ev > pop * gens:
        return None, "run report evaluated counts inconsistent with history or population x generations"
    return max(h["best_fitness"] for h in hist), None


def check(run_bytes: bytes, null_bytes: list[bytes], expect: dict) -> dict:
    """expect: library, search_end, seed, population, generations, nulls (K: seeds 0..K-1)."""
    out = {"run_report_sha256": hashlib.sha256(run_bytes).hexdigest(),
           "null_report_sha256": [hashlib.sha256(b).hexdigest() for b in null_bytes]}
    if not isinstance(expect["search_end"], str) or not UTC.fullmatch(expect["search_end"]):
        return _bad("--search-end must be YYYY-MM-DDTHH:MM:SSZ", **out)
    if not null_bytes or not all(_count(expect[k]) and expect[k] >= 1 for k in ("nulls", "population", "generations")):
        return _bad("need at least one null report and --nulls, --population, --generations >= 1", **out)
    if not _count(expect["seed"]):
        return _bad("--seed must be a non-negative integer", **out)
    try:
        rep = _loads(run_bytes)
        nulls = [_loads(b) for b in null_bytes]
    except (ValueError, UnicodeDecodeError) as e:
        return _bad(f"report unreadable: {e}", **out)
    best, why = real_best(rep, expect)
    if why:
        return _bad(why, **out)
    cap = expect["population"] * expect["generations"]
    want = [expect[k] for k in ("seed", "population", "generations")]
    by_seed = {}
    for j, n in enumerate(nulls):
        if not isinstance(n, dict) or set(n) != REPORT_KEYS:
            return _bad(f"null report {j + 1} is not a null report", **out)
        why = _lib_ok(n, expect)
        if why:
            return _bad(f"null report {j + 1}: {why}", **out)
        got = [n[k] for k in ("seed", "population", "generations")]
        if json.dumps(got) != json.dumps(want):  # also tells 1 from true and 1.0
            return _bad(f"null report {j + 1}: settings differ from the run plan", got=got, expected=want, **out)
        runs = n["runs"]
        if not isinstance(runs, list) or not runs or not all(isinstance(r, dict) and set(r) == RUN_KEYS for r in runs):
            return _bad(f"null report {j + 1}: runs malformed", **out)
        for r in runs:
            k = r["null_seed"]
            if not _count(k) or not _count(r["evaluated"]) or not 0 < r["evaluated"] <= cap or not _num(r["best_fitness"]):
                return _bad(f"null report {j + 1}: run fields invalid", **out)
            if k in by_seed:
                return _bad(f"null seed {k} appears twice", **out)
            by_seed[k] = r["best_fitness"]
    if sorted(by_seed) != list(range(expect["nulls"])):
        return _bad("null seeds are not exactly 0..K-1", got=sorted(by_seed), **out)
    null_max = max(by_seed.values())
    res = {"real_best": best, "null_max": null_max, "nulls": expect["nulls"], **out}
    if best <= null_max:
        return {"verdict": "EARLY_FAIL", "blocking": sorted(k for k, f in by_seed.items() if f >= best), **res}
    return {"verdict": "NO_EARLY_FAIL", **res}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="J15 early-fail comparison of a real search best against completed nulls")
    ap.add_argument("--run-report", required=True)
    ap.add_argument("--null-report", action="append", required=True)
    ap.add_argument("--library", required=True)
    ap.add_argument("--search-end", required=True)
    for flag in ("--seed", "--population", "--generations", "--nulls"):
        ap.add_argument(flag, type=int, required=True)
    args = ap.parse_args(argv)
    expect = {k: getattr(args, k) for k in ("library", "search_end", "seed", "population", "generations", "nulls")}
    res = check(Path(args.run_report).read_bytes(), [Path(p).read_bytes() for p in args.null_report], expect)
    print(json.dumps(res, sort_keys=True))
    return {"EARLY_FAIL": 0, "NO_EARLY_FAIL": 2}.get(res["verdict"], 1)


if __name__ == "__main__":
    sys.exit(main())
