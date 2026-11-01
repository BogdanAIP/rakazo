"""Algorithm Bench v40: one fixed evaluation harness for typed trading hypotheses.

Purpose: replace per-version ad-hoc experiments with a single verifier that
any agent (GPT, Claude or a human) submits typed JSON hypotheses into.

Design rules
- Hypotheses are typed JSON expression trees. Nothing is eval'd or exec'd.
- Every operator only reads values at or before the decision bar, so the
  score at bar t is identical whether or not later bars exist (tested).
- The traded cohort is fixed from decision-time information only: score,
  eligibility and close at bar t. Whether a symbol later trades, delists or
  disappears never affects who is ranked (tested).
- A position whose exit bar is missing is closed at its last observed price
  minus a conservative penalty; missing funding observations are counted and
  gate the verdict instead of silently becoming zero.
- Development evaluation physically truncates the panel before the frozen
  holdout boundary; holdout data cannot influence a development report.
- Every development evaluation is appended to a ledger. The deflated Sharpe
  ratio (Bailey & Lopez de Prado, 2014) uses the number of distinct trials,
  so trying many ideas raises the bar for each one.
- A failed test is only REJECT when it had power for the target effect or a
  non-positive mean; otherwise it is INCONCLUSIVE_UNPOWERED.
- The holdout needs a PASS_DEV, a sign-off file from a reviewer other than the
  author, and is one-use per hypothesis within a global budget. The sign-off
  is a procedural check, not a cryptographic one.
- Research only: this module never places orders or touches accounts.

Stdlib only. Python 3.10+. Series are array('d') with NaN for missing.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import hashlib
import json
import math
import os
import random
import re
from array import array
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import NormalDist

SCHEMA_HYP = "rakazo_bench_hypothesis_v1"
SCHEMA_CONFIG = "rakazo_bench_config_v1"
VERSION = "bench-v40.6"

MAX_DEPTH = 8
MAX_NODES = 64
MAX_WINDOW = 2160
MAX_HYPOTHESES_PER_FILE = 32
MAX_HYP_FILE_BYTES = 65_536
EPS = 1e-12
NAN = float("nan")
BIG = 1e300
MS_PER_DAY = 86_400_000
MS_PER_YEAR = 365.25 * MS_PER_DAY
REVIEWERS = ("claude", "gpt", "human")

PRICE_FIELDS = ("open", "high", "low", "close", "volume")
FEATURE_FIELDS = ("open", "high", "low", "close", "volume", "oi", "funding", "ret", "range")
SYMBOL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,39}")
ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")

# op -> (kind, arity of expression children)
OPS = {
    "field": ("leaf", 0), "const": ("leaf", 0),
    "neg": ("unary", 1), "abs": ("unary", 1), "sign": ("unary", 1), "tanh": ("unary", 1), "log1p": ("unary", 1),
    "add": ("binary", 2), "sub": ("binary", 2), "mul": ("binary", 2), "div": ("binary", 2),
    "max": ("binary", 2), "min": ("binary", 2),
    "clip": ("clip", 1),
    "lag": ("window", 1), "delta": ("window", 1), "pct": ("window", 1), "sum": ("window", 1),
    "mean": ("window", 1), "std": ("window", 1), "z": ("window", 1), "ema": ("window", 1), "tsrank": ("window", 1),
    "csrank": ("cross", 1), "csz": ("cross", 1), "csdemean": ("cross", 1),
}


# ---------------------------------------------------------------- utilities

def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def utc_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def nan_array(n: int, typecode: str = "d") -> array:
    return array(typecode, [NAN]) * n


def _clean(values) -> array:
    """Finite values pass through; NaN, inf and overflow become the NaN constant."""
    return array("d", [v if -BIG < v < BIG else NAN for v in values])


def write_exclusive(path: Path, payload: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as fh:
        fh.write(json.dumps(payload, indent=1, sort_keys=True).encode())
        fh.flush()
        os.fsync(fh.fileno())


# -------------------------------------------------------------------- panel

class Panel:
    """Aligned bar panel.

    series[f][sym]  NaN = no row; f in open/high/low/close/volume/oi/funding. OHLCV are
                    stored as float32 (relative error ~6e-8, far below a basis point; all
                    arithmetic is float64), funding and oi as float64. Columns absent from
                    the file share one read-only NaN array.
                    funding holds the settled rate, 0.0 for a known non-settlement bar,
                    NaN when the funding state is unknown or the row is missing.
    settled[sym]    bytearray, 1 where a funding settlement happened.
    eligible[sym]   bytearray, 1 where the symbol may enter the decision cohort.
    """

    def __init__(self, times, symbols, series, settled, eligible, bar_ms, sha):
        self.times = times
        self.symbols = symbols
        self.series = series
        self.settled = settled
        self.eligible = eligible
        self.bar_ms = bar_ms
        self.sha = sha

    @property
    def T(self) -> int:
        return len(self.times)

    def truncated(self, end: int) -> "Panel":
        """Bars [0, end) only. Used to make the holdout physically absent."""
        cut: dict = {}  # keep shared arrays shared
        series = {f: {s: cut.setdefault(id(v), v[:end]) for s, v in d.items()} for f, d in self.series.items()}
        return Panel(self.times[:end], self.symbols, series,
                     {s: v[:end] for s, v in self.settled.items()},
                     {s: v[:end] for s, v in self.eligible.items()}, self.bar_ms, self.sha)


def _num(text, name, line, allow_empty=True):
    if text == "" and allow_empty:
        return NAN
    try:
        value = float(text)
    except ValueError as exc:
        raise ValueError(f"line {line}: {name} is not a number") from exc
    if not math.isfinite(value):
        raise ValueError(f"line {line}: {name} is not finite")
    return value


def _csv_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if not header:
            raise ValueError("panel is empty")
        col = {name: i for i, name in enumerate(header)}
        missing = {"ts", "symbol", *PRICE_FIELDS} - set(col)
        if missing:
            raise ValueError(f"panel missing columns: {sorted(missing)}")
        yield col
        for line, row in enumerate(reader, start=2):
            if len(row) != len(header):
                raise ValueError(f"line {line}: expected {len(header)} fields")
            yield line, row


def load_panel(path, tradable_only: bool = False) -> Panel:
    """Read the panel CSV in two streaming passes.

    tradable_only drops symbols that are never eligible. They can never enter a cohort,
    and cross-sectional operators only use eligible symbols, so evaluation results are
    unchanged; it only saves memory. The audit loads every symbol.

    Columns: ts,symbol,open,high,low,close,volume[,eligible][,funding][,oi]
    ts       bar OPEN time, integer ms UTC, on one fixed grid
    eligible 1 or 0: may the symbol enter the cohort at this bar (absent column = 1)
    funding  rate settled during this bar; empty = no settlement; NA = unknown
    oi       open interest at bar close; empty = unknown
    A missing row means no market data for that symbol and bar.
    """
    sha_before = sha256_file(path)
    rows = _csv_rows(path)
    col = next(rows)
    stamps, symbols, ever_eligible = set(), set(), set()
    c_el = col.get("eligible")
    for line, row in rows:
        if c_el is None or row[c_el] == "1":
            ever_eligible.add(row[col["symbol"]])
        if not SYMBOL_RE.fullmatch(row[col["symbol"]]):
            raise ValueError(f"line {line}: bad symbol")
        try:
            stamps.add(int(row[col["ts"]]))
        except ValueError as exc:
            raise ValueError(f"line {line}: ts must be integer ms") from exc
        symbols.add(row[col["symbol"]])
    if not stamps:
        raise ValueError("panel is empty")
    ordered = sorted(stamps)
    if len(ordered) < 2:
        raise ValueError("panel needs at least two bars")
    diffs = Counter(b - a for a, b in zip(ordered, ordered[1:]))
    bar_ms = max(diffs, key=lambda d: (diffs[d], -d))  # most common step; gaps are multiples of it
    if bar_ms <= 0 or any((t - ordered[0]) % bar_ms for t in ordered):
        raise ValueError("timestamps are not on one fixed grid")
    t0 = ordered[0]
    T = (ordered[-1] - t0) // bar_ms + 1
    times = [t0 + i * bar_ms for i in range(T)]
    symbols = sorted(ever_eligible if tradable_only else symbols)
    keep = set(symbols)
    del stamps, ordered
    shared_nan = nan_array(T)
    series = {f: {s: nan_array(T, "f") for s in symbols} for f in PRICE_FIELDS}
    for f in ("oi", "funding"):
        series[f] = {s: (nan_array(T) if f in col else shared_nan) for s in symbols}
    settled = {s: bytearray(T) for s in symbols}
    eligible = {s: bytearray(T) for s in symbols}
    ci = [col[f] for f in PRICE_FIELDS]
    c_fu, c_oi = col.get("funding"), col.get("oi")
    rows = _csv_rows(path)
    next(rows)
    for line, row in rows:
        sym = row[col["symbol"]]
        if sym not in keep:
            continue
        i = (int(row[col["ts"]]) - t0) // bar_ms
        if series["close"][sym][i] == series["close"][sym][i]:
            raise ValueError(f"line {line}: duplicate bar {sym} {row[col['ts']]}")
        o, h, l, c, v = (_num(row[k], f, line, allow_empty=False) for k, f in zip(ci, PRICE_FIELDS))
        if min(o, h, l, c) <= 0 or v < 0:
            raise ValueError(f"line {line}: non-positive price or negative volume")
        if h + EPS < max(o, c, l) or l - EPS > min(o, c, h):
            raise ValueError(f"line {line}: inconsistent high/low")
        for f, x in zip(PRICE_FIELDS, (o, h, l, c, v)):
            series[f][sym][i] = x
        if c_el is None:
            eligible[sym][i] = 1
        else:
            flag = row[c_el]
            if flag not in ("0", "1"):
                raise ValueError(f"line {line}: eligible must be 0 or 1")
            eligible[sym][i] = flag == "1"
        if c_fu is not None:
            cell = row[c_fu]
            if cell == "NA":
                series["funding"][sym][i] = NAN
            elif cell == "":
                series["funding"][sym][i] = 0.0
            else:
                series["funding"][sym][i] = _num(cell, "funding", line)
                settled[sym][i] = 1
        if c_oi is not None and row[c_oi] != "":
            series["oi"][sym][i] = _num(row[c_oi], "oi", line)
    if sha256_file(path) != sha_before:
        raise ValueError("panel file changed while it was being read")
    return Panel(times, symbols, series, settled, eligible, bar_ms, sha_before)


def recompute_eligibility(panel: Panel, usd: float, days: int = 30) -> dict:
    """Eligibility implied by trailing median daily quote volume of strictly earlier
    UTC days (days without rows count as zero). Returns {symbol: {day_index: 0/1}}."""
    day0 = panel.times[0] // MS_PER_DAY
    n_days = panel.times[-1] // MS_PER_DAY - day0 + 1
    out = {}
    for s in panel.symbols:
        vol, close = panel.series["volume"][s], panel.series["close"][s]
        daily = [0.0] * n_days
        for i, t in enumerate(panel.times):
            if close[i] == close[i]:
                daily[t // MS_PER_DAY - day0] += vol[i]
        # An instrument listed midway through the panel cannot satisfy a
        # full 30-day point-in-time observation history merely because a
        # global panel has already accumulated 30 days.
        first_traded = next((t // MS_PER_DAY - day0 for i, t in enumerate(panel.times)
                             if close[i] == close[i]), n_days)
        flags = {}
        for d in range(n_days):
            if d < days or d < first_traded + days:
                flags[d] = 0
                continue
            window = sorted(daily[d - days:d])
            mid = days // 2
            med = window[mid] if days % 2 else (window[mid - 1] + window[mid]) / 2
            flags[d] = int(med >= usd)
        out[s] = flags
    return out


def audit_panel(panel: Panel, expect_bar_ms: int | None = None, eligibility_usd: float | None = None,
                eligibility_days: int = 30) -> dict:
    present = {s: sum(1 for x in panel.series["close"][s] if x == x) for s in panel.symbols}
    total_present = sum(present.values())
    empty_bars = sum(1 for i in range(panel.T) if all(panel.series["close"][s][i] != panel.series["close"][s][i]
                                                      for s in panel.symbols))
    unknown_funding = sum(1 for s in panel.symbols for c, f in zip(panel.series["close"][s], panel.series["funding"][s])
                          if c == c and f != f)
    out = {
        "bench": VERSION,
        "panel_sha256": panel.sha,
        "bar_ms": panel.bar_ms,
        "bar_ms_matches_expected": None if expect_bar_ms is None else panel.bar_ms == expect_bar_ms,
        "bars": panel.T,
        "start": utc_iso(panel.times[0]),
        "end_bar_open": utc_iso(panel.times[-1]),
        "symbols": len(panel.symbols),
        "rows": total_present,
        "bars_present_min": min(present.values()),
        "bars_present_max": max(present.values()),
        "fully_empty_bars": empty_bars,
        "eligible_rows": sum(sum(v) for v in panel.eligible.values()),
        "funding_unknown_row_share": unknown_funding / total_present if total_present else None,
        "symbols_without_any_settlement": sorted(s for s in panel.symbols if not any(panel.settled[s])),
        "symbols_with_oi": sum(1 for s in panel.symbols if any(x == x for x in panel.series["oi"][s])),
    }
    if eligibility_usd is not None:
        implied = recompute_eligibility(panel, eligibility_usd, eligibility_days)
        day0 = panel.times[0] // MS_PER_DAY
        bad_rows, bad_days = 0, set()
        for s in panel.symbols:
            close, elig = panel.series["close"][s], panel.eligible[s]
            for i, t in enumerate(panel.times):
                if close[i] == close[i]:
                    d = t // MS_PER_DAY - day0
                    if elig[i] != implied[s][d]:
                        bad_rows += 1
                        bad_days.add((s, d))
        out["eligibility_check"] = {
            "rule": f"median daily quote volume over {eligibility_days} earlier UTC days >= {eligibility_usd:g}",
            "assumes_volume_is_quote_currency": True,
            "mismatched_rows": bad_rows,
            "mismatched_symbol_days": len(bad_days),
        }
    return out


# --------------------------------------------------------------- hypotheses

def _count_nodes(node, depth=1):
    if depth > MAX_DEPTH:
        raise ValueError("expression too deep")
    if not isinstance(node, list) or not node or not isinstance(node[0], str):
        raise ValueError("expression nodes must be non-empty lists starting with an operator")
    op = node[0]
    if op not in OPS:
        raise ValueError(f"unknown operator {op!r}")
    kind, arity = OPS[op]
    if op == "field":
        if len(node) != 2 or node[1] not in FEATURE_FIELDS:
            raise ValueError(f"field must name one of {FEATURE_FIELDS}")
        return 1
    if op == "const":
        if len(node) != 2 or not _finite(node[1]):
            raise ValueError("const needs one finite number")
        return 1
    if kind == "clip":
        if len(node) != 3 or not _finite(node[2]) or node[2] <= 0:
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
    allowed = {"id", "author", "rationale", "score", "mode", "horizon_bars", "rebalance_bars", "quantile", "min_symbols"}
    if not isinstance(rec, dict) or not set(rec) <= allowed or not {"id", "score", "horizon_bars"} <= set(rec):
        raise ValueError("hypothesis needs id, score, horizon_bars and only known fields")
    if not isinstance(rec["id"], str) or not ID_RE.fullmatch(rec["id"]):
        raise ValueError("bad hypothesis id")
    if _count_nodes(rec["score"]) > MAX_NODES:
        raise ValueError("expression has too many nodes")
    h = rec["horizon_bars"]
    if isinstance(h, bool) or not isinstance(h, int) or not 1 <= h <= 2160:
        raise ValueError("horizon_bars must be an integer in 1..2160")
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
    if "rebalance_bars" in rec:
        r = rec["rebalance_bars"]
        if isinstance(r, bool) or not isinstance(r, int) or not 1 <= r <= h or h % r:
            raise ValueError("rebalance_bars must be an integer that divides horizon_bars")
        out["rebalance_bars"] = r
    if out["mode"] not in ("cross_section", "time_series"):
        raise ValueError("mode must be cross_section or time_series")
    if not _finite(out["quantile"]) or not 0 < out["quantile"] <= 0.5:
        raise ValueError("quantile must be in (0, 0.5]")
    m = out["min_symbols"]
    if isinstance(m, bool) or not isinstance(m, int) or not 2 <= m <= 1000:
        raise ValueError("min_symbols must be an integer in 2..1000")
    return out


def hypothesis_sha(h: dict) -> str:
    """Identity of the testable rule; rationale/author/id do not change it."""
    core = {k: h[k] for k in ("score", "mode", "horizon_bars", "quantile", "min_symbols", "rebalance_bars") if k in h}
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

def _rolling_stats(xs, n):
    """Trailing-window sum, mean and sample std. Any NaN in the window gives NaN.
    Running sums around a reference value, resynchronised exactly every n steps."""
    T = len(xs)
    s_out, m_out, sd_out = nan_array(T), nan_array(T), nan_array(T)
    bad = 0
    valid_prev = False
    since = 0
    ref = s1 = s2 = 0.0
    for t in range(T):
        x = xs[t]
        if x != x:
            bad += 1
        if t >= n and xs[t - n] != xs[t - n]:
            bad -= 1
        if bad or t < n - 1:
            valid_prev = False
            continue
        if not valid_prev or since >= n:
            w = xs[t - n + 1:t + 1]
            ref = w[0]
            s1 = math.fsum(v - ref for v in w)
            s2 = math.fsum((v - ref) ** 2 for v in w)
            since = 0
        else:
            y = xs[t - n]
            s1 += (x - ref) - (y - ref)
            s2 += (x - ref) ** 2 - (y - ref) ** 2
            since += 1
        valid_prev = True
        mean_dev = s1 / n
        s_out[t] = ref * n + s1
        m_out[t] = ref + mean_dev
        if n > 1:
            var = (s2 - n * mean_dev * mean_dev) / (n - 1)
            sd_out[t] = math.sqrt(var) if var > 0 else 0.0
    return s_out, m_out, sd_out


def _tsrank(xs, n):
    T = len(xs)
    out = nan_array(T)
    win: list = []
    start = 0  # first index of the current NaN-free run
    for t in range(T):
        x = xs[t]
        if x != x:
            win = []
            start = t + 1
            continue
        bisect.insort(win, x)
        if t - n >= start:
            del win[bisect.bisect_left(win, xs[t - n])]
        if t - start + 1 >= n:
            lo, hi = bisect.bisect_left(win, x), bisect.bisect_right(win, x)
            out[t] = (lo + (hi - lo - 1) / 2) / (n - 1) - 0.5
    return out


def _ts_op(op, xs, n):
    T = len(xs)
    if op == "lag":
        return nan_array(min(n, T)) + array("d", xs[:max(T - n, 0)])
    if op == "delta":
        return _clean([xs[t] - xs[t - n] if t >= n else NAN for t in range(T)])
    if op == "pct":
        return _clean([xs[t] / xs[t - n] - 1 if t >= n and abs(xs[t - n]) > EPS else NAN for t in range(T)])
    if op == "ema":
        out, state, warm, alpha = nan_array(T), 0.0, 0, 2.0 / (n + 1)
        for t, x in enumerate(xs):
            if x != x:
                warm = 0
                continue
            state = x if warm == 0 else alpha * x + (1 - alpha) * state
            warm += 1
            if warm >= n:
                out[t] = state
        return out
    if op == "tsrank":
        return _tsrank(xs, n)
    s, m, sd = _rolling_stats(xs, n)
    if op == "sum":
        return _clean(s)
    if op == "mean":
        return _clean(m)
    if op == "std":
        return _clean(sd)
    return _clean([(x - mu) / d if d > EPS else NAN for x, mu, d in zip(xs, m, sd)])  # z


def _avg_ranks(values):
    order = sorted(range(len(values)), key=values.__getitem__)
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


def _cross_op(op, by_sym, symbols, T, eligible):
    """Cross-sectional transform at each bar over symbols that are eligible at that bar
    and have a value; everyone else gets NaN. Eligibility is known at t, so this is causal."""
    out = {s: nan_array(T) for s in symbols}
    cols = [by_sym[s] for s in symbols]
    elig = [eligible[s] for s in symbols]
    outs = [out[s] for s in symbols]
    for t in range(T):
        live = [k for k, c in enumerate(cols) if elig[k][t] and c[t] == c[t]]
        m = len(live)
        if m == 0:
            continue
        vals = [cols[k][t] for k in live]
        if op == "csrank":
            if m < 2:
                continue
            for k, r in zip(live, _avg_ranks(vals)):
                outs[k][t] = r / (m - 1) - 0.5
            continue
        mu = math.fsum(vals) / m
        if op == "csdemean":
            for k, v in zip(live, vals):
                outs[k][t] = v - mu
            continue
        if m < 3:
            continue
        sd = math.sqrt(math.fsum((v - mu) ** 2 for v in vals) / (m - 1))
        if sd < EPS:
            continue
        for k, v in zip(live, vals):
            outs[k][t] = (v - mu) / sd
    return out


def _base_feature(panel: Panel, name: str):
    s = panel.series
    if name in PRICE_FIELDS or name == "oi":
        return s[name]
    out = {}
    stale = max(1, MS_PER_DAY // panel.bar_ms)  # funding feature lifetime in bars
    for sym in panel.symbols:
        if name == "ret":
            c = s["close"][sym]
            out[sym] = _clean([math.log(c[t] / c[t - 1]) if t and c[t] == c[t] and c[t - 1] == c[t - 1] else NAN
                               for t in range(panel.T)])
        elif name == "range":
            h, l = s["high"][sym], s["low"][sym]
            out[sym] = _clean([math.log(a / b) if a == a else NAN for a, b in zip(h, l)])
        else:  # funding: last observed settlement before bar t, point in time only
            # A settlement assigned to bar t (the bar ending at T) is billed to positions held
            # through T, but archive clocks can lag T by seconds, so as a feature it becomes
            # available only at the next decision (t + 1). NA cells are NOT used here: the
            # builder infers them from later settlements (up to two days ahead), so letting
            # them reset the feature would leak future delistings or schedule changes into
            # today's cohort. Instead the rate expires once it is older than a day, or after
            # a bar without market data.
            raw, flag, close = s["funding"][sym], panel.settled[sym], s["close"][sym]
            seq, last, age = nan_array(panel.T), NAN, 0
            for t in range(panel.T):
                seq[t] = last if age <= stale else NAN
                age += 1
                if close[t] != close[t]:
                    last = NAN
                elif flag[t]:
                    last, age = raw[t], 1
            out[sym] = seq
    return out


def _unary(op):
    return {
        "neg": lambda x: -x,
        "abs": abs,
        "sign": lambda x: (x > 0) - (x < 0),
        "tanh": math.tanh,
        "log1p": lambda x: math.copysign(math.log1p(abs(x)), x),
    }[op]


def _binary(op):
    return {
        "add": lambda a, b: a + b,
        "sub": lambda a, b: a - b,
        "mul": lambda a, b: a * b,
        "div": lambda a, b: a / b if abs(b) > EPS else NAN,
        "max": max,
        "min": min,
    }[op]


def evaluate_expression(node, panel: Panel, cache=None):
    """Return {symbol: array of values, NaN = unavailable} using only past and current bars.
    Only leaf fields are cached, which keeps peak memory near tree depth x panel size."""
    cache = {} if cache is None else cache
    op = node[0]
    kind = OPS[op][0]
    syms, T = panel.symbols, panel.T
    if op == "field":
        if node[1] not in cache:
            cache[node[1]] = _base_feature(panel, node[1])
        return cache[node[1]]
    if op == "const":
        return {s: array("d", [float(node[1])]) * T for s in syms}
    if kind == "unary":
        x, f = evaluate_expression(node[1], panel, cache), _unary(op)
        return {s: _clean([f(v) if v == v else NAN for v in x[s]]) for s in syms}
    if kind == "binary":
        a = evaluate_expression(node[1], panel, cache)
        b = evaluate_expression(node[2], panel, cache)
        f = _binary(op)
        return {s: _clean([f(u, v) if u == u and v == v else NAN for u, v in zip(a[s], b[s])]) for s in syms}
    if kind == "clip":
        x, c = evaluate_expression(node[1], panel, cache), float(node[2])
        return {s: _clean([max(-c, min(c, v)) if v == v else NAN for v in x[s]]) for s in syms}
    x = evaluate_expression(node[1], panel, cache)
    if kind == "window":
        return {s: _ts_op(op, x[s], node[2]) for s in syms}
    return _cross_op(op, x, syms, T, panel.eligible)


# ------------------------------------------------------------- simulation

def _realized(panel: Panel, sym, entry, exit_):
    """Return (entry_price, exit_price, exit_missing) or None if not enterable.
    A missing exit bar closes at the last observed close in [entry, exit) or at entry."""
    o = panel.series["open"][sym][entry]
    if o != o:
        return None
    px = panel.series["open"][sym][exit_]
    if px == px:
        return o, px, False
    closes = panel.series["close"][sym]
    for j in range(exit_ - 1, entry - 1, -1):
        if closes[j] == closes[j]:
            return o, closes[j], True
    return o, o, True


def _spearman(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    rx, ry = _avg_ranks(xs), _avg_ranks(ys)
    mx, my = math.fsum(rx) / n, math.fsum(ry) / n
    num = math.fsum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(math.fsum((a - mx) ** 2 for a in rx) * math.fsum((b - my) ** 2 for b in ry))
    return num / den if den > EPS else None


def target_weights(cohort, hyp) -> dict:
    """cohort: list of (symbol, score) known at the decision bar."""
    w = {}
    if hyp["mode"] == "cross_section":
        ranked = sorted(cohort, key=lambda c: (c[1], c[0]))
        k = max(1, int(hyp["quantile"] * len(ranked)))
        for s, _ in ranked[-k:]:
            w[s] = 0.5 / k
        for s, _ in ranked[:k]:
            w[s] = w.get(s, 0.0) - 0.5 / k
    else:
        m = len(cohort)
        for s, sc in cohort:
            if sc:
                w[s] = (1.0 if sc > 0 else -1.0) / m
    return w


def default_rebalance(h: int) -> int:
    """Daily staggered tranches for holds longer than a day; otherwise one tranche."""
    return h if h <= 24 else math.gcd(h, 24)


def simulate(panel: Panel, hyp: dict, first_entry: int, last_exit: int, costs_bp, missing_exit_penalty_bp=300.0) -> dict:
    """Staggered-tranche book, evaluated one rebalance step (r bars) at a time.

    Position convention (self-financing, fixed units): every r bars, after the close of
    bar t, a new tranche is formed from the cohort known at t (score, eligible == 1,
    close at t). Each leg buys a fixed quantity worth weight / K at the entry open t+1
    and holds that quantity for h = horizon_bars; its notional then drifts with price.
    K = h / r tranches overlap; K = 1 is the plain non-overlapping strategy.
    - Step P&L of a leg: weight * (P_end - P_start) / P_entry.
    - Funding: a long pays, a short receives, the settled rate times the leg's notional
      at the settlement bar's close.
    - Costs: turnover is the change of book notional at each boundary, where the
      notional before trading includes price drift; expiring and new tranches on the
      same contract net out.
    - A missing entry open leaves the leg in cash. A missing boundary price closes the
      leg at its last observed close and charges the penalty on its notional then.
    Entries >= first_entry, exits <= last_exit.
    """
    h = hyp["horizon_bars"]
    r = hyp.get("rebalance_bars") or default_rebalance(h)
    K = h // r
    score = evaluate_expression(hyp["score"], panel)
    opens, closes, funding, elig = panel.series["open"], panel.series["close"], panel.series["funding"], panel.eligible
    pen = missing_exit_penalty_bp / 1e4
    steps, tranches = [], []  # tranche: {"legs": {sym: [weight, entry_price, last_price]}, "left": steps remaining}
    held = Counter()  # book notional after the previous step's price moves, before trading
    counts = Counter()
    t = max(first_entry - 1, 0)
    while t + 1 + r <= last_exit:
        s, e = t + 1, t + 1 + r
        tranches = [tr for tr in tranches if tr["left"] > 0]
        new_weights, ic, n_cohort = None, None, 0
        if s + h <= last_exit:
            cohort = [(sym, score[sym][t]) for sym in panel.symbols
                      if score[sym][t] == score[sym][t] and elig[sym][t] and closes[sym][t] == closes[sym][t]]
            n_cohort = len(cohort)
            if n_cohort >= hyp["min_symbols"]:
                new_weights = target_weights(cohort, hyp)
                legs = {}
                for sym, wt in new_weights.items():
                    o = opens[sym][s]
                    if o == o:
                        legs[sym] = [wt / K, o, o]
                    else:
                        counts["entry_missed"] += 1
                tranches.append({"legs": legs, "left": K})
                labelled = []
                for sym, sc in cohort:
                    out = _realized(panel, sym, s, s + h)
                    if out is not None:
                        labelled.append((sc, out[1] / out[0] - 1.0))
                ic = _spearman([a for a, _ in labelled], [b for _, b in labelled])
            else:
                counts["skipped_small_cohort"] += 1
        book = Counter()
        for tr in tranches:
            for sym, (wt, p0, last) in tr["legs"].items():
                book[sym] += wt * last / p0
        turnover = math.fsum(abs(book.get(sym, 0.0) - held.get(sym, 0.0)) for sym in set(book) | set(held))
        if not book and turnover == 0.0 and not steps:  # the calendar starts at the first trade
            t += r
            continue
        gross = penalty = fund = 0.0
        for tr in tranches:
            for sym in list(tr["legs"]):
                wt, p0, last = tr["legs"][sym]
                px = opens[sym][e]
                missing = px != px
                if missing:
                    px = next((closes[sym][j] for j in range(e - 1, s - 1, -1) if closes[sym][j] == closes[sym][j]), last)
                gross += wt * (px - last) / p0
                mark = last
                for j in range(s, e):
                    c = closes[sym][j]
                    if c == c:
                        mark = c
                    f = funding[sym][j]
                    counts["position_bars"] += 1
                    if f == f:
                        fund -= wt * mark / p0 * f
                    else:
                        counts["position_bars_funding_unknown"] += 1
                if missing:
                    counts["missing_exits"] += 1
                    penalty += abs(wt * px / p0) * pen
                    del tr["legs"][sym]
                else:
                    tr["legs"][sym][2] = px
            tr["left"] -= 1
        held = Counter()
        for tr in tranches:
            for sym, (wt, p0, last) in tr["legs"].items():
                held[sym] += wt * last / p0
        steps.append({"t": t, "gross": gross, "penalty": penalty, "funding": fund, "turnover": turnover,
                      "ic": ic, "n": n_cohort, "weights": new_weights, "cash": not book})
        t += r
    # All-cash steps between trades stay in the calendar as zero returns; only the tail
    # after the last trade (no tranche can still finish inside the window) is dropped.
    while steps and steps[-1]["cash"] and steps[-1]["turnover"] == 0.0:
        steps.pop()
    if steps:  # liquidate whatever is still held
        steps[-1]["turnover"] += math.fsum(abs(x) for x in held.values())
    for p in steps:
        base = p["gross"] - p["penalty"] + p["funding"]
        p["net"] = {str(c): base - p["turnover"] * c / 1e4 for c in costs_bp}
    pb = counts["position_bars"]
    return {"periods": steps, "counts": dict(counts), "tranches": K, "rebalance_bars": r,
            "funding_unknown_share": counts["position_bars_funding_unknown"] / pb if pb else 0.0,
            "periods_per_year": MS_PER_YEAR / (panel.bar_ms * r)}


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
    denom = max(1 - skew * sr + (kurt - 1) / 4 * sr * sr, EPS)
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


def long_run_variance(xs, lag: int):
    """Newey-West (Bartlett) long-run variance of the mean's terms; never below 0."""
    n = len(xs)
    mu = math.fsum(xs) / n
    d = [x - mu for x in xs]
    g0 = math.fsum(v * v for v in d) / n
    lrv = g0
    for l in range(1, min(lag, n - 1) + 1):
        gl = math.fsum(d[i] * d[i - l] for i in range(l, n)) / n
        lrv += 2 * (1 - l / (lag + 1)) * gl
    return max(lrv, 0.0), g0


