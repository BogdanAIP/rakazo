#!/usr/bin/env python3
"""Research-only intrinsic-event sequence controllers; no network or trading access.

All observations use the current *closed* 15-minute bar. Position decisions
become executable only on the next open in algorithm_event_lab.replay().
Directional-change clocks and sequence grammar are established prior art.
This is a new project-level representation, not a novel trading theorem.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path

from algorithm_event_lab import eventize, interpret, load as load_v2, replay
from algorithm_discovery_lab import base_features
from run_alpha_audited import verify_snapshot

SCHEMA = "algorithm_intrinsic_sequence_v3"
BRANCH_LIMIT = 10
# Frozen before any v3 market scores. No development-data parameter search.
PROTOCOL = {
    "fast_directional_change": 0.002,
    "slow_directional_change": 0.008,
    "max_pattern_bars": 96,
    "lease_bars": 8,
    "side_cost_base": 0.0007,
    "side_cost_stress": 0.0014,
    "allocation": 0.1,
}
# Relative fast-clock events since the last slow-clock reversal.
# After a slow + event, a fast -,+ is a correction/recovery sequence.
# Fast -,+,- is a recovery that fails again without a slow-clock reversal.
GRAMMAR = {
    "recoil-recovery": {"pattern": (-1, +1), "exposure": "slow", "role": "candidate"},
    "recovery-failure": {"pattern": (-1, +1, -1), "exposure": "opposite", "role": "candidate"},
    "first-recoil-control": {"pattern": (-1,), "exposure": "opposite", "role": "ablation"},
    "slow-event-control": {"pattern": (), "exposure": "slow", "role": "ablation"},
}


@dataclass
class DirectionalClock:
    threshold: float
    direction: int = 0
    anchor: float | None = None
    extreme: float | None = None

    def __post_init__(self):
        if not math.isfinite(self.threshold) or not 0 < self.threshold < 0.1:
            raise ValueError("Invalid directional-change threshold")

    def update(self, price: float) -> int:
        """Close-only first-passage crossing, returning a confirmed direction."""
        if not math.isfinite(price) or price <= 0:
            raise ValueError("Nonfinite or nonpositive observed close")
        if self.anchor is None:
            self.anchor = self.extreme = price
            return 0
        if self.direction == 0:
            if price >= self.anchor * (1 + self.threshold):
                self.direction, self.extreme = 1, price
                return 1
            if price <= self.anchor * (1 - self.threshold):
                self.direction, self.extreme = -1, price
                return -1
            return 0
        if self.direction == 1:
            if price > self.extreme:
                self.extreme = price
            elif price <= self.extreme * (1 - self.threshold):
                self.direction, self.extreme = -1, price
                return -1
        else:
            if price < self.extreme:
                self.extreme = price
            elif price >= self.extreme * (1 + self.threshold):
                self.direction, self.extreme = 1, price
                return 1
        return 0


def validate_protocol(config: dict):
    if not isinstance(config, dict) or set(config) != set(PROTOCOL):
        raise ValueError("Unexpected protocol keys")
    for key, val in config.items():
        if type(val) not in (int, float) or not math.isfinite(val):
            raise ValueError("Nonfinite protocol")
    if not 0 < config["fast_directional_change"] < config["slow_directional_change"] < .1:
        raise ValueError("Expected fast clock strictly below slow clock")
    for name in ("lease_bars", "max_pattern_bars"):
        if type(config[name]) is not int or not 1 <= config[name] <= 256:
            raise ValueError("Invalid duration")
    if not 0 < config["allocation"] <= 1:
        raise ValueError("Invalid allocation")
    if not 0 <= config["side_cost_base"] < config["side_cost_stress"] <= .01:
        raise ValueError("Invalid costs")


def decisions(bars, mode: str, config=None):
    """One bounded exposure per slow-clock epoch, no same-close fill.

    A slow directional-change reset cancels the preceding ledger and exposure.
    When a pattern expires without completion, pending evidence is discarded.
    Controls share *exactly* the clocks, lease and cost protocol with candidates.
    """
    cfg = PROTOCOL if config is None else config
    validate_protocol(cfg)
    if mode not in GRAMMAR:
        raise ValueError("Unknown frozen controller")
    policy = GRAMMAR[mode]
    slow = DirectionalClock(cfg["slow_directional_change"])
    fast = DirectionalClock(cfg["fast_directional_change"])
    slow_dir, remaining, target = 0, 0, 0
    ledger = []
    first_bar = None
    consumed = False
    actions = []
    trace = []
    event_counts = {"fast": 0, "slow": 0, "entries": 0, "patterns_expired": 0}

    for i, bar in enumerate(bars):
        price = bar.cl
        fast_event = fast.update(price)
        slow_event = slow.update(price)
        event_counts["fast"] += int(fast_event != 0)
        event_counts["slow"] += int(slow_event != 0)
        if slow_event:
            # Epoch boundary has priority even if both clocks trigger together.
            slow_dir, remaining, target = slow_event, 0, 0
            ledger, first_bar, consumed = [], None, False
            trace.append({"bar": i, "kind": "slow_reset", "direction": slow_dir})
            if mode == "slow-event-control":
                target, remaining, consumed = slow_dir, cfg["lease_bars"], True
                event_counts["entries"] += 1
                trace.append({"bar": i, "kind": "entry", "direction": target})
        elif remaining:
            remaining -= 1
            if remaining == 0:
                target = 0
                trace.append({"bar": i, "kind": "expiry"})
        elif not consumed and slow_dir:
            if first_bar is not None and i - first_bar > cfg["max_pattern_bars"]:
                ledger, first_bar = [], None
                event_counts["patterns_expired"] += 1
            if fast_event:
                relative = fast_event * slow_dir
                pattern = policy["pattern"]
                if not pattern:
                    raise AssertionError("Slow control only acts on slow events")
                expected = pattern[len(ledger)]
                if relative == expected:
                    if first_bar is None:
                        first_bar = i
                    ledger.append(relative)
                    trace.append({"bar": i, "kind": "symbol", "relative": relative})
                    if len(ledger) == len(pattern):
                        target = slow_dir if policy["exposure"] == "slow" else -slow_dir
                        remaining, consumed = cfg["lease_bars"], True
                        event_counts["entries"] += 1
                        trace.append({"bar": i, "kind": "entry", "direction": target})
                else:
                    # Restart only on the first pattern symbol, never skip a
                    # contradictory observation and keep the old hypothesis.
                    ledger = [relative] if relative == pattern[0] else []
                    first_bar = i if ledger else None
                    trace.append({"bar": i, "kind": "reset", "relative": relative})
        actions.append(target)
    return actions, trace, event_counts


def scores(bars, actions, config):
    result = {}
    for label, cost in (("base", config["side_cost_base"]), ("double", config["side_cost_stress"])):
        row = replay(bars, actions, side_cost=cost, allocation=config["allocation"])
        result[label] = {k: v for k, v in row.items() if k not in ("equity_path", "changes")}
    return result


def development(bars, prior, config=None):
    """Development partitions only. Final 20% never enters a feature builder."""
    cfg = PROTOCOL if config is None else config
    validate_protocol(cfg)
    if len(bars) < 1200:
        raise ValueError("Insufficient contiguous observations")
    n = len(bars)
    segments = (("train", 0, int(n * .6)),
                ("exposed_development", int(n * .6), int(n * .8)))
    result = []
    for name, begin, end in segments:
        sample = bars[begin:end]  # strict left-side of reserved holdout
        for mode in GRAMMAR:
            actions, trace, counts = decisions(sample, mode, cfg)
            result.append({"id": mode, "role": GRAMMAR[mode]["role"],
                           "segment": name, "range": [begin, end],
                           "scores": scores(sample, actions, cfg),
                           "event_counts": counts, "trace_sample": trace[:BRANCH_LIMIT]})
            # An intentionally NONCAUSAL destroyed-timing comparison; cyclic
            # shift holds target occupancy but may change the boundary trades.
            # NEVER use placebo as a live signal or significance p-value.
            if GRAMMAR[mode]["role"] == "candidate":
                shift = len(actions) // 3
                rotated = actions[-shift:] + actions[:-shift]
                result.append({"id": mode + "-cyclic-null", "role": "noncausal_diagnostic",
                               "segment": name, "range": [begin, end],
                               "scores": scores(sample, rotated, cfg),
                               "shift_bars": shift})
        if prior:
            table = base_features(sample)
            for d in prior:
                actions, _ = interpret(d, eventize(d, table))
                result.append({"id": "v2-" + d["id"], "role": "v2_frozen_comparator",
                               "segment": name, "range": [begin, end],
                               "scores": scores(sample, actions, cfg)})
        result.append({"id": "cash", "role": "cash", "segment": name,
                       "range": [begin, end],
                       "scores": scores(sample, [0] * len(sample), cfg)})
    return {"rows": result, "holdout_used": False,
            "reserved_range": [int(n * .8), n], "fresh_validation": False}


def protocol_hash():
    payload = {"schema": SCHEMA, "protocol": PROTOCOL, "grammar": GRAMMAR}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--csv", nargs="+", required=True, type=Path)
    p.add_argument("--v2", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    args = p.parse_args()
    if args.out.exists():
        raise FileExistsError("Research reports must have a new unique name")
    prior = load_v2(args.v2)
    seen_symbols, seen_hashes = set(), set()
    markets = []
    for path in args.csv:
        bars, manifest, checksum = verify_snapshot(path, path.with_suffix(".manifest.json"))
        if manifest["symbol"] in seen_symbols or checksum in seen_hashes:
            raise ValueError("Duplicate market or archive")
        seen_symbols.add(manifest["symbol"])
        seen_hashes.add(checksum)
        markets.append({"symbol": manifest["symbol"], "bars": len(bars),
                        "dataset_sha256": checksum, "source": manifest["source"],
                        **development(bars, prior)})
    report = {"schema": SCHEMA, "mode": "EXPLORATORY_ONLY", "markets": markets,
              "protocol": PROTOCOL, "grammar": GRAMMAR, "protocol_sha256": protocol_hash(),
              "all_variants_reported": True, "fresh_validation": False,
              "can_start_paper": False, "can_submit_orders": False,
              "scientific_novelty_proven": False, "predictive_edge_proven": False,
              "inference": "NO_PVALUES_FROM_EXPOSED_DEVELOPMENT"}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=True, allow_nan=False)
        fh.write("\n")
    print(json.dumps({"markets": len(markets), "protocol_sha256": protocol_hash(),
                      "holdout_used": False, "can_submit_orders": False}))


if __name__ == "__main__":
    main()
