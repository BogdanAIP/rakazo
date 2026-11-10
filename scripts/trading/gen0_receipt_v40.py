"""Data-free generation-0 receipt: binds --seed, --population and the absence of --seeds to outputs.

Why (GPT 2026-11-10 05:49 Moscow): the pinned `run` report records neither the numeric seed nor
an optional `--seeds` genome file, and `null_ledger_receipt_v40.py` cannot see them either, so the
real r3 report's provenance rested on the preserved invocation alone.

But the first generation needs no market data: `search()` draws it as
`[repair(rng, random_genome(rng)) for _ in range(population - len(seeds))]` with
`rng = random.Random(seed)`, before any evaluation, from the library and `allowed_horizons`
(which depends only on the frozen config's search end, holdout start and the bar step).
Generation 0 is evaluated in population order and a repeated genome is served from the cache,
so the first rows a run writes are exactly the distinct generation-0 genomes, in order, one row
per panel each. Every null with the same GA seed starts from the same generation 0.

This helper rebuilds that list and requires:
  - run:  the `claude-search` rows begin with exactly those genomes, one group of --panels rows
          each, the report's library is --library, history has --generations entries numbered
          0..G-1, history[0].evaluated_total equals the number of distinct generation-0 genomes
          and the report's `evaluated` equals the last history total;
  - null: for each k in first-null .. first-null+runs-1 the `claude-null-<k>` rows begin with the
          same genomes, and the report's library, seed and population are the given ones.
A `--seeds` file, another seed or another library changes generation 0 and fails. It does not
bind fold counts, extra-start, paths or config hashes (those still need the preserved invocation),
and a larger population whose extra draws are all repeats would pass this check.

    python gen0_receipt_v40.py --kind run|null --ledger L.jsonl --report R.json --library r3-f1 \
        --config FROZEN_OKX_SEARCH_CONFIG.json --bar-ms 86400000 --panels 2 --seed S --population P \
        [--generations G (run)] [--first-null K --runs N (null)]
Exit 0 = GEN0_OK, 1 = INVALID. Stdlib only, plus the pinned search module. Reads, writes nothing.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import algorithm_search_v40 as search


def expected_gen0(library: str, seed: int, population: int, validation_bars: int) -> list[str]:
    """Distinct generation-0 genome keys of `search()` without `--seeds`, in evaluation order."""
    saved = (search.TERMINALS, search.required_terms, search.allowed_horizons)
    try:
        search.use_library(library)
        search.allowed_horizons = [h for h in search.HORIZONS if h * 25 <= validation_bars] or [search.HORIZONS[0]]
        rng = random.Random(seed)
        keys: list[str] = []
        for _ in range(population):
            k = search.genome_key(search.repair(rng, search.random_genome(rng)))
            if k not in keys:
                keys.append(k)
        return keys
    finally:
        search.TERMINALS, search.required_terms, search.allowed_horizons = saved


def _rows(ledger: bytes) -> list[dict]:
    if not ledger.endswith(b"\n"):
        raise ValueError("ledger does not end with a newline")
    return [json.loads(line) for line in ledger.decode("utf-8").split("\n")[:-1]]


def _prefix(rows: list[dict], author: str, panels: int, want: list[str]) -> str | None:
    mine = [r for r in rows if r.get("author") == author]
    if len(mine) < panels * len(want):
        return f"{author}: {len(mine)} rows, generation 0 needs {panels * len(want)}"
    for i, key in enumerate(want):
        group = mine[i * panels:(i + 1) * panels]
        got = {search.genome_key(r.get("genome")) for r in group}
        if got != {key}:
            return f"{author}: genome {i} of generation 0 differs from the seeded draw"
    return None


def check(ledger: bytes, report: bytes, kind: str, library: str, seed: int, population: int,
          validation_bars: int, panels: int, generations: int | None = None, first_null: int = 0,
          runs: int = 0) -> dict:
    try:
        rows, rep = _rows(ledger), json.loads(report)
        want = expected_gen0(library, seed, population, validation_bars)
        if rep.get("library") != library:
            return {"verdict": "INVALID", "reason": "report library differs from the run plan"}
        if kind == "run":
            hist = rep.get("history")
            if not isinstance(hist, list) or generations is None or len(hist) != generations or \
                    [h.get("generation") for h in hist] != list(range(generations)):
                return {"verdict": "INVALID", "reason": "history does not have the planned generations"}
            if hist[0].get("evaluated_total") != len(want) or rep.get("evaluated") != hist[-1].get("evaluated_total"):
                return {"verdict": "INVALID", "reason": "evaluated counts do not match the seeded generation 0"}
            err = _prefix(rows, "claude-search", panels, want)
        else:
            if rep.get("seed") != seed or rep.get("population") != population:
                return {"verdict": "INVALID", "reason": "report seed or population differs from the run plan"}
            if [r.get("null_seed") for r in rep.get("runs", [])] != list(range(first_null, first_null + runs)):
                return {"verdict": "INVALID", "reason": "report runs differ from the run plan"}
            err = next((e for k in range(first_null, first_null + runs)
                        if (e := _prefix(rows, f"claude-null-{k}", panels, want))), None)
        if err:
            return {"verdict": "INVALID", "reason": err}
        return {"verdict": "GEN0_OK", "gen0_distinct": len(want)}
    except (ValueError, TypeError, AttributeError, KeyError, IndexError, UnicodeDecodeError) as e:
        return {"verdict": "INVALID", "reason": f"unreadable input: {e}"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--kind", choices=("run", "null"), required=True)
    for flag in ("--ledger", "--report", "--library", "--config"):
        ap.add_argument(flag, required=True)
    for flag in ("--bar-ms", "--panels", "--seed", "--population"):
        ap.add_argument(flag, type=int, required=True)
    ap.add_argument("--generations", type=int)
    ap.add_argument("--first-null", type=int, default=0)
    ap.add_argument("--runs", type=int, default=0)
    a = ap.parse_args(argv)
    cfg = json.loads(Path(a.config).read_text())
    bars = (cfg["holdout_start_ts"] - cfg["search_end_ts"]) // a.bar_ms
    res = check(Path(a.ledger).read_bytes(), Path(a.report).read_bytes(), a.kind, a.library, a.seed,
                a.population, bars, a.panels, a.generations, a.first_null, a.runs)
    print(json.dumps(res))
    return 0 if res["verdict"] == "GEN0_OK" else 1


if __name__ == "__main__":
    sys.exit(main())