def summarize(sim: dict, costs_bp, gate_cost, folds: int) -> dict:
    """Step statistics. Inference uses the Newey-West long-run variance with lag
    max(K - 1, 4 (n/100)^(2/9)), so overlapping tranches are not counted as
    independent observations. sharpe_annual is mean / sqrt(long-run variance),
    annualised; n_effective = n * variance / long-run variance (capped at n)."""
    periods = sim["periods"]
    n = len(periods)
    ppy = sim["periods_per_year"]
    K = sim.get("tranches", 1)
    out = {"periods": n, "periods_per_year": ppy, "tranches": K, "rebalance_bars": sim.get("rebalance_bars"),
           "years": n / ppy, "counts": sim["counts"], "funding_unknown_share": sim["funding_unknown_share"]}
    if n < 3:
        return out
    lag = max(K - 1, math.floor(4 * (n / 100) ** (2 / 9)))
    out["hac_lag"] = lag
    by_cost = {}
    for c in costs_bp:
        xs = [p["net"][str(c)] for p in periods]
        mu, sd, skew, kurt = moments(xs)
        lrv, g0 = long_run_variance(xs, lag)
        lr_sd = math.sqrt(lrv) if lrv > 0 else sd
        sr_lr = mu / lr_sd if lr_sd > EPS else 0.0
        by_cost[str(c)] = {
            "mean_bp": mu * 1e4, "std_bp": sd * 1e4, "long_run_std_bp": lr_sd * 1e4,
            "sharpe_period_lr": sr_lr, "sharpe_annual": sr_lr * math.sqrt(ppy), "t_stat": sr_lr * math.sqrt(n),
            "n_effective": min(n, n * g0 / lrv) if lrv > EPS else n,
            "skew": skew, "kurtosis": kurt, "hit_rate": sum(1 for x in xs if x > 0) / n,
            "max_drawdown_bp": max_drawdown(xs) * 1e4,
        }
    out["by_cost_bp_per_side"] = by_cost
    lo, hi = block_bootstrap_mean([p["net"][str(gate_cost)] for p in periods], block=max(K, round(n ** (1 / 3))))
    out["gate_mean_bp_ci95_block_bootstrap"] = [lo * 1e4, hi * 1e4]
    for key in ("gross", "penalty", "funding"):
        out[f"{key}_mean_bp"] = math.fsum(p[key] for p in periods) / n * 1e4
    out["turnover_mean"] = math.fsum(p["turnover"] for p in periods) / n
    ics = [p["ic"] for p in periods if p["ic"] is not None]
    if len(ics) >= 3:
        mu = math.fsum(ics) / len(ics)
        lrv, _ = long_run_variance(ics, lag)
        out["ic_mean"] = mu
        out["ic_t_stat"] = mu / math.sqrt(lrv / len(ics)) if lrv > EPS else 0.0
    out["symbols_per_period_mean"] = math.fsum(p["n"] for p in periods) / n
    size = math.ceil(n / folds)
    out["folds"] = []
    for k in range(folds):
        chunk = periods[k * size:(k + 1) * size]
        if chunk:
            fi = [p["ic"] for p in chunk if p["ic"] is not None]
            out["folds"].append({
                "periods": len(chunk),
                "net_mean_bp": math.fsum(p["net"][str(gate_cost)] for p in chunk) / len(chunk) * 1e4,
                "ic_mean": math.fsum(fi) / len(fi) if fi else None,
            })
    z = ND.inv_cdf(0.975) + ND.inv_cdf(0.8)
    out["power"] = {"mde_sharpe_annual": z / math.sqrt(n / ppy)}
    return out


