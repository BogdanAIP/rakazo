"""J7 offline margin simulator: what 20x isolated margin does to a long/short book.

Research only, stdlib only, synthetic paths only. No exchange, network, keys, orders,
PAPER or Trader; it never reads the bench panels, ledger or gates. Every number here is
an illustrative assumption (fees, maintenance rate, funding, jumps), not an exchange
schedule; the report says so.

Mechanics per isolated leg, bar by bar (hourly bars), using nothing after the decision:
  entry     next bar's open, adverse slippage, taker fee on notional;
  liquidation  checked on the bar's adverse extreme (a conservative mark proxy); the leg
            loses its whole isolated margin; if the same bar also crosses the stop,
            liquidation wins; ADL and the insurance fund are not modelled;
  stop      fills at the worse of the stop price and the bar's open (gap-through);
  funding   every 8 bars on notional, longs pay a positive rate, debited from the
            isolated margin, so it moves the liquidation price;
  exit      after `hold` bars at the open, slippage and fee.
A leg is skipped, never topped up, when its liquidation is not beyond `liq_buffer` x stop,
when the asset's maximum leverage is below the variant's, or when the book margin cap,
the stress-loss cap or free cash would be breached.

Variants share one scenario set (common random numbers), so their differences are not
sampling noise:
  fixed20         L = 20, margin = cap x equity
  adaptive20      L = 20, margin = min(cap x E, budget x E / (20 x (stop + cost)))
  buffered20      margin = cap x E, notional lowered so liquidation clears the buffer
  x1_same_margin  L = 1, margin = notional = cap x E (what the leverage adds)
  x1_same_notional L = 1, notional of fixed20 (mechanics: equal P&L until liquidation)
  x1_matched_risk L = 1, notional of adaptive20 (same planned loss at the stop)
  levL            any leverage L with margin = cap x E (for leverage sweeps, e.g. lev3)
The last two are fully funded references: a 1x book of that notional would need more cash
than the account has, so they skip the cash, book and stress checks.

  python margin_sim_v40.py run --scenario SCENARIO.json --out REPORT.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from dataclasses import asdict, dataclass, replace
from pathlib import Path

FUNDING_EVERY = 8  # bars (hours) between settlements
VARIANTS = ("fixed20", "adaptive20", "buffered20", "x1_same_margin", "x1_same_notional", "x1_matched_risk")


@dataclass(frozen=True)
class Scenario:
    seed: int = 1
    paths: int = 40
    assets: int = 12
    bars: int = 24 * 60
    market_vol_daily: tuple = (0.03, 0.06)   # calm, stressed
    regime_switch_per_day: float = 0.03
    idio_vol_daily: tuple = (0.025, 0.05)    # range across assets
    beta: tuple = (0.7, 1.4)
    common_jump_per_day: float = 0.02         # market gap, size N(0, common_jump)
    common_jump: float = 0.06
    squeeze_per_day: float = 0.004            # single-name gap up, size U(0.1, squeeze_max)
    squeeze_max: float = 0.4
    dispersion_per_day: float = 0.01          # recent winners gap down, losers up
    dispersion_jump: float = 0.05
    funding_base: float = 0.0001              # per 8 h
    funding_vol: float = 0.0002
    max_leverage: tuple = (50, 50, 25, 20, 20, 20, 20, 20, 10, 10, 10, 5)  # cycled over assets
    momentum_drift_daily: float = 0.0         # planted edge: top-3 / bottom-3 by 7-day return drift +/- this


@dataclass(frozen=True)
class Params:
    variant: str = "fixed20"
    equity0: float = 1000.0
    margin_cap: float = 0.03          # owner's primary: <= 3% of equity per position
    risk_budget: float = 0.01         # adaptive20 / x1_matched_risk: planned loss at stop / equity
    stake_base: str = "current"       # "current" | "initial" equity
    fee: float = 0.0005               # taker, per side, on notional
    slippage: float = 0.0005          # adverse, per fill
    mmr: float = 0.005                # maintenance margin rate
    liq_buffer: float = 1.5           # liquidation distance must exceed this x stop
    stop_floor: float = 0.01
    stop_k: float = 1.0               # stop = max(floor, k x trailing vol over the hold)
    hold: int = 24                    # bars
    legs_per_side: int = 3
    lookback: int = 24 * 7            # bars for the momentum signal and the vol estimate
    book_cap: float = 0.24            # total isolated margin / equity
    stress_cap: float = 0.15          # all leveraged margins lost + 1x legs at stress move, / equity
    stress_move: float = 0.3          # adverse move assumed for 1x legs in the stress cap


# ----------------------------------------------------------------- scenarios

def generate(sc: Scenario):
    """Per path: dict(open, high, low, close, funding) as [asset][bar] lists, plus max leverage.
    Jumps are gaps at the open, so stops can be jumped. Deterministic for the seed."""
    out = []
    for p in range(sc.paths):
        rng = random.Random(f"j7-{sc.seed}-{p}")
        n, T = sc.assets, sc.bars
        beta = [rng.uniform(*sc.beta) for _ in range(n)]
        ivol = [rng.uniform(*sc.idio_vol_daily) / math.sqrt(24) for _ in range(n)]
        price = [10.0 * math.exp(rng.gauss(0, 1)) for _ in range(n)]
        fund = [sc.funding_base] * n
        O, H, L, C, F = ([[0.0] * T for _ in range(n)] for _ in range(5))
        stressed = False
        logp = [[math.log(x)] for x in price]
        for t in range(T):
            if rng.random() < sc.regime_switch_per_day / 24:
                stressed = not stressed
            mvol = sc.market_vol_daily[1 if stressed else 0] / math.sqrt(24)
            gap = [0.0] * n
            if rng.random() < sc.common_jump_per_day / 24:
                j = rng.gauss(0, sc.common_jump)
                gap = [b * j for b in beta]
            if rng.random() < sc.dispersion_per_day / 24 and t > 24:
                past = [lp[-1] - lp[max(0, len(lp) - 1 - 24 * 7)] for lp in logp]
                mid = sorted(past)[n // 2]
                gap = [g - sc.dispersion_jump if x >= mid else g + sc.dispersion_jump for g, x in zip(gap, past)]
            if rng.random() < sc.squeeze_per_day / 24 * n:
                k = rng.randrange(n)
                gap[k] += math.log(1 + rng.uniform(0.1, sc.squeeze_max))
            m = rng.gauss(0, mvol)
            drift = [0.0] * n
            if sc.momentum_drift_daily and t >= 24 * 7:  # no random draws, so paths match otherwise
                ranked = sorted(range(n), key=lambda a: logp[a][-1] - logp[a][-1 - 24 * 7])
                for a in ranked[-3:]:
                    drift[a] = sc.momentum_drift_daily / 24
                for a in ranked[:3]:
                    drift[a] = -sc.momentum_drift_daily / 24
            for a in range(n):
                o = price[a] * math.exp(gap[a])
                r = beta[a] * m + rng.gauss(0, ivol[a]) + drift[a]
                c = o * math.exp(r)
                wick = ivol[a] + beta[a] * mvol
                O[a][t], C[a][t] = o, c
                H[a][t] = max(o, c) * math.exp(abs(rng.gauss(0, 0.5 * wick)))
                L[a][t] = min(o, c) * math.exp(-abs(rng.gauss(0, 0.5 * wick)))
                if t % FUNDING_EVERY == 0:
                    fund[a] = sc.funding_base + 0.7 * (fund[a] - sc.funding_base) + rng.gauss(0, sc.funding_vol)
                F[a][t] = fund[a] if t % FUNDING_EVERY == FUNDING_EVERY - 1 else 0.0
                price[a] = c
                logp[a].append(math.log(c))
        lev = [sc.max_leverage[a % len(sc.max_leverage)] for a in range(n)]
        out.append({"open": O, "high": H, "low": L, "close": C, "funding": F, "max_leverage": lev})
    return out


def scenario_sha(sc: Scenario) -> str:
    d = asdict(sc)
    if not d["momentum_drift_daily"]:  # added later; omitted when off so earlier SHAs still hold
        del d["momentum_drift_daily"]
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()


# ----------------------------------------------------------------- mechanics

def liquidation_price(side: int, entry: float, qty: float, margin: float, mmr: float) -> float:
    """Price at which isolated margin plus P&L equals maintenance on the current notional."""
    if side > 0:
        return max(0.0, (qty * entry - margin) / (qty * (1 - mmr)))
    return (qty * entry + margin) / (qty * (1 + mmr))


def size(p: Params, equity: float, stop: float) -> tuple:
    """(margin, notional) for one leg, before feasibility checks."""
    cost = 2 * (p.fee + p.slippage)
    base = equity if p.stake_base == "current" else p.equity0
    cap = p.margin_cap * base
    if p.variant == "fixed20":
        return cap, 20 * cap
    if p.variant.startswith("lev"):  # levL: margin = cap x E, leverage L (sweeps)
        return cap, float(p.variant[3:]) * cap
    if p.variant == "adaptive20":
        m = min(cap, p.risk_budget * base / (20 * (stop + cost)))
        return m, 20 * m
    if p.variant == "buffered20":
        n = min(20 * cap, cap / (p.liq_buffer * stop + p.mmr + cost))
        return cap, n
    if p.variant == "x1_same_margin":
        return cap, cap
    if p.variant == "x1_same_notional":
        return 20 * cap, 20 * cap
    if p.variant == "x1_matched_risk":
        n = min(20 * cap, p.risk_budget * base / (stop + cost))
        return n, n
    raise ValueError(p.variant)


@dataclass
class Leg:
    asset: int
    side: int
    entry: float
    qty: float
    margin: float      # isolated margin left (after funding)
    margin0: float
    notional: float
    stop_price: float
    liq_price: float
    planned_loss: float
    exit_bar: int
    leveraged: bool
    fee_paid: float
    funding_paid: float = 0.0


def _signal(path, t, p: Params):
    """Momentum ranks from closes up to bar t only: (longs, shorts)."""
    c = path["close"]
    t0 = max(0, t - p.lookback)
    rets = sorted((math.log(c[a][t] / c[a][t0]), a) for a in range(len(c)))
    k = p.legs_per_side
    return [a for _, a in rets[-k:]], [a for _, a in rets[:k]]


def _hold_vol(path, a, t, lookback, hold):
    c = path["close"][a]
    xs = [math.log(c[i] / c[i - 1]) for i in range(max(1, t - lookback + 1), t + 1)]
    if len(xs) < 2:
        return 0.0
    mu = math.fsum(xs) / len(xs)
    return math.sqrt(math.fsum((x - mu) * (x - mu) for x in xs) / (len(xs) - 1) * hold)


def _stress(legs, p: Params) -> float:
    """Loss if every leveraged leg is liquidated and every 1x leg moves stress_move against it."""
    return sum(l.margin0 if l.leveraged else p.stress_move * l.notional for l in legs)


def simulate_path(path, p: Params, log=None) -> dict:
    """One variant on one path. `log`, if given, receives every entry decision."""
    O, Hh, Lw, C, F = path["open"], path["high"], path["low"], path["close"], path["funding"]
    T = len(C[0])
    free, legs = p.equity0, []
    st = {"entries": 0, "stops": 0, "liquidations": 0, "exits": 0, "skips": {}, "fees": 0.0, "funding": 0.0,
          "margin_posted": 0.0, "gross": 0.0, "closed": 0, "stop_loss_ratio": [], "batches": 0, "batches_with_liq": 0, "max_margin_share": 0.0}
    curve, peak, mdd = [], p.equity0, 0.0

    def equity(t):
        return free + sum(max(0.0, l.margin + l.side * l.qty * (C[l.asset][t] - l.entry)) for l in legs)

    def skip(reason):
        st["skips"][reason] = st["skips"].get(reason, 0) + 1

    batch_liq, next_t = None, p.lookback
    reference = p.variant in ("x1_same_notional", "x1_matched_risk")
    for t in range(T):
        # 1. existing legs during bar t
        for l in list(legs):
            a = l.asset
            if t == l.exit_bar:  # exit at this bar's open, unless the open gapped past liquidation
                if (O[a][t] <= l.liq_price) if l.side > 0 else (O[a][t] >= l.liq_price):
                    st["liquidations"] += 1
                    if batch_liq is not None:
                        batch_liq[0] = True
                    legs.remove(l)
                    continue
                px = O[a][t] * (1 - l.side * p.slippage)
                fee = p.fee * l.qty * px
                st["gross"] += l.side * (O[a][t] / (l.entry / (1 + l.side * p.slippage)) - 1)
                st["closed"] += 1
                free += max(0.0, l.margin + l.side * l.qty * (px - l.entry) - fee)  # isolated: never below zero
                st["fees"] += fee
                st["exits"] += 1
                legs.remove(l)
                continue
            adverse = Lw[a][t] if l.side > 0 else Hh[a][t]
            crossed = (lambda x: adverse <= x) if l.side > 0 else (lambda x: adverse >= x)
            if crossed(l.liq_price):
                st["liquidations"] += 1
                if batch_liq is not None:
                    batch_liq[0] = True
                legs.remove(l)  # the isolated margin is gone
                continue
            if crossed(l.stop_price):
                o = O[a][t]
                gap = (o < l.stop_price) if l.side > 0 else (o > l.stop_price)
                px = (o if gap else l.stop_price) * (1 - l.side * p.slippage)
                st["gross"] += l.side * ((o if gap else l.stop_price) / (l.entry / (1 + l.side * p.slippage)) - 1)
                st["closed"] += 1
                fee = p.fee * l.qty * px
                pnl = l.side * l.qty * (px - l.entry)
                free += max(0.0, l.margin + pnl - fee)
                st["fees"] += fee
                st["stops"] += 1
                st["stop_loss_ratio"].append((-(pnl - fee - l.fee_paid) + l.funding_paid) / l.planned_loss)
                legs.remove(l)
                continue
            if F[a][t]:
                pay = l.side * F[a][t] * l.qty * C[a][t]
                l.margin -= pay
                l.funding_paid += pay
                st["funding"] += pay
                l.liq_price = liquidation_price(l.side, l.entry, l.qty, l.margin, p.mmr)
                if l.margin <= 0:
                    st["liquidations"] += 1
                    legs.remove(l)
        e = equity(t)
        curve.append(e)
        peak = max(peak, e)
        mdd = max(mdd, 1 - e / peak if peak > 0 else 0.0)
        # 2. decision at the close of bar t, fills at bar t + 1
        if t < next_t or t + 1 + p.hold >= T or legs:
            continue
        next_t = t + p.hold
        if batch_liq is not None:
            st["batches"] += 1
            st["batches_with_liq"] += batch_liq[0]
        batch_liq = [False]
        longs, shorts = _signal(path, t, p)
        for side, assets in ((1, longs), (-1, shorts)):
            for a in assets:
                stop = max(p.stop_floor, p.stop_k * _hold_vol(path, a, t, p.lookback, p.hold))
                m, n = size(p, e, stop)
                if log is not None:
                    log.append((t, a, side, e, m, n))
                if m <= 0 or n <= 0:
                    skip("zero_stake")
                    continue
                lev = n / m
                if lev > 1 + 1e-12 and lev > path["max_leverage"][a] + 1e-12:
                    skip("leverage_unavailable")
                    continue
                entry = O[a][t + 1] * (1 + side * p.slippage)
                qty = n / entry
                fee = p.fee * n
                leveraged = lev > 1 + 1e-12
                liq = liquidation_price(side, entry, qty, m, p.mmr)
                if leveraged and abs(liq / entry - 1) < p.liq_buffer * stop:
                    skip("liquidation_inside_buffer")
                    continue
                posted = sum(l.margin0 for l in legs)
                if reference:
                    pass
                elif posted + m > p.book_cap * e + 1e-9:
                    skip("book_cap")
                    continue
                elif _stress(legs, p) + (m if leveraged else p.stress_move * n) > p.stress_cap * e + 1e-9:
                    skip("stress_cap")
                    continue
                elif m + fee > free:
                    skip("cash")
                    continue
                free -= m + fee
                st["fees"] += fee
                st["entries"] += 1
                st["margin_posted"] += m
                st["max_margin_share"] = max(st["max_margin_share"], (posted + m) / e)
                stop_price = entry * (1 - side * stop)
                cost = 2 * (p.fee + p.slippage)
                legs.append(Leg(a, side, entry, qty, m, m, n, stop_price, liq, n * (stop + cost), t + 1 + p.hold,
                                leveraged, fee))
    if batch_liq is not None:
        st["batches"] += 1
        st["batches_with_liq"] += batch_liq[0]
    st["terminal_equity"] = curve[-1]
    st["max_drawdown"] = mdd
    return st


# ------------------------------------------------------------------ report

def _q(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(math.floor(q * (len(xs) - 1)))))]


def _cvar(xs, q):
    xs = sorted(xs)
    k = max(1, int(math.ceil(q * len(xs))))
    return math.fsum(xs[:k]) / k


def run(sc: Scenario, base: Params, variants=VARIANTS) -> dict:
    paths = generate(sc)
    out = {"scenario": asdict(sc), "scenario_sha256": scenario_sha(sc), "params": asdict(base),
           "assumptions": "illustrative fees, maintenance, funding and jumps; synthetic paths only; "
                          "no ADL, insurance fund or exchange-specific rules; not a forecast", "variants": {}}
    for v in variants:
        p = replace(base, variant=v)
        res = [simulate_path(path, p) for path in paths]
        r = [x["terminal_equity"] / p.equity0 - 1 for x in res]
        ratios = [y for x in res for y in x["stop_loss_ratio"]]
        posted = math.fsum(x["margin_posted"] for x in res)
        skips: dict = {}
        for x in res:
            for k, c in x["skips"].items():
                skips[k] = skips.get(k, 0) + c
        batches = sum(x["batches"] for x in res)
        out["variants"][v] = {
            "terminal_return_median": _q(r, 0.5), "terminal_return_p5": _q(r, 0.05), "terminal_return_p1": _q(r, 0.01),
            "cvar95": _cvar(r, 0.05), "cvar99": _cvar(r, 0.01),
            "prob_lose_half": sum(1 for x in r if x <= -0.5) / len(r),
            "max_drawdown_median": _q([x["max_drawdown"] for x in res], 0.5),
            "max_drawdown_p95": _q([x["max_drawdown"] for x in res], 0.95),
            "entries": sum(x["entries"] for x in res), "stops": sum(x["stops"] for x in res),
            "liquidations": sum(x["liquidations"] for x in res), "skips": skips,
            "prob_batch_with_liquidation": sum(x["batches_with_liq"] for x in res) / batches if batches else None,
            "stop_realised_over_planned_median": _q(ratios, 0.5) if ratios else None,
            "fees_over_margin": math.fsum(x["fees"] for x in res) / posted if posted else None,
            "funding_over_margin": math.fsum(x["funding"] for x in res) / posted if posted else None,
            "max_margin_share": max(x["max_margin_share"] for x in res),
            "gross_move_per_closed_trade": (math.fsum(x["gross"] for x in res) / sum(x["closed"] for x in res)
                                            if sum(x["closed"] for x in res) else None),
        }
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="J7 offline margin simulator (synthetic paths only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--scenario", type=Path, help="JSON with Scenario and optional 'params' fields")
    r.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    cfg = json.loads(args.scenario.read_text()) if args.scenario else {}
    params = Params(**cfg.pop("params", {}))
    sc = Scenario(**{k: tuple(v) if isinstance(v, list) else v for k, v in cfg.items()})
    report = run(sc, params)
    if args.out.exists():
        raise SystemExit(f"refusing to overwrite {args.out}")
    args.out.write_text(json.dumps(report, indent=1, sort_keys=True) + "\n")
    for v, s in report["variants"].items():
        print(f"{v:18s} median {s['terminal_return_median']:+.3f}  p5 {s['terminal_return_p5']:+.3f}  "
              f"liq {s['liquidations']:4d}  stops {s['stops']:4d}  P(-50%) {s['prob_lose_half']:.3f}")


if __name__ == "__main__":
    main()
