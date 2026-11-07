"""J13 (prospective, r3/r4): order-free eligibility of a PASS_VALIDATION from a multi-rule batch.

The pinned bench (v40.9) computes the cross-trial Sharpe variance from ledger rows already
written plus the rule itself, so a rule's DSR depends on which batch members were validated
before it. This check removes that dependence without touching the pinned code: it recomputes
the DSR for every possible set of predecessors (any subset of the other batch members) with the
pinned formulas and takes the worst. The realised order is one of those subsets, so the check
is never looser than the pinned verdict, and its result is the same in every order.

Fails closed: any missing or nonfinite input, or a nonfinite DSR, gives UNDEFINED, which is
not a pass. Stdlib only; reads reports and ledger rows, writes nothing."""
from __future__ import annotations

import itertools
import math

import algorithm_bench_v40 as bench

MAX_BATCH = 5  # promote 5 per round: at most 16 predecessor subsets per rule


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def prior_sharpes(ledger_rows, panel_sha: str) -> dict:
    """Same filter as evaluate_validation, applied to the ledger as it stood before the batch's first rule."""
    return {e["hypothesis_sha256"]: e["sharpe_annual_gate"] for e in ledger_rows
            if e.get("region") == "validation" and e.get("panel_sha256") == panel_sha
            and e.get("sharpe_annual_gate") is not None}


def check(report: dict, gate: dict, batch_sharpes: dict, prior: dict) -> dict:
    """report: one rule's validation report. batch_sharpes: hypothesis SHA -> sharpe_annual_gate
    (None for a rule without one, e.g. INSUFFICIENT_DATA) for every rule in the batch, this one
    included. prior: prior_sharpes() of the ledger before the batch."""
    out = {"status": "UNDEFINED", "worst_dsr": None, "worst_var_annual": None, "subsets": 0}
    try:
        hsha = report["hypothesis_sha256"]
        sel, summary = report["selection"], report["summary"]
        g = summary["by_cost_bp_per_side"][str(gate["gate_cost_bp_per_side"])]
        n, ppy, n_trials = summary["periods"], summary["periods_per_year"], sel["trials_counted"]
        own = g["sharpe_annual"]
        moments = (g["sharpe_period_lr"], g["skew"], g["kurtosis"])
    except (KeyError, TypeError):
        return out
    others = {k: v for k, v in batch_sharpes.items() if k != hsha}
    if (hsha not in batch_sharpes or not 2 <= len(batch_sharpes) <= MAX_BATCH
            or not all(_finite(x) for x in (own, n, ppy, n_trials, *moments, *prior.values()))
            or not all(v is None or _finite(v) for v in others.values()) or n < 3 or ppy <= 0):
        return out
    pool = sorted((k, v) for k, v in others.items() if v is not None)
    worst = None
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
    out["worst_dsr"], out["worst_var_annual"] = worst
    passed = report.get("verdict") == "PASS_VALIDATION" and worst[0] >= gate["dsr_min"]
    out["status"] = "PASS" if passed else "FAIL"
    return out