# ---------------------------------------------------------- config/ledger

DEFAULT_GATE = {
    "costs_bp_per_side": [0, 5, 10, 15],
    "gate_cost_bp_per_side": 10,
    "missing_exit_penalty_bp": 300,
    "max_funding_unknown_share": 0.05,
    "dsr_min": 0.95,
    "folds": 4,
    "folds_positive_min": 3,
    "min_periods": 30,
    "min_effective_periods": 20,
    "target_sharpe_annual": 2.0,
    "holdout_budget": 3,
    "holdout_alpha": 0.05,
    "prior_trials": 0,
    "registered_hypotheses": [],
}


def freeze_config(panel: Panel, holdout_frac: float, out, gate_overrides: dict | None = None,
                  expect_bar_ms: int | None = None) -> dict:
    if not 0.05 <= holdout_frac <= 0.5:
        raise ValueError("holdout fraction must be in [0.05, 0.5]")
    if expect_bar_ms is not None and panel.bar_ms != expect_bar_ms:
        raise ValueError(f"panel bar is {panel.bar_ms} ms, expected {expect_bar_ms}")
    b = int(panel.T * (1 - holdout_frac))
    gate = dict(DEFAULT_GATE)
    gate.update(gate_overrides or {})
    if gate["gate_cost_bp_per_side"] not in gate["costs_bp_per_side"]:
        raise ValueError("gate cost must be one of the reported cost levels")
    cfg = {
        "schema": SCHEMA_CONFIG, "version": VERSION, "panel_sha256": panel.sha, "bar_ms": panel.bar_ms,
        "symbols": panel.symbols, "panel_start_ts": panel.times[0], "panel_end_ts": panel.times[-1],
        "holdout_start_ts": panel.times[b], "holdout_start_utc": utc_iso(panel.times[b]),
        "gate": gate, "frozen_at_utc": now_utc(),
    }
    write_exclusive(Path(out), cfg)
    return cfg


