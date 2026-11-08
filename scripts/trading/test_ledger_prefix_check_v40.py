import json
import unittest

from ledger_prefix_check_v40 import check


def ledger(rows, t0=0, cut=b""):
    out = b""
    for i, r in enumerate(rows):
        out += json.dumps({"time_utc": f"2026-11-08T{t0 + i:02d}:00:00Z", **r}, sort_keys=True).encode() + b"\n"
    return out + cut


ROWS = [{"genome": {"blend": [[1, f"f{i}"]]}, "fitness": 0.1 * i, "author": "claude-null-6"} for i in range(6)]


class TestLedgerPrefix(unittest.TestCase):
    def test_rerun_extends_partial_with_new_times(self):
        res = check(ledger(ROWS[:3]), ledger(ROWS, t0=10))
        self.assertEqual(res["verdict"], "PREFIX_MATCH")
        self.assertEqual((res["partial_rows"], res["rerun_rows"]), (3, 6))

    def test_key_order_is_irrelevant(self):
        part = b'{"fitness":0.0,"genome":{"blend":[[1,"f0"]]},"author":"claude-null-6","time_utc":"x"}\n'
        self.assertEqual(check(part, ledger(ROWS))["verdict"], "PREFIX_MATCH")

    def test_one_ulp_fitness_difference_is_a_mismatch(self):
        rows = [dict(r) for r in ROWS]
        rows[1]["fitness"] = 0.1 + 2 ** -56
        res = check(ledger(ROWS[:3]), ledger(rows))
        self.assertEqual((res["verdict"], res["first_differing_row"]), ("MISMATCH", 2))

    def test_cut_trailing_fragment_is_excluded_and_reported(self):
        res = check(ledger(ROWS[:2], cut=b'{"time_utc":"2026'), ledger(ROWS))
        self.assertEqual(res["verdict"], "PREFIX_MATCH")
        self.assertTrue(res["partial_cut_fragment"])
        self.assertEqual(res["partial_rows"], 2)

    def test_fails_closed(self):
        self.assertEqual(check(b"", ledger(ROWS))["verdict"], "UNDEFINED")
        self.assertEqual(check(ledger(ROWS), ledger(ROWS[:2]))["verdict"], "UNDEFINED")
        self.assertEqual(check(b"[1]\n", ledger(ROWS))["verdict"], "UNDEFINED")
        self.assertEqual(check(b"{bad\n", ledger(ROWS))["verdict"], "UNDEFINED")


if __name__ == "__main__":
    unittest.main()
