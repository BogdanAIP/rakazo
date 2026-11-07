"""J13 (prospective, r3/r4): order-free eligibility of a PASS_VALIDATION from a multi-rule batch.

The pinned bench (v40.9) computes the cross-trial Sharpe variance from ledger rows already
written plus the rule itself, so a rule's DSR depends on which batch members were validated
before it. This check removes that dependence without touching the pinned code: it recomputes
the DSR for every possible set of predecessors (any subset of the other batch members) with the
pinned formulas and takes the worst. The realised order is one of those subsets, so the check
is never looser than the pinned verdict, and its result is the same in every order.

Fails closed: any missing, nonfinite or inconsistent input (a batch report that does not match its
own summary or SHA, a trial count other than the pinned count, a non-integer period count), an
arithmetic error or a nonfinite DSR gives UNDEFINED, which is not a pass. Stdlib only; reads
reports and ledger rows, writes nothing."""
from __future__ import annotations

import itertools
import math

import algorithm_bench_v40 as bench

MAX_BATCH = 5  # promote 5 per round: at most 16 predecessor subsets per rule


def _finite(x) -> bool:
    if not isinstance(x, (int, float)) or isinstance(x, bool):
        return False
    try:
        return math.isfinite(x)
    except OverflowError:  # a JSON integer beyond float range is not a usable finite number
        return False


def prior_sharpes(ledger_rows, panel_sha: str) -> dict:
    """Same filter as evaluate_validation, applied to the ledger as it stood before the batch's first rule."""
    return {e["hypothesis_sha256"]: e["sharpe_annual_gate"] for e in ledger_rows
            if e.get("region") == "validation" and e.get("panel_sha256") == panel_sha
            and e.get("sharpe_annual_gate") is not None}


_VERDICTS = {"PASS_VALIDATION", "REJECT", "INCONCLUSIVE_UNPOWERED", "FUNDING_UNKNOWN", "INSUFFICIENT_DATA"}


def _gate_sharpe(rep: dict, gate: dict, panel_sha: str):
    """A batch report's own sharpe_annual_gate, checked against its summary; raises ValueError if the
    report is not a consistent pinned validation report. None only for INSUFFICIENT_DATA."""
    if (rep.get("region") != "validation" or rep.get("panel_sha256") != panel_sha
            or rep.get("verdict") not in _VERDICTS
            or rep.get("hypothesis_sha256") != bench.hypothesis_sha(rep["hypothesis"])):
        raise ValueError("not a validation report of this panel")
    s = rep["sharpe_annual_gate"]
    if s is None:
        if rep["verdict"] != "INSUFFICIENT_DATA":
            raise ValueError("missing Sharpe on a non-INSUFFICIENT_DATA report")
        return None
    g = rep["summary"]["by_cost_bp_per_side"][str(gate["gate_cost_bp_per_side"])]
    if rep["verdict"] == "INSUFFICIENT_DATA" or not _finite(s) or s != g["sharpe_annual"] or "selection" not in rep:
        raise ValueError("Sharpe inconsistent with the report")
    return s


def check(report: dict, gate: dict, batch_reports, prior: dict) -> dict:
    """report: one rule's validation report. batch_reports: the complete committed reports of every
    rule in the batch, this one included (a member's Sharpe is taken from its own report and checked
    against its summary; None only with verdict INSUFFICIENT_DATA). prior: prior_sharpes() of the
    ledger before the batch. The report's trial count must equal |prior ∪ batch| + the gate's
    validation_prior_trials, exactly as the pinned bench counts it."""
    out = {"status": "UNDEFINED", "worst_dsr": None, "worst_var_annual": None, "subsets": 0}
    try:
        hsha, panel_sha = report["hypothesis_sha256"], report["panel_sha256"]
        batch = {}
        for rep in batch_reports:
            if rep["hypothesis_sha256"] in batch:
                return out
            batch[rep["hypothesis_sha256"]] = (_gate_sharpe(rep, gate, panel_sha), rep)
        sel, summary = report["selection"], report["summary"]
        g = summary["by_cost_bp_per_side"][str(gate["gate_cost_bp_per_side"])]
        n, ppy, n_trials = summary["periods"], summary["periods_per_year"], sel["trials_counted"]
        own = g["sharpe_annual"]
        moments = (g["sharpe_period_lr"], g["skew"], g["kurtosis"])
        expected_trials = len(set(prior) | set(batch)) + int(gate.get("validation_prior_trials", 0))
    except (KeyError, TypeError, ValueError, AttributeError):
        return out
    if (hsha not in batch or batch[hsha][1] != report
            or batch[hsha][0] != own or not 2 <= len(batch) <= MAX_BATCH or set(prior) & set(batch)
            or not all(_finite(x) for x in (own, n, ppy, *moments, *prior.values()))
            or not (isinstance(n_trials, int) and not isinstance(n_trials, bool)) or n_trials != expected_trials
            or not (isinstance(n, int) and not isinstance(n, bool)) or n < 3 or ppy <= 0):
        return out
    pool = sorted((k, s) for k, (s, _) in batch.items() if k != hsha and s is not None)
    worst = None
    try:
        for r in range(len(pool) + 1):
            for subset in itertools.combinations(pool, r):
                by_sha = dict(prior)
                by_sha.update(subset)
                by_sha[hsha] = own
                srs = list(by_sha.values())
                var = max(bench.moments(srs)[1] ** 2 if len(srs) >= 2 else 0.0, ppy / n)
                dsr = bench.deflated_sharpe(moments[0], n, moments[1], moments[2], n_trials, var / ppy)
                out["subsets"] += 1
                if not (_finite(var) and _finite(dsr)):
                    return out
                if worst is None or dsr < worst[0]:
                    worst = (dsr, var)
    except (ArithmeticError, ValueError):  # e.g. OverflowError from an absurd prior Sharpe
        return out
    out["worst_dsr"], out["worst_var_annual"] = worst
    passed = report.get("verdict") == "PASS_VALIDATION" and worst[0] >= gate["dsr_min"]
    out["status"] = "PASS" if passed else "FAIL"
    return out