def load_config(path, panel: Panel) -> tuple[dict, int]:
    cfg = json.loads(Path(path).read_text())
    if cfg.get("schema") != SCHEMA_CONFIG:
        raise ValueError("bad config schema")
    if cfg["panel_sha256"] != panel.sha:
        raise ValueError("panel SHA differs from the frozen config; refuse to evaluate")
    b = (cfg["holdout_start_ts"] - panel.times[0]) // panel.bar_ms
    if not 0 < b < panel.T or panel.times[b] != cfg["holdout_start_ts"]:
        raise ValueError("holdout boundary is not on the panel grid")
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


def trial_stats(ledger: list[dict], panel_sha: str, current_sha: str, current_sr: float) -> dict:
    """Annualised gate Sharpe ratios of all distinct development trials on this panel,
    keyed by hypothesis SHA. Annual units make different rebalance steps comparable."""
    srs = {}
    for e in ledger:
        if e.get("region") == "development" and e.get("panel_sha256") == panel_sha and e.get("sharpe_annual_gate") is not None:
            srs[e["hypothesis_sha256"]] = e["sharpe_annual_gate"]
    srs[current_sha] = current_sr
    return srs


def count_trials(gate: dict, evaluated_shas) -> int:
    """Distinct trials: every hypothesis registered at freeze or evaluated on the panel,
    plus audited prior trials. Independent of evaluation order."""
    return len(set(evaluated_shas) | set(gate.get("registered_hypotheses", []))) + int(gate.get("prior_trials", 0))


