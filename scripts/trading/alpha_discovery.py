#!/usr/bin/env python3
"""Offline Alpha Discovery. Research only: NO orders, exchange, network or scheduler."""
import argparse
import csv
import hashlib
import json
import math
import random
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

FEE_BPS = 5
SLIPPAGE_BPS = 2
ALLOCATION = 0.10
MIN_BARS = 480

@dataclass(frozen=True)
class Candle:
    time: datetime
    op: float
    hi: float
    lo: float
    cl: float
    volume: float

@dataclass(frozen=True, order=True)
class Rule:
    mode: str
    lookback: int
    threshold: float
    stop: float
    target: float

def load_csv(path):
    raw = Path(path).read_bytes()
    rows, symbols = [], set()
    with Path(path).open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        required = {"timestamp", "open", "high", "low", "close", "volume", "symbol"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Missing CSV columns")
        for row in reader:
            t = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
            if t.tzinfo is None or t.utcoffset() != timedelta(0):
                raise ValueError("UTC timestamps required")
            nums = [float(row[k]) for k in ("open", "high", "low", "close", "volume")]
            if not all(math.isfinite(v) for v in nums):
                raise ValueError("Non-finite candle value")
            op, hi, lo, cl, vol = nums
            if min(op, hi, lo, cl) <= 0 or vol < 0 or not lo <= min(op, cl) <= max(op, cl) <= hi:
                raise ValueError("Invalid OHLCV")
            if rows and t - rows[-1].time != timedelta(minutes=15):
                raise ValueError("Non-contiguous 15m UTC candles")
            rows.append(Candle(t, op, hi, lo, cl, vol))
            symbols.add(row["symbol"].strip())
    if len(rows) < MIN_BARS or len(symbols) != 1 or "" in symbols:
        raise ValueError("Need >=480 candles for one symbol")
    return rows, hashlib.sha256(raw).hexdigest()

def signal(candles, rule, i):
    if i < rule.lookback:
        return 0
    momentum = candles[i].cl / candles[i - rule.lookback].cl - 1
    if abs(momentum) < rule.threshold:
        return 0
    direction = 1 if momentum > 0 else -1
    return direction if rule.mode == "trend" else -direction

def trade(candles, rule, i):
    """Signal uses candle i CLOSE; fill and exit are inside NEXT candle only."""
    direction = signal(candles, rule, i)
    if not direction or i + 1 >= len(candles):
        return None
    future = candles[i + 1]
    if abs(future.op / candles[i].cl - 1) > 0.015:
        return None
    op = future.op
    if direction > 0:
        stop, target = op * (1 - rule.stop), op * (1 + rule.target)
        # Stop first if stop and target are both touched.
        exit_price = stop if future.lo <= stop else target if future.hi >= target else future.cl
    else:
        stop, target = op * (1 + rule.stop), op * (1 - rule.target)
        exit_price = stop if future.hi >= stop else target if future.lo <= target else future.cl
    return direction * (exit_price / op - 1) - 2 * (FEE_BPS + SLIPPAGE_BPS) / 10000

def statistics(returns):
    equity = peak = 1.0
    dd = 0.0
    for r in returns:
        equity *= 1 + ALLOCATION * r
        peak = max(peak, equity)
        dd = max(dd, 1 - equity / peak)
    return {"trades": len(returns), "return": round(equity - 1, 8),
            "drawdown": round(dd, 8),
            "win_rate": round(sum(r > 0 for r in returns) / len(returns), 5) if returns else None}

def replay(candles, rule, start, end):
    # A trade must close before end. This prevents leaking across split boundaries.
    results = (trade(candles, rule, i)
               for i in range(max(start, rule.lookback), end - 1))
    return statistics([x for x in results if x is not None])

def fitness(stats):
    return stats["return"] - 1.5 * stats["drawdown"]

def initial_rules():
    return [Rule(mode, n, threshold, stop, round(stop * 1.5, 6))
            for mode in ("trend", "reversal") for n in (4, 8, 16, 32)
            for threshold in (0.001, 0.003, 0.006) for stop in (0.006, 0.012)]

def evolve(leaders, rng):
    candidates = set()
    for r in leaders:
        for _ in range(10):
            move = rng.choice(("mode", "lookback", "threshold", "stop"))
            mode, n, threshold, stop = r.mode, r.lookback, r.threshold, r.stop
            if move == "mode":
                mode = "trend" if mode == "reversal" else "reversal"
            elif move == "lookback":
                n = max(2, min(64, n + rng.choice((-4, -2, 2, 4))))
            elif move == "threshold":
                threshold = round(max(0.0005, min(0.02, threshold * rng.choice((0.7, 1.3)))), 6)
            else:
                stop = round(max(0.002, min(0.04, stop * rng.choice((0.7, 1.3)))), 6)
            candidates.add(Rule(mode, n, threshold, stop, round(stop * 1.5, 6)))
    return sorted(candidates)

def adaptive(candles, approved, start, end):
    """Learn from trailing CLOSED trades only; abstain without recent evidence."""
    returns, abstentions, selection = [], 0, {}
    for i in range(start, end - 1):
        best, best_score = None, 0
        for rule in approved:
            recent = replay(candles, rule, max(0, i - 144), i + 1)
            if recent["trades"] >= 3 and fitness(recent) > best_score:
                best, best_score = rule, fitness(recent)
        if best is None:
            abstentions += 1
            continue
        selection[str(best)] = selection.get(str(best), 0) + 1
        r = trade(candles, best, i)
        if r is not None:
            returns.append(r)
    return {**statistics(returns), "no_trade_bars": abstentions,
            "selection_counts": selection}

def discover(candles, seed=42, rounds=3):
    if not 1 <= rounds <= 10:
        raise ValueError("Rounds must be 1..10")
    n = len(candles)
    train_end, validation_end = int(n * 0.6), int(n * 0.8)
    seen, pool, rng, history = {}, initial_rules(), random.Random(seed), []
    for j in range(rounds):
        for rule in pool:
            if rule not in seen:
                seen[rule] = replay(candles, rule, 0, train_end)
        leaders = sorted(seen, key=lambda r: fitness(seen[r]), reverse=True)[:8]
        history.append({"round": j + 1, "candidates": len(seen),
                        "best_train_fitness": round(fitness(seen[leaders[0]]), 8)})
        pool = [r for r in evolve(leaders[:4], rng) if r not in seen]
        if not pool:
            break
    # Exploration NEVER consults the holdout. Validation only checks train finalists.
    finalists = sorted(seen, key=lambda r: fitness(seen[r]), reverse=True)[:12]
    accepted = []
    for rule in finalists:
        t = seen[rule]
        v = replay(candles, rule, train_end, validation_end)
        if (t["trades"] >= 8 and v["trades"] >= 4 and t["return"] > 0
                and v["return"] > 0 and v["drawdown"] <= 0.03):
            accepted.append((rule, t, v))
    accepted.sort(key=lambda x: fitness(x[2]), reverse=True)
    report = {"version": "alpha-discovery-v0", "execution": "OFFLINE_ONLY",
              "can_submit_orders": False, "can_access_exchange": False,
              "candles": n, "split": {"train": [0, train_end],
              "validation": [train_end, validation_end],
              "holdout": [validation_end, n]},
              "assumptions": {"fee_bps_each_side": FEE_BPS,
              "slippage_bps_each_side": SLIPPAGE_BPS, "allocation": ALLOCATION,
              "no_leverage": True, "one_bar_holding": True},
              "search": {"seed": seed, "rounds": history, "tried": len(seen),
              "validation_tested": len(finalists), "accepted": len(accepted)},
              "status": "PROVISIONAL" if accepted else "NO_VALIDATED_EDGE",
              "selected": None, "holdout": None,
              "next": "REVIEW_FOR_PAPER_MANUALLY" if accepted else "CONTINUE_RESEARCH_ON_NEW_DATA_AND_NO_TRADE"}
    if accepted:
        best, train, valid = accepted[0]
        approved = [x[0] for x in accepted[:3]]
        report["selected"] = {"rule": asdict(best), "train": train,
                              "validation": valid, "pool": len(approved)}
        report["holdout"] = {"fixed": replay(candles, best, validation_end, n),
                             "adaptive": adaptive(candles, approved, validation_end, n)}
    return report

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--rounds", type=int, default=3)
    args = p.parse_args()
    if args.out.resolve() == args.csv.resolve() or args.out.exists():
        raise ValueError("Output must be a NEW file, different from source")
    candles, digest = load_csv(args.csv)
    report = discover(candles, seed=args.seed, rounds=args.rounds)
    report["dataset_sha256"] = digest
    report["start_utc"] = candles[0].time.isoformat()
    report["end_utc"] = candles[-1].time.isoformat()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    print(json.dumps({"status": report["status"], "tried": report["search"]["tried"],
                      "accepted": report["search"]["accepted"]}, sort_keys=True))

if __name__ == "__main__":
    main()
