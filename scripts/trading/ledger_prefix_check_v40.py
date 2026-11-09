"""Same-host resume receipt (J9-C1 (2)): an interrupted search run's partial exploration ledger
must be an exact prefix of the rerun's ledger.

Why: a stopped null or real run is redone from the start on the same host with a new ledger.
The search is deterministic per seed, so the rerun must evaluate the same genomes in the same
order with the same scores. If it does, the rerun's result is the one the interrupted run would
have produced and nothing was chosen between two outcomes. If it does not, the host or inputs
changed and the rerun must not count.

Rows are compared as canonical JSON after dropping `time_utc` (the only wall-clock field the
search writes). A trailing line without a newline in the partial ledger is a write cut off by
the interruption: it is reported and excluded, never repaired. The rerun is complete when this
receipt is taken, so every rerun row must parse and the rerun must end with a newline; otherwise
the verdict is UNDEFINED (a match on the prefix alone says nothing about the rows after it).
Stdlib only; reads, writes nothing.

    python ledger_prefix_check_v40.py PARTIAL.jsonl RERUN.jsonl
Exit 0 = PREFIX_MATCH, 1 = MISMATCH or UNDEFINED.
"""
from __future__ import annotations

import json
import sys

VOLATILE = ("time_utc",)


def _rows(data: bytes) -> tuple[list[bytes], bool]:
    """Complete newline-terminated rows, and whether a cut-off trailing fragment was dropped."""
    lines = data.split(b"\n")
    tail = lines.pop()
    return lines, bool(tail)


def _norm(line: bytes):
    row = json.loads(line)
    if not isinstance(row, dict):
        raise ValueError("ledger row is not an object")
    for k in VOLATILE:
        row.pop(k, None)
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def check(partial: bytes, rerun: bytes) -> dict:
    try:
        old, old_cut = _rows(partial)
        new, new_cut = _rows(rerun)
        if not old:
            return {"verdict": "UNDEFINED", "reason": "partial ledger has no complete rows"}
        if len(new) < len(old):
            return {"verdict": "UNDEFINED", "reason": "rerun ledger shorter than partial",
                    "partial_rows": len(old), "rerun_rows": len(new)}
        for i, (a, b) in enumerate(zip(old, new)):
            if _norm(a) != _norm(b):
                return {"verdict": "MISMATCH", "first_differing_row": i + 1,
                        "partial_rows": len(old), "rerun_rows": len(new)}
        for i in range(len(old), len(new)):
            try:
                _norm(new[i])
            except (ValueError, UnicodeDecodeError) as e:
                return {"verdict": "UNDEFINED", "reason": f"rerun row {i + 1} unreadable: {e}",
                        "partial_rows": len(old), "rerun_rows": len(new)}
        if new_cut:
            return {"verdict": "UNDEFINED", "reason": "rerun ledger ends in a cut-off fragment",
                    "partial_rows": len(old), "rerun_rows": len(new)}
    except (ValueError, UnicodeDecodeError) as e:
        return {"verdict": "UNDEFINED", "reason": f"unreadable row: {e}"}
    return {"verdict": "PREFIX_MATCH", "partial_rows": len(old), "rerun_rows": len(new),
            "partial_cut_fragment": old_cut}


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        return 2
    with open(argv[0], "rb") as f1, open(argv[1], "rb") as f2:
        res = check(f1.read(), f2.read())
    print(json.dumps(res, sort_keys=True))
    return 0 if res["verdict"] == "PREFIX_MATCH" else 1


if __name__ == "__main__":
    raise SystemExit(main())