def write_signoff(directory, hypothesis_sha256: str, panel_sha256: str, reviewer: str, note: str = "") -> Path:
    if reviewer not in REVIEWERS:
        raise ValueError(f"reviewer must be one of {REVIEWERS}")
    path = Path(directory) / f"{hypothesis_sha256}.signoff.json"
    write_exclusive(path, {"hypothesis_sha256": hypothesis_sha256, "panel_sha256": panel_sha256,
                           "reviewer": reviewer, "note": note[:2000], "signed_at_utc": now_utc()})
    return path


def _check_signoff(directory, hsha: str, panel_sha: str, author: str) -> dict:
    path = Path(directory) / f"{hsha}.signoff.json"
    if not path.exists():
        raise PermissionError("holdout requires a sign-off file from a reviewer other than the author")
    doc = json.loads(path.read_text())
    if doc.get("hypothesis_sha256") != hsha or doc.get("panel_sha256") != panel_sha:
        raise PermissionError("sign-off does not match this hypothesis and panel")
    if doc.get("reviewer") not in REVIEWERS or doc.get("reviewer") == author:
        raise PermissionError("sign-off must come from a known reviewer other than the hypothesis author")
    return doc


# ------------------------------------------------------------- verdicts

def evaluate_development(panel: Panel, cfg: dict, boundary: int, hyp: dict, ledger_path) -> dict:
    gate = cfg["gate"]
    dev = panel.truncated(boundary)  # holdout bars do not exist for this computation
    sim = simulate(dev, hyp, first_entry=1, last_exit=boundary - 1, costs_bp=gate["costs_bp_per_side"],
                   missing_exit_penalty_bp=gate["missing_exit_penalty_bp"])
    summary = summarize(sim, gate["costs_bp_per_side"], gate["gate_cost_bp_per_side"], gate["folds"])
    hsha = hypothesis_sha(hyp)
    report = {"bench": VERSION, "region": "development", "hypothesis": hyp, "hypothesis_sha256": hsha,
              "panel_sha256": panel.sha, "development_end_utc": utc_iso(panel.times[boundary]),
              "summary": summary, "sharpe_annual_gate": None}
    n = summary["periods"]
    g = summary.get("by_cost_bp_per_side", {}).get(str(gate["gate_cost_bp_per_side"]))
    if n < gate["min_periods"] or g is None or g["n_effective"] < gate["min_effective_periods"]:
        report["verdict"] = "INSUFFICIENT_DATA"
    else:
        ppy = summary["periods_per_year"]
        by_sha = trial_stats(read_ledger(ledger_path), panel.sha, hsha, g["sharpe_annual"])
        srs = list(by_sha.values())
        n_trials = count_trials(gate, by_sha)
        # Null sampling variance of an annual Sharpe estimate is about 1 / years.
        var_annual = max(moments(srs)[1] ** 2 if len(srs) >= 2 else 0.0, ppy / n)
        dsr = deflated_sharpe(g["sharpe_period_lr"], n, g["skew"], g["kurtosis"], n_trials, var_annual / ppy)
        folds_pos = sum(1 for f in summary["folds"] if f["net_mean_bp"] > 0)
        ic_ok = summary.get("ic_mean", 0) > 0
        report["selection"] = {
            "trials_counted": n_trials, "var_annual_sharpe_used": var_annual,
            "expected_max_null_sharpe_annual": expected_max_sharpe(n_trials, var_annual),
            "deflated_sharpe": dsr, "folds_positive": folds_pos, "ic_positive": ic_ok,
        }
        report["sharpe_annual_gate"] = g["sharpe_annual"]
        powered = summary["power"]["mde_sharpe_annual"] <= gate["target_sharpe_annual"]
        if summary["funding_unknown_share"] > gate["max_funding_unknown_share"]:
            report["verdict"] = "FUNDING_UNKNOWN"
        elif dsr >= gate["dsr_min"] and folds_pos >= gate["folds_positive_min"] and ic_ok:
            report["verdict"] = "PASS_DEV"
        elif g["mean_bp"] <= 0 or powered:
            report["verdict"] = "REJECT"
        else:
            report["verdict"] = "INCONCLUSIVE_UNPOWERED"
        report["power_note"] = (f"{summary['years']:.2f} years of steps detect annual Sharpe >= "
                                f"{summary['power']['mde_sharpe_annual']:.2f} with 80% power; target "
                                f"{gate['target_sharpe_annual']}; effective observations {g['n_effective']:.0f}")
    append_ledger(ledger_path, {
        "time_utc": now_utc(), "region": "development", "hypothesis_id": hyp["id"], "author": hyp["author"],
        "hypothesis_sha256": hsha, "panel_sha256": panel.sha, "periods": n,
        "sharpe_annual_gate": report["sharpe_annual_gate"], "verdict": report["verdict"],
    })
    return report


