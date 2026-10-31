"""Algorithm Bench v40: one fixed evaluation harness for typed trading hypotheses.

Purpose: replace per-version ad-hoc experiments with a single verifier that
any agent (GPT, Claude or a human) submits typed JSON hypotheses into.

Design rules
- Hypotheses are typed JSON expression trees. Nothing is eval'd or exec'd.
- Every operator only reads values at or before the decision bar, so the
  score at bar t is identical whether or not later bars exist (tested).
- Development evaluation physically truncates the panel before the frozen
  holdout boundary; holdout data cannot influence a development report.
- Every development evaluation is appended to a ledger. The deflated Sharpe
  ratio (Bailey & Lopez de Prado, 2014) uses the number of distinct trials in
  that ledger, so trying many ideas raises the bar for each one.
- A failed test is only called REJECT when it had the power to detect the
  target effect. Otherwise it is INCONCLUSIVE_UNPOWERED.
- The holdout is one-use per hypothesis and globally budgeted.
- Research only: this module never places orders or touches accounts.

Stdlib only. Python 3.10+.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import random
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import NormalDist

SCHEMA_HYP = "rakazo_bench_hypothesis_v1"
SCHEMA_CONFIG = "rakazo_bench_config_v1"
VERSION = "bench-v40"

MAX_DEPTH = 8
MAX_NODES = 64
MAX_WINDOW = 2000
MAX_HYPOTHESES_PER_FILE = 32
MAX_HYP_FILE_BYTES = 65_536
EPS = 1e-12
MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

BASE_FIELDS = ("open", "high", "low", "close", "volume")
OPTIONAL_FIELDS = ("funding", "oi")
FEATURE_FIELDS = ("open", "high", "low", "close", "volume", "oi", "funding", "ret", "range")
SYMBOL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,39}")
ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")

# op -> (kind, arity of expression children, integer params)
OPS = {
    "field": ("leaf", 0, 0),
    "const": ("leaf", 0, 0),
    "neg": ("unary", 1, 0),
    "abs": ("unary", 1, 0),
    "sign": ("unary", 1, 0),
    "tanh": ("unary", 1, 0),
    "log1p": ("unary", 1, 0),
    "add": ("binary", 2, 0),
    "sub": ("binary", 2, 0),
    "mul": ("binary", 2, 0),
    "div": ("binary", 2, 0),
    "max": ("binary", 2, 0),
    "min": ("binary", 2, 0),
    "clip": ("clip", 1, 0),
    "lag": ("window", 1, 1),
    "delta": ("window", 1, 1),
    "pct": ("window", 1, 1),
    "sum": ("window", 1, 1),
    "mean": ("window", 1, 1),
    "std": ("window", 1, 1),
    "z": ("window", 1, 1),
    "ema": ("window", 1, 1),
    "tsrank": ("window", 1, 1),
    "csrank": ("cross", 1, 0),
    "csz": ("cross", 1, 0),
    "csdemean": ("cross", 1, 0),
}


# ---------------------------------------------------------------- utilities

def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utc_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _finite(x) -> bool:
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)


def write_exclusive(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as fh:
        fh.write(json.dumps(payload, indent=1, sort_keys=True).encode())
        fh.flush()
        os.fsync(fh.fileno())


# -------------------------------------------------------------------- panel

class Panel:
    """Aligned bar panel. series[field][symbol] is a list over the time grid."""

    def __init__(self, times, symbols, series, bar_ms, sha, funding_known):
        self.times = times
        self.symbols = symbols
        self.series = series
        self.bar_ms = bar_ms
        self.sha = sha
        self.funding_known = funding_known  # symbols with at least one funding row

    @property
    def T(self) -> int:
        return len(self.times)

    def truncated(self, end_index: int) -> "Panel":
        """Panel containing only bars [0, end_index). Used to hide the holdout."""
        series = {f: {s: v[:end_index] for s, v in d.items()} for f, d in self.series.items()}
        return Panel(self.times[:end_index], self.symbols, series, self.bar_ms, self.sha, self.funding_known)


def _parse_float(text, name, line):
    if text is None or text == "":
        return None
    try:
        value = float(text)
    except ValueError as exc:
        raise ValueError(f"line {line}: {name} is not a number") from exc
    if not math.isfinite(value):
        raise ValueError(f"line {line}: {name} is not finite")
    return value


def load_panel(path) -> Panel:
    """Read the panel CSV.

    Columns: ts,symbol,open,high,low,close,volume[,funding][,oi]
    ts      bar OPEN time, integer milliseconds UTC, on one fixed grid
    funding funding rate SETTLED during this bar (empty = no settlement)
    oi      open interest observed at bar close (empty = unknown)
    """
    raw = Path(path).read_bytes()
    sha = sha256_bytes(raw)
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    cols = set(reader.fieldnames or [])
    missing = {"ts", "symbol", *BASE_FIELDS} - cols
    if missing:
        raise ValueError(f"panel missing columns: {sorted(missing)}")
    rows = {}
    stamps = set()
    for line, row in enumerate(reader, start=2):
        sym = row["symbol"]
        if not SYMBOL_RE.fullmatch(sym or ""):
            raise ValueError(f"line {line}: bad symbol")
        try:
            ts = int(row["ts"])
        except ValueError as exc:
            raise ValueError(f"line {line}: ts must be integer ms") from exc
        key = (ts, sym)
        if key in rows:
            raise ValueError(f"line {line}: duplicate bar {sym} {ts}")
        vals = {f: _parse_float(row.get(f), f, line) for f in BASE_FIELDS}
        if any(vals[f] is None for f in BASE_FIELDS):
            raise ValueError(f"line {line}: empty OHLCV value")
        o, h, l, c, v = (vals[f] for f in BASE_FIELDS)
        if min(o, h, l, c) <= 0 or v < 0:
            raise ValueError(f"line {line}: non-positive price or negative volume")
        if h + EPS < max(o, c, l) or l - EPS > min(o, c, h):
            raise ValueError(f"line {line}: inconsistent high/low")
        for f in OPTIONAL_FIELDS:
            vals[f] = _parse_float(row.get(f), f, line) if f in cols else None
        rows[key] = vals
        stamps.add(ts)
    if not rows:
        raise ValueError("panel is empty")
    ordered = sorted(stamps)
    if len(ordered) < 2:
        raise ValueError("panel needs at least two bars")
    diffs = Counter(b - a for a, b in zip(ordered, ordered[1:]))
    bar_ms = max(diffs, key=lambda d: (diffs[d], -d))  # most common step; gaps are multiples of it
    if bar_ms <= 0 or any((t - ordered[0]) % bar_ms for t in ordered):
        raise ValueError("timestamps are not on one fixed grid")
    times = list(range(ordered[0], ordered[-1] + bar_ms, bar_ms))
    index = {t: i for i, t in enumerate(times)}
    symbols = sorted({s for _, s in rows})
    T = len(times)
    series = {f: {s: [None] * T for s in symbols} for f in BASE_FIELDS + OPTIONAL_FIELDS}
    for (ts, sym), vals in rows.items():
        i = index[ts]
        for f in BASE_FIELDS + OPTIONAL_FIELDS:
            series[f][sym][i] = vals[f]
    funding_known = {s for s in symbols if any(x is not None for x in series["funding"][s])}
    return Panel(times, symbols, series, bar_ms, sha, funding_known)


def audit_panel(panel: Panel) -> dict:
    present = {s: sum(x is not None for x in panel.series["close"][s]) for s in panel.symbols}
    empty_bars = sum(1 for i in range(panel.T) if all(panel.series["close"][s][i] is None for s in panel.symbols))
    return {
        "panel_sha256": panel.sha,
        "bar_ms": panel.bar_ms,
        "bars": panel.T,
        "start": utc_iso(panel.times[0]),
        "end_bar_open": utc_iso(panel.times[-1]),
        "symbols": len(panel.symbols),
        "bars_present_min": min(present.values()),
        "bars_present_max": max(present.values()),
        "fully_empty_bars": empty_bars,
        "symbols_without_funding": sorted(set(panel.symbols) - panel.funding_known),
        "symbols_with_oi": sum(1 for s in panel.symbols if any(x is not None for x in panel.series["oi"][s])),
    }


# --------------------------------------------------------------- hypotheses

def _count_nodes(node, depth=1):
    if depth > MAX_DEPTH:
        raise ValueError("expression too deep")
    if not isinstance(node, list) or not node or not isinstance(node[0], str):
        raise ValueError("expression nodes must be non-empty lists starting with an operator")
    op = node[0]
    if op not in OPS:
        raise ValueError(f"unknown operator {op!r}")
    kind, arity, nparams = OPS[op]
    if op == "field":
        if len(node) != 2 or node[1] not in FEATURE_FIELDS:
            raise ValueError(f"field must name one of {FEATURE_FIELDS}")
        return 1
    if op == "const":
        if len(node) != 2 or isinstance(node[1], bool) or not _finite(node[1]):
            raise ValueError("const needs one finite number")
        return 1
    if kind == "clip":
        if len(node) != 3 or isinstance(node[2], bool) or not _finite(node[2]) or node[2] <= 0:
            raise ValueError("clip needs [clip, expr, positive bound]")
        return 1 + _count_nodes(node[1], depth + 1)
    if kind == "window":
        if len(node) != 3:
            raise ValueError(f"{op} needs [op, expr, window]")
        n = node[2]
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_WINDOW:
            raise ValueError(f"{op} window must be an integer in 1..{MAX_WINDOW}")
        if op in ("std", "z", "tsrank") and n < 2:
            raise ValueError(f"{op} window must be at least 2")
        return 1 + _count_nodes(node[1], depth + 1)
    if len(node) != 1 + arity:
        raise ValueError(f"{op} takes {arity} argument(s)")
    return 1 + sum(_count_nodes(child, depth + 1) for child in node[1:])


def validate_hypothesis(rec: dict) -> dict:
    allowed = {"id", "author", "rationale", "score", "mode", "horizon_bars", "quantile", "min_symbols"}
    if not isinstance(rec, dict) or not set(rec) <= allowed or not {"id", "score", "horizon_bars"} <= set(rec):
        raise ValueError("hypothesis needs id, score, horizon_bars and only known fields")
    if not isinstance(rec["id"], str) or not ID_RE.fullmatch(rec["id"]):
        raise ValueError("bad hypothesis id")
    if _count_nodes(rec["score"]) > MAX_NODES:
        raise ValueError("expression has too many nodes")
    h = rec["horizon_bars"]
    if isinstance(h, bool) or not isinstance(h, int) or not 1 <= h <= 500:
        raise ValueError("horizon_bars must be an integer in 1..500")
    out = {
        "id": rec["id"],
        "author": str(rec.get("author", "unknown"))[:40],
        "rationale": str(rec.get("rationale", ""))[:2000],
        "score": rec["score"],
        "mode": rec.get("mode", "cross_section"),
        "horizon_bars": h,
        "quantile": rec.get("quantile", 0.2),
        "min_symbols": rec.get("min_symbols", 10),
    }
    if out["mode"] not in ("cross_section", "time_series"):
        raise ValueError("mode must be cross_section or time_series")
    q = out["quantile"]
    if isinstance(q, bool) or not _finite(q) or not 0 < q <= 0.5:
        raise ValueError("quantile must be in (0, 0.5]")
    m = out["min_symbols"]
    if isinstance(m, bool) or not isinstance(m, int) or not 2 <= m <= 1000:
        raise ValueError("min_symbols must be an integer in 2..1000")
    return out


def hypothesis_sha(h: dict) -> str:
    """Identity of the testable rule; rationale/author/id do not change it."""
    core = {k: h[k] for k in ("score", "mode", "horizon_bars", "quantile", "min_symbols")}
    return sha256_bytes(canonical(core))


def read_hypotheses(path) -> list[dict]:
    path = Path(path)
    if path.stat().st_size > MAX_HYP_FILE_BYTES:
        raise ValueError("hypothesis file too large")
    doc = json.loads(path.read_bytes().decode("utf-8-sig"))
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA_HYP:
        raise ValueError(f"schema must be {SCHEMA_HYP}")
    recs = doc.get("hypotheses")
    if not isinstance(recs, list) or not 1 <= len(recs) <= MAX_HYPOTHESES_PER_FILE:
        raise ValueError(f"need 1..{MAX_HYPOTHESES_PER_FILE} hypotheses")
    out = [validate_hypothesis(r) for r in recs]
    ids = [h["id"] for h in out]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate hypothesis ids")
    return out


# ------------------------------------------------------- causal evaluation

def _rolling(xs, n, fn):
    """Apply fn to each full window xs[t-n+1..t]; any None in window gives None."""
    out = [None] * len(xs)
    nones = 0
    for t, x in enumerate(xs):
        if x is None:
            nones += 1
        if t >= n and xs[t - n] is None:
            nones -= 1
        if t >= n - 1 and nones == 0:
            out[t] = fn(xs, t - n + 1, t + 1)
    return out


def _win_sum(xs, a, b):
    return math.fsum(xs[a:b])


def _win_mean(xs, a, b):
    return math.fsum(xs[a:b]) / (b - a)


def _win_std(xs, a, b):
    w = xs[a:b]
    mu = math.fsum(w) / len(w)
    var = math.fsum((x - mu) ** 2 for x in w) / (len(w) - 1)
    return math.sqrt(var) if var > 0 else 0.0


def _win_z(xs, a, b):
    sd = _win_std(xs, a, b)
    if sd < EPS:
        return None
    return (xs[b - 1] - _win_mean(xs, a, b)) / sd


def _win_tsrank(xs, a, b):
    w = xs[a:b]
    cur = w[-1]
    below = sum(1 for x in w if x < cur)
    equal = sum(1 for x in w if x == cur)
    return (below + (equal - 1) / 2) / (len(w) - 1) - 0.5


def _ts_op(op, xs, n):
    T = len(xs)
    if op == "lag":
        return [xs[t - n] if t >= n else None for t in range(T)]
    if op == "delta":
        return [xs[t] - xs[t - n] if t >= n and xs[t] is not None and xs[t - n] is not None else None for t in range(T)]
    if op == "pct":
        return [xs[t] / xs[t - n] - 1 if t >= n and xs[t] is not None and xs[t - n] is not None and abs(xs[t - n]) > EPS else None for t in range(T)]
    if op == "ema":
        out, state, warm = [None] * T, None, 0
        alpha = 2.0 / (n + 1)
        for t, x in enumerate(xs):
            if x is None:
                state, warm = None, 0
                continue
            state = x if state is None else alpha * x + (1 - alpha) * state
            warm += 1
            if warm >= n:
                out[t] = state
        return out
    fn = {"sum": _win_sum, "mean": _win_mean, "std": _win_std, "z": _win_z, "tsrank": _win_tsrank}[op]
    return _rolling(xs, n, fn)


def _avg_ranks(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        r = (i + j) / 2
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def _cross_op(op, by_sym, symbols, T):
    out = {s: [None] * T for s in symbols}
    for t in range(T):
        live = [s for s in symbols if by_sym[s][t] is not None]
        if not live:
            continue
        vals = [by_sym[s][t] for s in live]
        m = len(vals)
        if op == "csrank":
            if m < 2:
                continue
            ranks = _avg_ranks(vals)
            for s, r in zip(live, ranks):
                out[s][t] = r / (m - 1) - 0.5
        else:
            mu = math.fsum(vals) / m
            if op == "csdemean":
                for s, v in zip(live, vals):
                    out[s][t] = v - mu
            else:
                if m < 3:
                    continue
                sd = math.sqrt(math.fsum((v - mu) ** 2 for v in vals) / (m - 1))
                if sd < EPS:
                    continue
                for s, v in zip(live, vals):
                    out[s][t] = (v - mu) / sd
    return out


def _base_feature(panel: Panel, name: str):
    s = panel.series
    if name in BASE_FIELDS or name == "oi":
        return s[name]
    out = {}
    for sym in panel.symbols:
        if name == "ret":
            c = s["close"][sym]
            out[sym] = [math.log(c[t] / c[t - 1]) if t and c[t] is not None and c[t - 1] is not None else None for t in range(panel.T)]
        elif name == "range":
            h, l = s["high"][sym], s["low"][sym]
            out[sym] = [math.log(h[t] / l[t]) if h[t] is not None else None for t in range(panel.T)]
        elif name == "funding":
            # last funding rate settled at or before this bar, forward filled
            raw, last, seq = s["funding"][sym], None, []
            for x in raw:
                if x is not None:
                    last = x
                seq.append(last)
            out[sym] = seq
    return out


def _unary(op, x):
    if op == "neg":
        return -x
    if op == "abs":
        return abs(x)
    if op == "sign":
        return (x > 0) - (x < 0)
    if op == "tanh":
        return math.tanh(x)
    if op == "log1p":
        return math.copysign(math.log1p(abs(x)), x)
    raise AssertionError(op)


def _binary(op, a, b):
    if op == "add":
        return a + b
    if op == "sub":
        return a - b
    if op == "mul":
        return a * b
    if op == "div":
        return a / b if abs(b) > EPS else None
    if op == "max":
        return max(a, b)
    if op == "min":
        return min(a, b)
    raise AssertionError(op)


def evaluate_expression(node, panel: Panel, cache=None):
    """Return {symbol: [value or None per bar]} using only past and current bars."""
    cache = {} if cache is None else cache
    key = canonical(node)
    if key in cache:
        return cache[key]
    op = node[0]
    kind = OPS[op][0]
    syms, T = panel.symbols, panel.T
    if op == "field":
        res = _base_feature(panel, node[1])
    elif op == "const":
        res = {s: [float(node[1])] * T for s in syms}
    elif kind == "unary":
        x = evaluate_expression(node[1], panel, cache)
        res = {s: [_unary(op, v) if v is not None else None for v in x[s]] for s in syms}
    elif kind == "binary":
        a = evaluate_expression(node[1], panel, cache)
        b = evaluate_expression(node[2], panel, cache)
        res = {s: [_binary(op, u, v) if u is not None and v is not None else None for u, v in zip(a[s], b[s])] for s in syms}
    elif kind == "clip":
        x = evaluate_expression(node[1], panel, cache)
        c = float(node[2])
        res = {s: [max(-c, min(c, v)) if v is not None else None for v in x[s]] for s in syms}
    elif kind == "window":
        x = evaluate_expression(node[1], panel, cache)
        res = {s: _ts_op(op, x[s], node[2]) for s in syms}
    else:
        x = evaluate_expression(node[1], panel, cache)
        res = _cross_op(op, x, syms, T)
    for s in syms:
        res[s] = [v if v is None or math.isfinite(v) else None for v in res[s]]
    cache[key] = res
    return res


# ------------------------------------------------------------- simulation

def _exit_price(panel: Panel, sym, entry, exit_):
    px = panel.series["open"][sym][exit_] if exit_ < panel.T else None
    if px is not None:
        return px, False
    closes = panel.series["close"][sym]
    for j in range(min(exit_, panel.T) - 1, entry - 1, -1):
        if closes[j] is not None:
            return closes[j], True
    return None, True


def _spearman(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    rx, ry = _avg_ranks(xs), _avg_ranks(ys)
    mx, my = math.fsum(rx) / n, math.fsum(ry) / n
    num = math.fsum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(math.fsum((a - mx) ** 2 for a in rx) * math.fsum((b - my) ** 2 for b in ry))
    return num / den if den > EPS else None


def simulate(panel: Panel, hyp: dict, first_entry: int, last_exit: int, costs_bp: list[float]) -> dict:
    """Non-overlapping rebalances. Decision after close of bar t, entry at open
    of bar t+1, exit at open of bar t+1+h. Entries >= first_entry, exits <= last_exit.
    Weights: cross_section long top q / short bottom q, +0.5 / -0.5 gross each side;
    time_series sign(score)/m. Funding: a long pays the settled rate, a short receives it.
    """
    h = hyp["horizon_bars"]
    score = evaluate_expression(hyp["score"], panel)
    opens, closes, funding = panel.series["open"], panel.series["close"], panel.series["funding"]
    periods = []
    prev_w: dict = {}
    forced = 0
    t = max(first_entry - 1, 0)
    while t + 1 + h <= last_exit:
        entry, exit_ = t + 1, t + 1 + h
        cand = []
        for s in panel.symbols:
            sc = score[s][t]
            if sc is None or closes[s][t] is None or opens[s][entry] is None:
                continue
            px, was_forced = _exit_price(panel, s, entry, exit_)
            if px is None:
                continue
            fr = math.fsum(f for f in funding[s][entry:exit_] if f is not None)
            cand.append((s, sc, px / opens[s][entry] - 1.0, fr, was_forced))
        if len(cand) < hyp["min_symbols"]:
            t += h
            continue
        w = {}
        if hyp["mode"] == "cross_section":
            ranked = sorted(cand, key=lambda c: (c[1], c[0]))
            k = max(1, int(hyp["quantile"] * len(ranked)))
            for c in ranked[-k:]:
                w[c[0]] = 0.5 / k
            for c in ranked[:k]:
                w[c[0]] = w.get(c[0], 0.0) - 0.5 / k
        else:
            m = len(cand)
            for c in cand:
                if c[1] > 0:
                    w[c[0]] = 1.0 / m
                elif c[1] < 0:
                    w[c[0]] = -1.0 / m
        info = {c[0]: c for c in cand}
        gross = math.fsum(wt * info[s][2] for s, wt in w.items())
        fund = -math.fsum(wt * info[s][3] for s, wt in w.items())
        turnover = math.fsum(abs(w.get(s, 0.0) - prev_w.get(s, 0.0)) for s in set(w) | set(prev_w))
        forced += sum(1 for s in w if info[s][4])
        ic = _spearman([c[1] for c in cand], [c[2] for c in cand])
        periods.append({"t": t, "gross": gross, "funding": fund, "turnover": turnover, "ic": ic, "n": len(cand)})
        prev_w = w
        t += h
    if periods:  # liquidate at the end
        periods[-1]["turnover"] += math.fsum(abs(x) for x in prev_w.values())
    for p in periods:
        p["net"] = {str(c): p["gross"] + p["funding"] - p["turnover"] * c / 1e4 for c in costs_bp}
    return {"periods": periods, "forced_exits": forced, "periods_per_year": MS_PER_YEAR / (panel.bar_ms * h)}


# ------------------------------------------------------------- statistics

ND = NormalDist()
EULER_GAMMA = 0.5772156649015329


def moments(xs):
    n = len(xs)
    mu = math.fsum(xs) / n
    var = math.fsum((x - mu) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    if sd < EPS:
        return mu, sd, 0.0, 3.0
    skew = math.fsum(((x - mu) / sd) ** 3 for x in xs) / n
    kurt = math.fsum(((x - mu) / sd) ** 4 for x in xs) / n
    return mu, sd, skew, kurt


def mde_sharpe(n: int, alpha=0.05, power=0.8) -> float:
    """Smallest per-period Sharpe a two-sided test detects with the given power."""
    if n < 2:
        return math.inf
    return (ND.inv_cdf(1 - alpha / 2) + ND.inv_cdf(power)) / math.sqrt(n)


def periods_needed(target_sharpe_per_period: float, alpha=0.05, power=0.8) -> int:
    z = ND.inv_cdf(1 - alpha / 2) + ND.inv_cdf(power)
    return math.ceil((z / target_sharpe_per_period) ** 2)


def expected_max_sharpe(n_trials: int, var_sr: float) -> float:
    """Expected maximum per-period Sharpe among n_trials null strategies."""
    if n_trials <= 1:
        return 0.0
    return math.sqrt(var_sr) * ((1 - EULER_GAMMA) * ND.inv_cdf(1 - 1 / n_trials)
                                + EULER_GAMMA * ND.inv_cdf(1 - 1 / (n_trials * math.e)))


def deflated_sharpe(sr: float, n_obs: int, skew: float, kurt: float, n_trials: int, var_sr: float) -> float:
    """Probability that the true Sharpe exceeds the best expected under n_trials nulls."""
    if n_obs < 3:
        return 0.0
    sr0 = expected_max_sharpe(n_trials, var_sr)
    denom = 1 - skew * sr + (kurt - 1) / 4 * sr * sr
    if denom <= EPS:
        denom = EPS
    return ND.cdf((sr - sr0) * math.sqrt(n_obs - 1) / math.sqrt(denom))


def block_bootstrap_mean(xs, draws=2000, seed=40, block=None):
    n = len(xs)
    if n < 2:
        return None, None
    block = block or max(1, round(n ** (1 / 3)))
    rng = random.Random(seed)
    means = []
    for _ in range(draws):
        sample = []
        while len(sample) < n:
            start = rng.randrange(n)
            sample.extend(xs[(start + j) % n] for j in range(block))
        means.append(math.fsum(sample[:n]) / n)
    means.sort()
    return means[int(0.025 * draws)], means[int(0.975 * draws) - 1]


def max_drawdown(xs):
    peak, cum, dd = 0.0, 0.0, 0.0
    for x in xs:
        cum += x
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return dd


def summarize(sim: dict, costs_bp, gate_cost, folds: int) -> dict:
    periods = sim["periods"]
    n = len(periods)
    ppy = sim["periods_per_year"]
    out = {"periods": n, "periods_per_year": ppy, "forced_exits": sim["forced_exits"]}
    if n < 2:
        return out
    by_cost = {}
    for c in costs_bp:
        xs = [p["net"][str(c)] for p in periods]
        mu, sd, skew, kurt = moments(xs)
        sr = mu / sd if sd > EPS else 0.0
        by_cost[str(c)] = {
            "mean_bp": mu * 1e4,
            "std_bp": sd * 1e4,
            "sharpe_period": sr,
            "sharpe_annual": sr * math.sqrt(ppy),
            "t_stat": sr * math.sqrt(n),
            "skew": skew,
            "kurtosis": kurt,
            "hit_rate": sum(1 for x in xs if x > 0) / n,
            "max_drawdown_bp": max_drawdown(xs) * 1e4,
        }
    out["by_cost_bp_per_side"] = by_cost
    gate = [p["net"][str(gate_cost)] for p in periods]
    lo, hi = block_bootstrap_mean(gate)
    out["gate_mean_bp_ci95_block_bootstrap"] = [lo * 1e4, hi * 1e4]
    out["gross_mean_bp"] = math.fsum(p["gross"] for p in periods) / n * 1e4
    out["funding_mean_bp"] = math.fsum(p["funding"] for p in periods) / n * 1e4
    out["turnover_mean"] = math.fsum(p["turnover"] for p in periods) / n
    ics = [p["ic"] for p in periods if p["ic"] is not None]
    if len(ics) >= 2:
        mu, sd, _, _ = moments(ics)
        out["ic_mean"] = mu
        out["ic_t_stat"] = mu / sd * math.sqrt(len(ics)) if sd > EPS else 0.0
    out["symbols_per_period_mean"] = math.fsum(p["n"] for p in periods) / n
    size = math.ceil(n / folds)
    fold_rows = []
    for k in range(folds):
        chunk = periods[k * size:(k + 1) * size]
        if not chunk:
            continue
        fi = [p["ic"] for p in chunk if p["ic"] is not None]
        fold_rows.append({
            "periods": len(chunk),
            "net_mean_bp": math.fsum(p["net"][str(gate_cost)] for p in chunk) / len(chunk) * 1e4,
            "ic_mean": math.fsum(fi) / len(fi) if fi else None,
        })
    out["folds"] = fold_rows
    mde = mde_sharpe(n)
    out["power"] = {
        "mde_sharpe_period": mde,
        "mde_sharpe_annual": mde * math.sqrt(ppy),
    }
    return out


# ---------------------------------------------------------- config/ledger

DEFAULT_GATE = {
    "costs_bp_per_side": [0, 3, 6, 10],
    "gate_cost_bp_per_side": 6,
    "dsr_min": 0.95,
    "folds": 4,
    "folds_positive_min": 3,
    "min_periods": 30,
    "target_sharpe_annual": 2.0,
    "holdout_budget": 3,
    "holdout_alpha": 0.05,
    "prior_trials": 0,
}


def freeze_config(panel: Panel, holdout_frac: float, out: Path, gate_overrides: dict | None = None) -> dict:
    if not 0.05 <= holdout_frac <= 0.5:
        raise ValueError("holdout fraction must be in [0.05, 0.5]")
    b = int(panel.T * (1 - holdout_frac))
    gate = dict(DEFAULT_GATE)
    gate.update(gate_overrides or {})
    cfg = {
        "schema": SCHEMA_CONFIG,
        "version": VERSION,
        "panel_sha256": panel.sha,
        "bar_ms": panel.bar_ms,
        "symbols": panel.symbols,
        "panel_start_ts": panel.times[0],
        "panel_end_ts": panel.times[-1],
        "holdout_start_ts": panel.times[b],
        "holdout_start_utc": utc_iso(panel.times[b]),
        "gate": gate,
        "frozen_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_exclusive(out, cfg)
    return cfg


def load_config(path, panel: Panel) -> tuple[dict, int]:
    cfg = json.loads(Path(path).read_text())
    if cfg.get("schema") != SCHEMA_CONFIG:
        raise ValueError("bad config schema")
    if cfg["panel_sha256"] != panel.sha:
        raise ValueError("panel SHA differs from the frozen config; refuse to evaluate")
    b = panel.times.index(cfg["holdout_start_ts"])
    return cfg, b


def read_ledger(path) -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def append_ledger(path, entry: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "ab") as fh:
        fh.write(canonical(entry) + b"\n")
        fh.flush()
        os.fsync(fh.fileno())


def trial_stats(ledger: list[dict], panel_sha: str, current_sha: str, current_sr: float, gate_cost) -> tuple[int, list[float]]:
    srs = {}
    for e in ledger:
        if e.get("region") == "development" and e.get("panel_sha256") == panel_sha and e.get("sharpe_period_gate") is not None:
            srs[e["hypothesis_sha256"]] = e["sharpe_period_gate"]
    srs[current_sha] = current_sr
    return len(srs), list(srs.values())


# ------------------------------------------------------------- verdicts

def evaluate_development(panel: Panel, cfg: dict, boundary: int, hyp: dict, ledger_path) -> dict:
    gate = cfg["gate"]
    dev = panel.truncated(boundary)  # holdout bars do not exist for this computation
    sim = simulate(dev, hyp, first_entry=1, last_exit=boundary - 1, costs_bp=gate["costs_bp_per_side"])
    summary = summarize(sim, gate["costs_bp_per_side"], gate["gate_cost_bp_per_side"], gate["folds"])
    hsha = hypothesis_sha(hyp)
    report = {
        "bench": VERSION,
        "region": "development",
        "hypothesis": hyp,
        "hypothesis_sha256": hsha,
        "panel_sha256": panel.sha,
        "development_end_utc": utc_iso(panel.times[boundary]),
        "summary": summary,
    }
    n = summary["periods"]
    if n < gate["min_periods"] or "by_cost_bp_per_side" not in summary:
        report["verdict"] = "INSUFFICIENT_DATA"
        report["sharpe_period_gate"] = None
    else:
        g = summary["by_cost_bp_per_side"][str(gate["gate_cost_bp_per_side"])]
        ledger = read_ledger(ledger_path)
        n_trials, srs = trial_stats(ledger, panel.sha, hsha, g["sharpe_period"], gate["gate_cost_bp_per_side"])
        n_trials_total = n_trials + int(gate.get("prior_trials", 0))
        var_trials = moments(srs)[1] ** 2 if len(srs) >= 2 else 0.0
        var_sr = max(var_trials, 1.0 / max(n - 1, 1))
        dsr = deflated_sharpe(g["sharpe_period"], n, g["skew"], g["kurtosis"], n_trials_total, var_sr)
        folds_pos = sum(1 for f in summary["folds"] if f["net_mean_bp"] > 0)
        ic_ok = summary.get("ic_mean", 0) > 0
        report["selection"] = {
            "trials_counted": n_trials_total,
            "var_sharpe_used": var_sr,
            "expected_max_null_sharpe_period": expected_max_sharpe(n_trials_total, var_sr),
            "deflated_sharpe": dsr,
            "folds_positive": folds_pos,
            "ic_positive": ic_ok,
        }
        report["sharpe_period_gate"] = g["sharpe_period"]
        powered = summary["power"]["mde_sharpe_annual"] <= gate["target_sharpe_annual"]
        if dsr >= gate["dsr_min"] and folds_pos >= gate["folds_positive_min"] and ic_ok:
            report["verdict"] = "PASS_DEV"
        elif g["mean_bp"] <= 0 or powered:
            report["verdict"] = "REJECT"
        else:
            report["verdict"] = "INCONCLUSIVE_UNPOWERED"
        report["power_note"] = (
            f"{n} periods detect annual Sharpe >= {summary['power']['mde_sharpe_annual']:.2f} "
            f"with 80% power; target {gate['target_sharpe_annual']}"
        )
    append_ledger(ledger_path, {
        "time_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "region": "development",
        "hypothesis_id": hyp["id"],
        "author": hyp["author"],
        "hypothesis_sha256": hsha,
        "panel_sha256": panel.sha,
        "periods": n,
        "sharpe_period_gate": report["sharpe_period_gate"],
        "verdict": report["verdict"],
    })
    return report


def evaluate_holdout(panel: Panel, cfg: dict, boundary: int, hyp: dict, ledger_path, claims_dir) -> dict:
    gate = cfg["gate"]
    hsha = hypothesis_sha(hyp)
    ledger = read_ledger(ledger_path)
    passed = [e for e in ledger if e.get("hypothesis_sha256") == hsha and e.get("panel_sha256") == panel.sha
              and e.get("region") == "development" and e.get("verdict") == "PASS_DEV"]
    if not passed:
        raise PermissionError("holdout requires a recorded PASS_DEV for this exact hypothesis and panel")
    claims = Path(claims_dir)
    claims.mkdir(parents=True, exist_ok=True)
    used = sorted(claims.glob("*.claim.json"))
    if len(used) >= gate["holdout_budget"]:
        raise PermissionError(f"holdout budget of {gate['holdout_budget']} claims is exhausted")
    claim = claims / f"{hsha}.claim.json"
    try:
        write_exclusive(claim, {"hypothesis_sha256": hsha, "panel_sha256": panel.sha,
                                "claimed_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    except FileExistsError as exc:
        raise PermissionError("this hypothesis already used its single holdout claim") from exc
    sim = simulate(panel, hyp, first_entry=boundary, last_exit=panel.T - 1, costs_bp=gate["costs_bp_per_side"])
    summary = summarize(sim, gate["costs_bp_per_side"], gate["gate_cost_bp_per_side"], gate["folds"])
    report = {"bench": VERSION, "region": "holdout", "hypothesis": hyp, "hypothesis_sha256": hsha,
              "panel_sha256": panel.sha, "summary": summary}
    if summary["periods"] < 2 or "by_cost_bp_per_side" not in summary:
        report["verdict"] = "HOLDOUT_INSUFFICIENT_DATA"
    else:
        g = summary["by_cost_bp_per_side"][str(gate["gate_cost_bp_per_side"])]
        p_one_sided = 1 - ND.cdf(g["t_stat"])
        report["p_value_one_sided"] = p_one_sided
        ok = p_one_sided < gate["holdout_alpha"] and summary.get("ic_mean", 0) > 0
        report["verdict"] = "PASS_HOLDOUT" if ok else "FAIL_HOLDOUT"
    append_ledger(ledger_path, {
        "time_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "region": "holdout", "hypothesis_id": hyp["id"], "author": hyp["author"],
        "hypothesis_sha256": hsha, "panel_sha256": panel.sha,
        "periods": summary["periods"], "verdict": report["verdict"],
    })
    return report


# --------------------------------------------------------- synthetic data

def synthesize(symbols=30, bars=3000, seed=1, plant=0.0, bar_ms=3_600_000, start_ms=1_767_225_600_000) -> str:
    """Synthetic hourly perp panel. Funding settles every 8 bars.

    With plant > 0 the next bar's idiosyncratic return loads on minus the
    cross-sectional z-score of the last settled funding rate:
    contrarian-to-crowding. plant is that loading in units of idio vol.
    """
    rng = random.Random(seed)
    syms = [f"SYN{i:02d}-USDT-SWAP" for i in range(symbols)]
    price = {s: 10 * math.exp(rng.gauss(0, 1)) for s in syms}
    beta = {s: 0.7 + 0.6 * rng.random() for s in syms}
    latent = {s: rng.gauss(1e-4, 2e-4) for s in syms}
    last_settled = dict(latent)
    oi = {s: 1e6 * (1 + rng.random()) for s in syms}
    sig_m, sig_i = 0.006, 0.008
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["ts", "symbol", "open", "high", "low", "close", "volume", "funding", "oi"])
    for t in range(bars):
        m = rng.gauss(0, sig_m)
        vals = list(last_settled.values())
        mu = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / (len(vals) - 1)) or 1.0
        for s in syms:
            latent[s] = 1e-4 + 0.98 * (latent[s] - 1e-4) + rng.gauss(0, 4e-5)
            drift = -plant * sig_i * (last_settled[s] - mu) / sd
            r = beta[s] * m + rng.gauss(drift, sig_i)
            o = price[s]
            c = o * math.exp(r)
            hi = max(o, c) * math.exp(abs(rng.gauss(0, 0.002)))
            lo = min(o, c) * math.exp(-abs(rng.gauss(0, 0.002)))
            price[s] = c
            oi[s] *= math.exp(rng.gauss(0, 0.01))
            fund = ""
            if t % 8 == 7:
                last_settled[s] = latent[s]
                fund = f"{latent[s]:.8f}"
            w.writerow([start_ms + t * bar_ms, s, f"{o:.8g}", f"{hi:.8g}", f"{lo:.8g}", f"{c:.8g}",
                        f"{abs(rng.gauss(1000, 300)):.4f}", fund, f"{oi[s]:.2f}"])
    return buf.getvalue()


# ------------------------------------------------------------------- CLI

def _cmd_power(args):
    ppy = args.periods_per_year
    per = args.target_sharpe_annual / math.sqrt(ppy)
    need = periods_needed(per)
    print(json.dumps({
        "target_sharpe_annual": args.target_sharpe_annual,
        "periods_per_year": ppy,
        "periods_needed_80pct_power": need,
        "years_needed": need / ppy,
        "mde_sharpe_annual_at_n": mde_sharpe(args.n) * math.sqrt(ppy) if args.n else None,
    }, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Rakazo Algorithm Bench v40 (research only, no orders)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("synth"); p.add_argument("--out", required=True); p.add_argument("--symbols", type=int, default=30)
    p.add_argument("--bars", type=int, default=3000); p.add_argument("--seed", type=int, default=1); p.add_argument("--plant", type=float, default=0.0)
    p = sub.add_parser("audit"); p.add_argument("--panel", required=True)
    p = sub.add_parser("freeze"); p.add_argument("--panel", required=True); p.add_argument("--out", required=True)
    p.add_argument("--holdout-frac", type=float, default=0.25); p.add_argument("--prior-trials", type=int, default=0)
    for name in ("evaluate", "holdout"):
        p = sub.add_parser(name)
        p.add_argument("--panel", required=True); p.add_argument("--config", required=True)
        p.add_argument("--hyp", required=True); p.add_argument("--ledger", required=True)
        p.add_argument("--out", required=True)
        if name == "holdout":
            p.add_argument("--claims", required=True); p.add_argument("--id", required=True)
    p = sub.add_parser("power"); p.add_argument("--target-sharpe-annual", type=float, default=1.0)
    p.add_argument("--periods-per-year", type=float, required=True); p.add_argument("--n", type=int, default=0)
    args = ap.parse_args(argv)

    if args.cmd == "synth":
        Path(args.out).write_text(synthesize(args.symbols, args.bars, args.seed, args.plant))
        return
    if args.cmd == "power":
        _cmd_power(args)
        return
    panel = load_panel(args.panel)
    if args.cmd == "audit":
        print(json.dumps(audit_panel(panel), indent=1))
        return
    if args.cmd == "freeze":
        cfg = freeze_config(panel, args.holdout_frac, Path(args.out), {"prior_trials": args.prior_trials})
        print(json.dumps({k: cfg[k] for k in ("panel_sha256", "holdout_start_utc")}, indent=1))
        return
    cfg, boundary = load_config(args.config, panel)
    hyps = read_hypotheses(args.hyp)
    out = Path(args.out)
    if args.cmd == "evaluate":
        reports = [evaluate_development(panel, cfg, boundary, h, args.ledger) for h in hyps]
        write_exclusive(out, {"reports": reports})
        for r in reports:
            print(f"{r['hypothesis']['id']:40s} {r['verdict']}")
    else:
        hyp = next((h for h in hyps if h["id"] == args.id), None)
        if hyp is None:
            raise SystemExit(f"no hypothesis with id {args.id}")
        r = evaluate_holdout(panel, cfg, boundary, hyp, args.ledger, args.claims)
        write_exclusive(out, r)
        print(f"{hyp['id']} {r['verdict']}")


if __name__ == "__main__":
    main()
