"""J8 replay receipts for r3/r4 (operational check around the pinned `algorithm_search_v40.py j8`).

Why (GPT 2026-11-08 04:23 Moscow): pinned `j8` appends its exploration rows while it
evaluates and only then writes `--out` exclusively, so a repeated invocation with an
existing report path still appends rows and exits 1 with FileExistsError. The pinned code
stays unchanged (search SHA 0c940e22...); this module adds the checks before and after:

  preflight(out, ledger)  before the one replay: both paths must be new (no file there).
  check(...)              after it: the report and its own ledger must bind the verdict to
                          the pinned libraries, the expected panels and both genomes.

check() returns the report verdict only if every receipt agrees, otherwise "INVALID";
ledger rows must follow the pinned order (reference, then candidate, panels in replay order).
Only NEW makes a candidate J8-eligible. The report and ledger must also bind each other:
each role's pooled fitness is rebuilt from its own ledger rows (per-panel Sharpe and fitness)
and the report's per-panel step counts, so a report paired with another replay's ledger is
INVALID (GPT 05:50). The result carries both file SHA-256s, to be kept with the arguments
and exit code of the one replay. Rows from a repeated invocation of the same pair
are accepted only as exact copies (all fields but time_utc) of a complete first set; any
other extra, missing or differing row is INVALID. After an interrupted invocation (no
report), keep the pair as evidence and replay once into a new pair of paths.
Stdlib only, plus the pinned module for library SHAs. Never touches the bench ledger.
"""
from __future__ import annotations

import argparse
import json
import hashlib
import math
import sys
from pathlib import Path

import algorithm_search_v40 as search