def evaluate_holdout(panel: Panel, cfg: dict, boundary: int, hyp: dict, ledger_path, claims_dir, signoffs_dir) -> dict:
    gate = cfg["gate"]
    hsha = hypothesis_sha(hyp)
    passed = [e for e in read_ledger(ledger_path) if e.get("hypothesis_sha256") == hsha
              and e.get("panel_sha256") == panel.sha and e.get("region") == "development"
              and e.get("verdict") == "PASS_DEV"]
    if not passed:
        raise PermissionError("holdout requires a recorded PASS_DEV for this exact hypothesis and panel")
    signoff = _check_signoff(signoffs_dir, hsha, panel.sha, passed[-1]["author"])
    claims = Path(claims_dir)
    claims.mkdir(parents=True, exist_ok=True)
    if len(list(claims.glob("*.claim.json"))) >= gate["holdout_budget"]:
        raise PermissionError(f"holdout budget of {gate['holdout_budget']} claims is exhausted")
    try:
        write_exclusive(claims / f"{hsha}.claim.json", {"hypothesis_sha256": hsha, "panel_sha256": panel.sha,
                                                         "reviewer": signoff["reviewer"], "claimed_at_utc": now_utc()})
    except FileExistsError as exc:
        raise PermissionError("this hypothesis already used its single holdout claim") from exc
    sim = simulate(panel, hyp, first_entry=boundary, last_exit=panel.T - 1, costs_bp=gate["costs_bp_per_side"],
                   missing_exit_penalty_bp=gate["missing_exit_penalty_bp"])
    summary = summarize(sim, gate["costs_bp_per_side"], gate["gate_cost_bp_per_side"], gate["folds"])
    report = {"bench": VERSION, "region": "holdout", "hypothesis": hyp, "hypothesis_sha256": hsha,
              "panel_sha256": panel.sha, "reviewer": signoff["reviewer"], "summary": summary}
    if summary["periods"] < 2 or "by_cost_bp_per_side" not in summary:
        report["verdict"] = "HOLDOUT_INSUFFICIENT_DATA"
    elif summary["funding_unknown_share"] > gate["max_funding_unknown_share"]:
        report["verdict"] = "HOLDOUT_FUNDING_UNKNOWN"
    else:
        g = summary["by_cost_bp_per_side"][str(gate["gate_cost_bp_per_side"])]
        report["p_value_one_sided"] = 1 - ND.cdf(g["t_stat"])
        ok = report["p_value_one_sided"] < gate["holdout_alpha"] and summary.get("ic_mean", 0) > 0
        report["verdict"] = "PASS_HOLDOUT" if ok else "FAIL_HOLDOUT"
    append_ledger(ledger_path, {
        "time_utc": now_utc(), "region": "holdout", "hypothesis_id": hyp["id"], "author": hyp["author"],
        "hypothesis_sha256": hsha, "panel_sha256": panel.sha, "periods": summary["periods"],
        "verdict": report["verdict"],
    })
    return report


