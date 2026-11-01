"""Algorithm Search v40: large-scale, failure-guided search over the bench DSL.

The idea borrowed from verifier-driven discovery: generate many candidate programs,
score them with a strict verifier, keep what survives, and use the failure analysis to
steer the next round. In markets the verifier wears out with every look, so the search
only ever sees the SEARCH segment of the frozen calendar. Only the few rules written
to a promotion batch go on to the validation segment (bench `promote`), where they are
counted as trials, and the holdout stays untouched.

Research only, stdlib only, deterministic for a given seed. Typical use (daily panel):

  python algorithm_search_v40.py run --panel DAILY.csv --config DAILY_CONFIG.json \\
      --explore-ledger PRIVATE/explore.jsonl --report PRIVATE/search-r1.json \\
      --promote-out docs/trading/bench/hypotheses/search-r1.json --round r1

Programs are built from a library of causal building blocks:
  factors  csz of trailing returns, residual (beta-adjusted) returns, volatility,
           funding, volume shocks, ranges, betas, and their negatives;
  regimes  market volatility versus its longer average, market trend, cross-sectional
           dispersion; a program may switch between two factor blends by regime.
Each genome compiles to an ordinary bench DSL expression, so a promoted rule is
validated by exactly the same code path as any hand-written hypothesis.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import random
from pathlib import Path

import algorithm_bench_v40 as bench

R = ["field", "ret"]
MKT = ["csmean", R]
HORIZONS = [1, 2, 3, 5, 7, 10, 14, 21, 30]
BETA_NEUTRAL = True
allowed_horizons = list(HORIZONS)  # narrowed by search() to holds the validation segment can judge


def _terminals() -> dict:
    """name -> DSL expression (one value per contract and day, before cross-sectional z)."""
    t = {}
    for n in (1, 3, 5, 10, 20, 60, 120):
        t[f"ret{n}"] = ["sum", R, n]
    for n in (20, 60, 120):
        t[f"resid{n}"] = ["sub", ["sum", R, n], ["mul", ["beta", R, MKT, 120], ["sum", MKT, n]]]
    for n in (10, 20, 60):
        t[f"vol{n}"] = ["std", R, n]
    for n in (3, 7, 14):
        t[f"fund{n}"] = ["mean", ["field", "funding"], n]
    for n in (20, 60):
        t[f"volume_z{n}"] = ["z", ["log1p", ["field", "volume"]], n]
    for n in (5, 20):
        t[f"range{n}"] = ["mean", ["field", "range"], n]
    t["beta60"] = ["beta", R, MKT, 60]
    t["beta120"] = ["beta", R, MKT, 120]
    t["maxret20"] = ["tsmax", R, 20]
    t["trend_break20"] = ["div", ["sub", ["field", "close"], ["tsmax", ["field", "close"], 20]], ["tsmax", ["field", "close"], 20]]
    return t


def _regimes() -> dict:
    """name -> market-level DSL expression; > 0 selects the first branch."""
    return {
        "mvol_high": ["sub", ["std", MKT, 20], ["std", MKT, 120]],
        "mtrend_up": ["sum", MKT, 20],
        "mdisp_high": ["sub", ["csmean", ["abs", ["csdemean", ["sum", R, 5]]]],
                       ["mean", ["csmean", ["abs", ["csdemean", ["sum", R, 5]]]], 120]],
    }


TERMINALS = _terminals()
REGIMES = _regimes()


# ------------------------------------------------------------------ genomes
# genome = {"blend": [(sign, name), ...]} or {"regime": name, "on": blend, "off": blend}
#          plus "h" (hold, days) and "w" ("equal" | "inverse_vol")

def _z(name, sign):
    e = ["clip", ["csz", TERMINALS[name]], 3.0]
    return e if sign > 0 else ["neg", e]


def _blend_expr(blend):
    out = _z(blend[0][1], blend[0][0])
    for sign, name in blend[1:]:
        out = ["add", out, _z(name, sign)]
    return out


def compile_genome(g) -> list:
    if "regime" in g:
        return ["where", REGIMES[g["regime"]], _blend_expr(g["on"]), _blend_expr(g["off"])]
    return _blend_expr(g["blend"])


def genome_key(g) -> str:
    return json.dumps(g, sort_keys=True)


def to_hypothesis(g, ident, rationale="") -> dict:
    rec = {"id": ident, "author": "claude-search", "rationale": rationale or describe(g),
           "score": compile_genome(g), "horizon_bars": g["h"]}
    if g["w"] == "inverse_vol":
        rec["weighting"], rec["vol_window"] = "inverse_vol", 60
    if BETA_NEUTRAL:  # the search looks for alpha, not market exposure
        rec["neutralize"], rec["beta_window"] = "beta", 120
    return bench.validate_hypothesis(rec)


def describe(g) -> str:
    fmt = lambda b: " + ".join(("" if s > 0 else "-") + n for s, n in b)
    core = f"if {g['regime']}: {fmt(g['on'])} else {fmt(g['off'])}" if "regime" in g else fmt(g["blend"])
    return f"{core}; hold {g['h']}d; {g['w']} weights{'; beta-neutral' if BETA_NEUTRAL else ''}"


def _rand_blend(rng, k=None):
    k = k or rng.choice([1, 1, 2, 2, 3])
    names = rng.sample(sorted(TERMINALS), k)
    return [(rng.choice([1, -1]), n) for n in names]


def random_genome(rng) -> dict:
    g = {"h": rng.choice(allowed_horizons), "w": rng.choice(["equal", "inverse_vol"])}
    if rng.random() < 0.4:
        g.update(regime=rng.choice(sorted(REGIMES)), on=_rand_blend(rng), off=_rand_blend(rng))
    else:
        g["blend"] = _rand_blend(rng)
    return g


def _mutate_blend(rng, blend):
    b = list(blend)
    r = rng.random()
    if r < 0.35:
        i = rng.randrange(len(b))
        b[i] = (-b[i][0], b[i][1])
    elif r < 0.7:
        i = rng.randrange(len(b))
        b[i] = (b[i][0], rng.choice(sorted(TERMINALS)))
    elif r < 0.85 and len(b) < 3:
        b.append((rng.choice([1, -1]), rng.choice(sorted(TERMINALS))))
    elif len(b) > 1:
        b.pop(rng.randrange(len(b)))
    seen, out = set(), []
    for s, n in b:
        if n not in seen:
            seen.add(n)
            out.append((s, n))
    return out


def mutate(rng, g) -> dict:
    g = copy.deepcopy(g)
    r = rng.random()
    if r < 0.15:
        g["h"] = rng.choice(allowed_horizons)
    elif r < 0.22:
        g["w"] = "equal" if g["w"] == "inverse_vol" else "inverse_vol"
    elif r < 0.32:
        if "regime" in g:  # collapse to the stronger-looking branch at random
            g["blend"] = g.pop(rng.choice(["on", "off"]))
            g.pop("on", None), g.pop("off", None), g.pop("regime")
        else:
            g.update(regime=rng.choice(sorted(REGIMES)), on=g["blend"],
                     off=[(-s, n) for s, n in g["blend"]] if rng.random() < 0.5 else _rand_blend(rng))
            g.pop("blend")
    elif "regime" in g:
        part = rng.choice(["on", "off", "regime"])
        if part == "regime":
            g["regime"] = rng.choice(sorted(REGIMES))
        else:
            g[part] = _mutate_blend(rng, g[part])
    else:
        g["blend"] = _mutate_blend(rng, g["blend"])
    return g


def crossover(rng, a, b) -> dict:
    child = copy.deepcopy(a if rng.random() < 0.5 else b)
    donor = b if child is a else a
    child["h"] = rng.choice([a["h"], b["h"]])
    blends = lambda g: [g["on"], g["off"]] if "regime" in g else [g["blend"]]
    give = rng.choice(blends(donor))
    if "regime" in child:
        child[rng.choice(["on", "off"])] = copy.deepcopy(give)
    else:
        child["blend"] = copy.deepcopy(give)
    return child


def complexity(g) -> int:
    return (len(g["on"]) + len(g["off"]) + 1) if "regime" in g else len(g["blend"])


# ---------------------------------------------------------------- evaluation

class Evaluator:
    """Scores genomes on the search segment only, caching building blocks."""

    def __init__(self, panel, cfg, ledger_path):
        self.cfg, self.gate = cfg, cfg["gate"]
        sb = bench.search_index(cfg, panel)
        self.panel = panel if panel.T == sb else panel.truncated(sb)
        self.sb = sb
        self.ledger_path = ledger_path
        self.cache: dict = {}
        self.leaf_cache: dict = {}
        self.seen: dict = {}

    def _z(self, name, sign):
        key = ("z", name)
        if key not in self.cache:
            self.cache[key] = bench.evaluate_expression(_z(name, 1), self.panel, self.leaf_cache)
        z = self.cache[key]
        if sign > 0:
            return z
        nkey = ("nz", name)
        if nkey not in self.cache:
            self.cache[nkey] = {s: bench._clean([-v for v in a]) for s, a in z.items()}
        return self.cache[nkey]

    def _blend(self, blend):
        parts = [self._z(n, s) for s, n in blend]
        if len(parts) == 1:
            return parts[0]
        out = parts[0]
        for nxt in parts[1:]:  # same left-nested add, same rounding, as the compiled DSL
            out = {sym: bench._clean([u + v if u == u and v == v else bench.NAN for u, v in zip(out[sym], nxt[sym])])
                   for sym in self.panel.symbols}
        return out

    def score(self, g):
        if "regime" not in g:
            return self._blend(g["blend"])
        rkey = ("regime", g["regime"])
        if rkey not in self.cache:
            self.cache[rkey] = bench.evaluate_expression(REGIMES[g["regime"]], self.panel, self.leaf_cache)
        reg, on, off = self.cache[rkey], self._blend(g["on"]), self._blend(g["off"])
        return {s: bench._clean([(a if k > 0 else b) if k == k else bench.NAN
                                 for k, a, b in zip(reg[s], on[s], off[s])]) for s in self.panel.symbols}

    def evaluate(self, g) -> dict:
        key = genome_key(g)
        if key in self.seen:
            return self.seen[key]
        hyp = to_hypothesis(g, "search-candidate")
        sim = bench.simulate(self.panel, hyp, 1, self.sb - 1, self.gate["costs_bp_per_side"],
                             self.gate["missing_exit_penalty_bp"], score=self.score(g))
        summ = bench.summarize(sim, self.gate["costs_bp_per_side"], self.gate["gate_cost_bp_per_side"], 2)
        gate = summ.get("by_cost_bp_per_side", {}).get(str(self.gate["gate_cost_bp_per_side"]))
        if gate is None or summ["funding_unknown_share"] > self.gate["max_funding_unknown_share"]:
            res = {"fitness": -9.0, "sharpe": None, "halves": None, "ic": None}
        else:
            ppy = summ["periods_per_year"]
            halves = []
            for f in summ["folds"]:  # two halves of the search segment
                halves.append(f["net_mean_bp"])
            sd = gate["long_run_std_bp"] or 1.0
            half_sr = [h / sd * math.sqrt(ppy) for h in halves]
            sharpe = gate["sharpe_annual"]
            fitness = 0.5 * sharpe + 0.5 * min(half_sr) - 0.1 * (complexity(g) - 1)
            res = {"fitness": fitness, "sharpe": sharpe, "halves": half_sr, "ic": summ.get("ic_mean"),
                   "turnover": summ["turnover_mean"], "periods": summ["periods"]}
        res["returns"] = [p["net"][str(self.gate["gate_cost_bp_per_side"])] for p in sim["periods"]]
        res["steps_t"] = [p["t"] for p in sim["periods"]]
        bench.append_ledger(self.ledger_path, {
            "time_utc": bench.now_utc(), "region": "exploration", "hypothesis_id": "search",
            "author": "claude-search", "hypothesis_sha256": bench.hypothesis_sha(hyp),
            "panel_sha256": self.panel.sha, "genome": g, "sharpe_annual_gate": res["sharpe"],
            "fitness": res["fitness"]})
        self.seen[key] = res
        return res


def _corr(a, b):
    n = min(len(a), len(b))
    if n < 10:
        return 0.0
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def search(panel, cfg, ledger_path, population=60, generations=20, elite=12, seed=40, seeds=(), log=None):
    """Only holds the validation segment can judge are searched: about 25 non-overlapping
    holds must fit into it, otherwise promote would return INSUFFICIENT_DATA."""
    global allowed_horizons
    validation_bars = (cfg["holdout_start_ts"] - cfg["search_end_ts"]) // cfg["bar_ms"]
    allowed_horizons = [h for h in HORIZONS if h * 25 <= validation_bars] or [HORIZONS[0]]
    rng = random.Random(seed)
    ev = Evaluator(panel, cfg, ledger_path)
    pop = [copy.deepcopy(s) for s in seeds] + [random_genome(rng) for _ in range(population - len(seeds))]
    history = []
    for gen in range(generations):
        scored = sorted(((ev.evaluate(g)["fitness"], genome_key(g), g) for g in pop), key=lambda x: -x[0])
        history.append({"generation": gen, "best_fitness": scored[0][0], "evaluated_total": len(ev.seen)})
        if log:
            log(f"gen {gen:2d} best {scored[0][0]:+.2f} {describe(scored[0][2])} | evaluated {len(ev.seen)}")
        parents = [g for _, _, g in scored[:elite]]
        nxt = [copy.deepcopy(g) for g in parents]
        while len(nxt) < population:
            r = rng.random()
            if r < 0.3:
                child = crossover(rng, rng.choice(parents), rng.choice(parents))
            elif r < 0.85:
                child = mutate(rng, rng.choice(parents))
            else:
                child = random_genome(rng)
            nxt.append(child)
        pop = nxt
    return ev, history


def _core(g) -> str:
    """The signal itself: genomes that differ only in hold or weighting are one family."""
    return json.dumps({k: v for k, v in g.items() if k not in ("h", "w")}, sort_keys=True)


def diverse_top(ev, k=5, max_corr=0.7, min_sharpe=0.0):
    ranked = sorted(ev.seen.items(), key=lambda kv: -kv[1]["fitness"])
    picks, cores = [], set()
    for key, res in ranked:
        if res["sharpe"] is None or res["sharpe"] <= min_sharpe or min(res["halves"]) <= 0:
            continue
        core = _core(json.loads(key))
        if core in cores:
            continue
        if all(abs(_corr(res["returns"], ev.seen[p]["returns"])) < max_corr for p in picks):
            picks.append(key)
            cores.add(core)
        if len(picks) == k:
            break
    return [(json.loads(p), ev.seen[p]) for p in picks]


def regime_breakdown(ev, g) -> dict:
    """Failure analysis for one genome: mean net step return per regime state and per half."""
    res = ev.evaluate(g)
    out = {}
    for name in sorted(REGIMES):
        reg = ev.cache.get(("regime", name)) or bench.evaluate_expression(REGIMES[name], ev.panel, ev.leaf_cache)
        ev.cache[("regime", name)] = reg
        anysym = ev.panel.symbols[0]
        on, off = [], []
        for t, r in zip(res["steps_t"], res["returns"]):
            k = reg[anysym][t]
            (on if k == k and k > 0 else off).append(r)
        out[name] = {"steps_on": len(on), "mean_bp_on": 1e4 * sum(on) / len(on) if on else None,
                     "steps_off": len(off), "mean_bp_off": 1e4 * sum(off) / len(off) if off else None}
    return out


# ------------------------------------------------------------ synthetic data

def synthesize_regime_daily(out, symbols=40, days=1100, seed=1, plant=0.0, start_ms=1_704_067_200_000):
    """Daily panel with switching market-volatility regimes. With plant > 0 the next day's
    idiosyncratic return loads on the cross-sectional z of the 5-day return: reversal in
    high-volatility regimes (20-day market vol above its 120-day level), momentum otherwise.
    Unconditionally the two halves cancel, so plain momentum or reversal rules see nothing."""
    import csv
    rng = random.Random(seed)
    syms = [f"SYN{i:03d}-USDT-SWAP" for i in range(symbols)]
    price = {s: 10 * math.exp(rng.gauss(0, 1)) for s in syms}
    beta = {s: 0.6 + 0.8 * rng.random() for s in syms}
    sig_i = {s: 0.025 + 0.03 * rng.random() for s in syms}
    fund = {s: rng.gauss(3e-4, 3e-4) for s in syms}
    hist = {s: [] for s in syms}
    mkt_hist: list = []
    high = False
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["ts", "symbol", "open", "high", "low", "close", "volume", "eligible", "funding", "oi"])
        for d in range(days):
            if rng.random() < 0.02:
                high = not high
            sig_m = 0.05 if high else 0.02
            m = rng.gauss(0, sig_m)
            regime = 0.0
            if len(mkt_hist) >= 120:
                s20 = _std(mkt_hist[-20:])
                s120 = _std(mkt_hist[-120:])
                regime = s20 - s120
            r5 = {s: sum(hist[s][-5:]) for s in syms}
            vals = list(r5.values())
            mu, sd = sum(vals) / len(vals), (_std(vals) or 1.0)
            day_rets = []
            for s in syms:
                alpha = 0.0
                if plant and len(mkt_hist) >= 120:
                    sign = -1.0 if regime > 0 else 1.0
                    alpha = plant * sig_i[s] * sign * max(-3.0, min(3.0, (r5[s] - mu) / sd))
                var = beta[s] ** 2 * sig_m ** 2 + sig_i[s] ** 2
                r = beta[s] * m + rng.gauss(alpha, sig_i[s]) - 0.5 * var
                o = price[s]
                c = o * math.exp(r)
                hi = max(o, c) * math.exp(abs(rng.gauss(0, 0.01)))
                lo = min(o, c) * math.exp(-abs(rng.gauss(0, 0.01)))
                price[s] = c
                fund[s] = 3e-4 + 0.95 * (fund[s] - 3e-4) + rng.gauss(0, 1e-4)
                w.writerow([start_ms + d * 86_400_000, s, f"{o:.8g}", f"{hi:.8g}", f"{lo:.8g}", f"{c:.8g}",
                            f"{abs(rng.gauss(5e6, 2e6)):.2f}", 1, f"{fund[s]:.8f}", ""])
                hist[s].append(math.log(c / o))
                day_rets.append(math.log(c / o))
            mkt_hist.append(sum(day_rets) / len(day_rets))


def _std(xs):
    n = len(xs)
    if n < 2:
        return 0.0
    mu = sum(xs) / n
    return math.sqrt(sum((x - mu) ** 2 for x in xs) / (n - 1))


# ------------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description="Failure-guided program search on the bench search segment (research only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    for a in ("--panel", "--config", "--explore-ledger", "--report", "--promote-out", "--round"):
        p.add_argument(a, required=True)
    p.add_argument("--population", type=int, default=60)
    p.add_argument("--generations", type=int, default=20)
    p.add_argument("--promote", type=int, default=5)
    p.add_argument("--seed", type=int, default=40)
    p.add_argument("--seeds", help="JSON list of genomes proposed by an agent after reading the last report")
    p = sub.add_parser("synth")
    p.add_argument("--out", required=True)
    p.add_argument("--symbols", type=int, default=40)
    p.add_argument("--days", type=int, default=1100)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--plant", type=float, default=0.0)
    args = ap.parse_args(argv)
    if args.cmd == "synth":
        synthesize_regime_daily(args.out, args.symbols, args.days, args.seed, args.plant)
        return
    frozen = json.loads(Path(args.config).read_text())
    if "search_end_ts" not in frozen:
        raise SystemExit("frozen config has no search/validation split")
    panel = bench.load_panel(args.panel, tradable_only=True, end_ts=frozen["search_end_ts"])
    cfg, _ = bench.load_config(args.config, panel)
    seeds = json.loads(Path(args.seeds).read_text()) if args.seeds else []
    ev, history = search(panel, cfg, args.explore_ledger, args.population, args.generations, seed=args.seed,
                         seeds=seeds, log=print)
    top = diverse_top(ev, args.promote)
    hyps = [to_hypothesis(g, f"search-{args.round}-{i + 1}") for i, (g, _) in enumerate(top)]
    for (g, _), h in zip(top, hyps):  # promoted DSL must reproduce the cached search score exactly
        direct = bench.evaluate_expression(h["score"], ev.panel)
        cached = ev.score(g)
        assert all(direct[s].tobytes() == cached[s].tobytes() for s in ev.panel.symbols), describe(g)
    report = {"round": args.round, "search_end_utc": cfg["search_end_utc"], "evaluated": len(ev.seen),
              "history": history,
              "top": [{"id": h["id"], "genome": g, "describe": describe(g), "search_sharpe_annual": r["sharpe"],
                       "search_halves_sharpe": r["halves"], "ic_mean": r["ic"], "turnover": r["turnover"],
                       "regimes": regime_breakdown(ev, g)} for (g, r), h in zip(top, hyps)]}
    bench.write_exclusive(Path(args.report), report)
    batch = {"schema": bench.SCHEMA_HYP, "hypotheses": [
        {k: v for k, v in h.items() if k in ("id", "author", "rationale", "score", "horizon_bars", "weighting",
                                             "vol_window", "neutralize", "beta_window")}
        for h in hyps]}
    bench.write_exclusive(Path(args.promote_out), batch)
    print(json.dumps({"evaluated": len(ev.seen), "promoted": [h["id"] for h in hyps]}, indent=1))


if __name__ == "__main__":
    main()