VERDICTS = ("NEW", "NOT_NEW", "UNDEFINED")
RHO_SLACK = 1e-12  # pinned fsum/sqrt can return |rho| = 1 + 1 ulp on a genuine self-match
FIT_TOL = 1e-9     # relative; per-panel folds are rebuilt from rounded fitness, not stored


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _count(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x >= 0


def _sha(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def preflight(out, ledger) -> None:
    """Refuse a replay whose report or ledger path already exists (also a dangling link)."""
    for role, p in (("report", Path(out)), ("ledger", Path(ledger))):
        if p.exists() or p.is_symlink():
            raise SystemExit(f"j8 preflight: {role} path already exists; reconcile it and use a new path")
    if Path(out).resolve() == Path(ledger).resolve():
        raise SystemExit("j8 preflight: report and ledger must be different files")


def _expected_verdict(report) -> str | None:
    """Recompute the verdict from the report's own figures (pinned rule, 10-step floor)."""
    blocks = list(report["panels"]) + [report["pooled"]]
    rhos = [b["rho"] for b in blocks]
    if any(r is None for r in rhos):
        return "UNDEFINED"
    if any(not _count(b["matched"]) for b in blocks):
        return None
    for b in report["panels"]:
        if not (_count(b["reference_steps"]) and _count(b["candidate_steps"])
                and b["matched"] <= min(b["reference_steps"], b["candidate_steps"])):
            return None
    if any(not _num(r) or abs(r) > 1 + RHO_SLACK for r in rhos) or any(b["matched"] < 10 for b in blocks):
        return None
    if report["pooled"]["matched"] != sum(b["matched"] for b in report["panels"]):
        return None
    return "NOT_NEW" if any(abs(r) >= search.J8_MAX_CORR for r in rhos) else "NEW"


def _pooled_fitness(rows, steps, genome):
    """Pinned Pooled.evaluate rebuilt from per-panel ledger rows: Sharpe weighted by periods
    (= step count), worst fold recovered from each panel's fitness, same complexity penalty."""
    pen = 0.1 * (search.complexity(genome) - 1)
    sharpes = [r["sharpe_annual_gate"] for r in rows]
    if any(s is None for s in sharpes):
        return -9.0
    fits = [r["fitness"] for r in rows]
    if not all(_num(x) for x in sharpes + fits) or not all(k > 0 for k in steps):
        return None
    if len(rows) == 1:
        return fits[0]
    worst = min(2 * (f + pen) - s for f, s in zip(fits, sharpes))
    return 0.5 * sum(s * k for s, k in zip(sharpes, steps)) / sum(steps) + 0.5 * worst - pen


def check(report_path, ledger_path, panel_shas, reference, candidate, candidate_library,
          reference_library="r2") -> dict:
    """panel_shas: expected SHA-256 of each search export, in the replay's panel order."""
    problems = []
    try:
        report = json.loads(Path(report_path).read_text())
        rows = [json.loads(line) for line in Path(ledger_path).read_text().splitlines() if line.strip()]
    except (OSError, ValueError) as exc:
        return {"verdict": "INVALID", "problems": [f"unreadable receipt: {type(exc).__name__}"]}
    try:
        for role, lib in (("reference", reference_library), ("candidate", candidate_library)):
            got = report[role]
            if got["library"] != lib or got["library_sha256"] != search.library_sha(lib):
                problems.append(f"{role} library is not pinned {lib}")
            if not _num(got["fitness"]):
                problems.append(f"{role} fitness is not finite")
        if len(report["panels"]) != len(panel_shas):
            problems.append("report panel count differs from the expected panels")
        verdict = report["verdict"]
        if verdict not in VERDICTS or _expected_verdict(report) != verdict:
            problems.append("report verdict does not follow from its own rho and matched counts")
    except (KeyError, TypeError, AttributeError):
        return {"verdict": "INVALID", "problems": ["report lacks a pinned j8 field"]}
    if not all(isinstance(r, dict) for r in rows):
        return {"verdict": "INVALID", "problems": ["ledger holds a row that is not a JSON object"]}

    # pinned order: reference then candidate, each on the panels in replay order
    expected = [(sha, _canon(g)) for g in (reference, candidate) for sha in panel_shas]
    keyed = [((r.get("panel_sha256"), _canon(r.get("genome"))), r.get("region"),
              _canon({k: v for k, v in r.items() if k != "time_utc"})) for r in rows]
    n = len(expected)
    replays = len(keyed) // n if n and keyed and len(keyed) % n == 0 else 0
    if not replays:
        problems.append("ledger rows are not whole replays of the expected panels and genomes")
    for i, (key, region, body) in enumerate(keyed if replays else []):
        if key != expected[i % n] or region != "exploration":
            problems.append(f"ledger row {i + 1} is not the expected panel, genome or region")
        elif body != keyed[i % n][2]:
            problems.append(f"ledger row {i + 1} repeats a replay with different values")
    if replays and not problems:
        k = len(panel_shas)
        for j, (role, genome) in enumerate((("reference", reference), ("candidate", candidate))):
            steps = [b[f"{role}_steps"] for b in report["panels"]]
            try:
                want = _pooled_fitness(rows[j * k:(j + 1) * k], steps, genome)
            except (KeyError, TypeError, ArithmeticError):
                want = None
            got = report[role]["fitness"]
            if want is None or abs(want - got) > FIT_TOL * max(1.0, abs(got)):
                problems.append(f"{role} fitness in the report does not follow from its ledger rows")
    return {"verdict": "INVALID" if problems else verdict, "problems": problems,
            "report_sha256": _sha(report_path), "ledger_sha256": _sha(ledger_path),
            "replays_in_ledger": None if problems else replays,
            "eligible": not problems and verdict == "NEW"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("preflight")
    p.add_argument("--out", required=True)
    p.add_argument("--ledger", required=True)
    p = sub.add_parser("check")
    for a in ("--out", "--ledger", "--reference", "--candidate", "--candidate-library"):
        p.add_argument(a, required=True)
    p.add_argument("--reference-library", default="r2")
    p.add_argument("--panel-sha", action="append", required=True, help="once per panel, in replay order")
    args = ap.parse_args(argv)
    if args.cmd == "preflight":
        preflight(args.out, args.ledger)
        print("PREFLIGHT_OK")
        return 0
    res = check(args.out, args.ledger, args.panel_sha, json.loads(args.reference), json.loads(args.candidate),
                args.candidate_library, args.reference_library)
    print(json.dumps(res, indent=1))
    return 0 if res["verdict"] != "INVALID" else 1


if __name__ == "__main__":
    sys.exit(main())