# --------------------------------------------------------- synthetic data

def synthesize(out, symbols=30, bars=3000, seed=1, plant=0.0, delist_frac=0.0, never_eligible_frac=0.0,
               bar_ms=3_600_000, start_ms=1_767_225_600_000) -> None:
    """Write a synthetic hourly perp panel to `out`. Funding settles every 8 bars.

    plant > 0: the next bar's idiosyncratic return loads on minus the
    cross-sectional z-score of the last settled funding rate (in idio-vol units).
    delist_frac: share of symbols whose rows stop at a random bar after the first quarter.
    never_eligible_frac: share of symbols written with eligible = 0 on every bar.
    """
    rng = random.Random(seed)
    syms = [f"SYN{i:03d}-USDT-SWAP" for i in range(symbols)]
    price = {s: 10 * math.exp(rng.gauss(0, 1)) for s in syms}
    beta = {s: 0.7 + 0.6 * rng.random() for s in syms}
    latent = {s: rng.gauss(1e-4, 2e-4) for s in syms}
    last_settled = dict(latent)
    oi = {s: 1e6 * (1 + rng.random()) for s in syms}
    end = {s: bars for s in syms}
    for s in rng.sample(syms, int(delist_frac * symbols)):
        end[s] = rng.randrange(bars // 4, bars)
    never = set(random.Random(seed + 1).sample(syms, int(never_eligible_frac * symbols)))
    sig_m, sig_i = 0.006, 0.008
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["ts", "symbol", "open", "high", "low", "close", "volume", "eligible", "funding", "oi"])
        for t in range(bars):
            m = rng.gauss(0, sig_m)
            vals = list(last_settled.values())
            mu = sum(vals) / len(vals)
            sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / (len(vals) - 1)) or 1.0
            for s in syms:
                latent[s] = 1e-4 + 0.98 * (latent[s] - 1e-4) + rng.gauss(0, 4e-5)
                # Log return minus half its variance: zero expected simple return, so
                # volatility or beta alone carries no premium in the null panel.
                drag = 0.5 * (beta[s] ** 2 * sig_m ** 2 + sig_i ** 2)
                r = beta[s] * m + rng.gauss(-plant * sig_i * (last_settled[s] - mu) / sd, sig_i) - drag
                o = price[s]
                c = o * math.exp(r)
                hi = max(o, c) * math.exp(abs(rng.gauss(0, 0.002)))
                lo = min(o, c) * math.exp(-abs(rng.gauss(0, 0.002)))
                price[s] = c
                oi[s] *= math.exp(rng.gauss(0, 0.01))
                vol = abs(rng.gauss(1000, 300))
                fund = ""
                if t % 8 == 7:
                    last_settled[s] = latent[s]
                    fund = f"{latent[s]:.8f}"
                if t < end[s]:
                    w.writerow([start_ms + t * bar_ms, s, f"{o:.8g}", f"{hi:.8g}", f"{lo:.8g}", f"{c:.8g}",
                                f"{vol:.4f}", 0 if s in never else 1, fund, f"{oi[s]:.2f}"])


