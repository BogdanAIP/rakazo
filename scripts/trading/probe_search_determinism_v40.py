"""Offline synthetic J11 diagnostic; never evaluates market data or authorizes a round.

Run on each proposed runtime, then compare the reports. Fixed binary64 input strings
avoid regenerating a corpus through host libm. This tests helper arithmetic only:
a PASS is NOT a full-search comparator or execution sign-off.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import platform
from pathlib import Path
import sys
import search_determinism_v40 as det

SCHEMA = "j11-synthetic-helper-comparator-v1"
# Literal binary64 strings, no random or transcendental corpus generation.
CORPUS = {
    "positive": ["0x0.0000000000001p-1022", "0x1.0000000000000p-1022",
                 "0x1.0000000000000p-40", "0x1.fffffffffffffp-1",
                 "0x1.0000000000000p+0", "0x1.0000000000001p+0",
                 "0x1.0000000000000p+1", "0x1.fffffffffffffp+1023"],
    "signed": ["-0x1.4000000000000p+4", "-0x1.0000000000000p+0",
               "-0x1.0000000000000p-27", "-0x0.0000000000001p-1022",
               "-0x0.0p+0", "0x0.0p+0", "0x0.0000000000001p-1022",
               "0x1.0000000000000p-27", "0x1.0000000000000p+0",
               "0x1.3ffffffffffffp+4", "0x1.4000000000000p+4"],
    "fitness": ["0x1.db6ac0c5560e0p-4", "0x1.db6ac0c556110p-4",
                "-0x1.0000000000000p+0", "-0x0.0p+0", "0x0.0p+0",
                "0x1.0000000000000p+0", "0x1.0000000000001p+0"],
}

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def bits(x):
    # float.hex retains signed zero and all finite binary64 bits.
    return float(x).hex()

def make_report():
    positive = [float.fromhex(x) for x in CORPUS["positive"]]
    signed = [float.fromhex(x) for x in CORPUS["signed"]]
    fitness = [float.fromhex(x) for x in CORPUS["fitness"]]
    logs = [det.dlog(x) for x in positive]
    tanhs = [det.dtanh(x) for x in signed]
    signedlogs = [det.dlog1p_signed(x) for x in signed]
    keys = [f"synthetic-{i:02d}" for i in range(len(fitness))]
    # Exact ties deliberately receive reverse input order.
    candidates = list(zip(keys, fitness))[::-1]
    selection = [k for k, f in sorted(candidates, key=lambda p: det.selection_key(p[1], p[0]))]
    a = [1.0, -2.0, 3.0, -4.0, 5.0, -6.0, 7.0, -8.0, 9.0, -10.0]
    b = [2.0, -1.0, 4.0, -3.0, 6.0, -5.0, 8.0, -7.0, 10.0, -9.0]
    parts = [(0.8, 700, [0.4, 0.9]), (0.3, 1000, [0.03, 0.15, 0.5])]
    output = {
        "dlog": list(map(bits, logs)),
        "dtanh": list(map(bits, tanhs)),
        "dlog1p_signed": list(map(bits, signedlogs)),
        "scores12": [bits(det.quantize(x, 12)) for x in logs + tanhs + signedlogs],
        "fitness10": [bits(det.quantize(x, 10)) for x in fitness],
        "selection": selection,
        "mean": bits(det.mean(a)), "corr": bits(det.corr(a, b)),
        "pooled_fitness": bits(det.pooled_fitness(parts, 3)),
    }
    return {
        "schema": SCHEMA, "scope": "synthetic-helper-only-not-search-signoff",
        "corpus_sha256": digest(CORPUS),
        "module_sha256": hashlib.sha256(Path(det.__file__).read_bytes()).hexdigest(),
        "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "runtime": {"python": platform.python_version(),
                    "implementation": platform.python_implementation(),
                    "system": platform.system(), "libc": list(platform.libc_ver())},
        "outputs": output, "outputs_sha256": digest(output),
    }

def validate(report):
    if not isinstance(report, dict):
        raise ValueError("report must be an object")
    if report.get("schema") != SCHEMA:
        raise ValueError("unsupported report schema")
    if report.get("scope") != "synthetic-helper-only-not-search-signoff":
        raise ValueError("wrong report scope")
    if report.get("corpus_sha256") != digest(CORPUS):
        raise ValueError("corpus mismatch")
    output = report.get("outputs")
    sizes = {"dlog": len(CORPUS["positive"]), "dtanh": len(CORPUS["signed"]),
             "dlog1p_signed": len(CORPUS["signed"]),
             "scores12": len(CORPUS["positive"]) + 2 * len(CORPUS["signed"]),
             "fitness10": len(CORPUS["fitness"])}
    scalars = ("mean", "corr", "pooled_fitness")
    if not isinstance(output, dict) or set(output) != set(sizes) | set(scalars) | {"selection"}:
        raise ValueError("incomplete or unknown output fields")
    values = []
    for field, size in sizes.items():
        xs = output[field]
        if not isinstance(xs, list) or len(xs) != size:
            raise ValueError("wrong output vector length")
        values.extend(xs)
    values.extend(output[field] for field in scalars)
    for value in values:
        if not isinstance(value, str):
            raise ValueError("output must be canonical finite binary64 hex")
        try:
            number = float.fromhex(value)
        except (ValueError, OverflowError) as exc:
            raise ValueError("invalid binary64 hex") from exc
        if not math.isfinite(number) or number.hex() != value:
            raise ValueError("output must be canonical finite binary64 hex")
    selection = output["selection"]
    expected = {f"synthetic-{i:02d}" for i in range(len(CORPUS["fitness"]))}
    if (not isinstance(selection, list) or len(selection) != len(expected)
            or any(not isinstance(key, str) for key in selection)
            or set(selection) != expected):
        raise ValueError("selection must be a complete genome permutation")
    if report.get("outputs_sha256") != digest(report["outputs"]):
        raise ValueError("output digest mismatch")
    for field in ("module_sha256", "probe_sha256"):
        v = report.get(field, "")
        if not isinstance(v, str) or len(v) != 64 or any(c not in "0123456789abcdef" for c in v):
            raise ValueError("invalid source digest")
    runtime = report.get("runtime")
    if (not isinstance(runtime, dict)
            or any(not isinstance(runtime.get(k), str) or not runtime[k]
                   for k in ("python", "implementation", "system"))
            or not isinstance(runtime.get("libc"), list)
            or len(runtime["libc"]) != 2
            or any(not isinstance(x, str) for x in runtime["libc"])):
        raise ValueError("missing or invalid runtime metadata")
    # A locally self-consistent digest is not authenticity or proof of an actual run.

def compare(left, right):
    validate(left)
    validate(right)
    fields = ("corpus_sha256", "module_sha256", "probe_sha256", "outputs")
    differing = [f for f in fields if left[f] != right[f]]
    runtimes_differ = left["runtime"] != right["runtime"]
    status = ("MISMATCH_NO_CROSS_HOST" if differing else
              "MATCH_HELPERS_ONLY" if runtimes_differ else
              "MATCH_SAME_RUNTIME_ONLY")
    return {"schema": SCHEMA, "status": status, "differing_fields": differing,
            "distinct_runtime_metadata": runtimes_differ,
            "allows_round_execution": False,
            "limitation": "No full-search trajectory, integration, private data or runtime authenticity verified."}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compare", nargs=2, metavar=("LEFT", "RIGHT"))
    args = parser.parse_args()
    if args.compare:
        try:
            result = compare(*(json.loads(Path(p).read_text()) for p in args.compare))
        except (ValueError, KeyError, TypeError) as exc:
            print(json.dumps({"status": "INVALID_REPORT", "error": str(exc)}))
            return 2
        print(json.dumps(result, sort_keys=True))
        return 1 if result["status"] == "MISMATCH_NO_CROSS_HOST" else 0
    print(json.dumps(make_report(), sort_keys=True, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