# ------------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description="Rakazo Algorithm Bench v40 (research only, no orders)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("synth")
    p.add_argument("--out", required=True)
    p.add_argument("--symbols", type=int, default=30)
    p.add_argument("--bars", type=int, default=3000)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--plant", type=float, default=0.0)
    p.add_argument("--delist-frac", type=float, default=0.0)
    p.add_argument("--never-eligible-frac", type=float, default=0.0)
    p = sub.add_parser("audit")
    p.add_argument("--panel", required=True)
    p.add_argument("--expect-bar-ms", type=int, default=3_600_000)
    p.add_argument("--eligibility-usd", type=float)
    p.add_argument("--eligibility-days", type=int, default=30)
    p = sub.add_parser("freeze")
    p.add_argument("--panel", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--expect-bar-ms", type=int, default=3_600_000)
    p.add_argument("--holdout-frac", type=float, default=0.25)
    p.add_argument("--prior-trials", type=int, required=True,
                   help="audited count of distinct rules already tried before this bench")
    p.add_argument("--registered-hyp", action="append", required=True,
                   help="every committed hypothesis batch; all count as trials before the first result")
    for name in ("evaluate", "holdout"):
        p = sub.add_parser(name)
        for arg in ("--panel", "--config", "--hyp", "--ledger", "--out"):
            p.add_argument(arg, required=True)
        if name == "holdout":
            for arg in ("--claims", "--signoffs", "--id"):
                p.add_argument(arg, required=True)
    p = sub.add_parser("signoff")
    for arg in ("--signoffs", "--hypothesis-sha", "--panel-sha", "--reviewer"):
        p.add_argument(arg, required=True)
    p.add_argument("--note", default="")
    p = sub.add_parser("power")
    p.add_argument("--target-sharpe-annual", type=float, default=2.0)
    p.add_argument("--periods-per-year", type=float, required=True)
    p.add_argument("--n", type=int, default=0)
    args = ap.parse_args(argv)

    if args.cmd == "synth":
        synthesize(args.out, args.symbols, args.bars, args.seed, args.plant, args.delist_frac, args.never_eligible_frac)
        return
    if args.cmd == "power":
        need = periods_needed(args.target_sharpe_annual / math.sqrt(args.periods_per_year))
        print(json.dumps({"target_sharpe_annual": args.target_sharpe_annual, "periods_needed_80pct_power": need,
                          "years_needed": need / args.periods_per_year,
                          "mde_sharpe_annual_at_n": mde_sharpe(args.n) * math.sqrt(args.periods_per_year) if args.n else None},
                         indent=1))
        return
    if args.cmd == "signoff":
        print(write_signoff(args.signoffs, args.hypothesis_sha, args.panel_sha, args.reviewer, args.note))
        return
    panel = load_panel(args.panel, tradable_only=args.cmd != "audit")
    if args.cmd == "audit":
        print(json.dumps(audit_panel(panel, args.expect_bar_ms, args.eligibility_usd, args.eligibility_days), indent=1))
        return
    if args.cmd == "freeze":
        registered = sorted({hypothesis_sha(h) for f in args.registered_hyp for h in read_hypotheses(f)})
        cfg = freeze_config(panel, args.holdout_frac, args.out,
                            {"prior_trials": args.prior_trials, "registered_hypotheses": registered}, args.expect_bar_ms)
        print(json.dumps({k: cfg[k] for k in ("panel_sha256", "holdout_start_utc")}, indent=1))
        return
    cfg, boundary = load_config(args.config, panel)
    hyps = read_hypotheses(args.hyp)
    if args.cmd == "evaluate":
        reports = [evaluate_development(panel, cfg, boundary, h, args.ledger) for h in hyps]
        write_exclusive(Path(args.out), {"reports": reports})
        for r in reports:
            print(f"{r['hypothesis']['id']:40s} {r['hypothesis_sha256'][:12]} {r['verdict']}")
        return
    hyp = next((h for h in hyps if h["id"] == args.id), None)
    if hyp is None:
        raise SystemExit(f"no hypothesis with id {args.id}")
    r = evaluate_holdout(panel, cfg, boundary, hyp, args.ledger, args.claims, args.signoffs)
    write_exclusive(Path(args.out), r)
    print(f"{hyp['id']} {r['verdict']}")


if __name__ == "__main__":
    main()
