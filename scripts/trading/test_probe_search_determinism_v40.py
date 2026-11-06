"""Synthetic comparator contract tests; no market data, no network."""
import copy
import unittest
import probe_search_determinism_v40 as probe

class ComparatorContract(unittest.TestCase):
    def setUp(self):
        self.report = probe.make_report()

    def test_same_runtime_is_not_cross_host_proof(self):
        result = probe.compare(self.report, copy.deepcopy(self.report))
        self.assertEqual(result["status"], "MATCH_SAME_RUNTIME_ONLY")
        self.assertFalse(result["allows_round_execution"])

    def test_distinct_runtime_is_still_helpers_only(self):
        other = copy.deepcopy(self.report)
        other["runtime"]["system"] = "SyntheticOtherRuntime"
        result = probe.compare(self.report, other)
        self.assertEqual(result["status"], "MATCH_HELPERS_ONLY")
        self.assertFalse(result["allows_round_execution"])

    def test_one_bit_difference_fails_even_with_valid_digest(self):
        other = copy.deepcopy(self.report)
        other["outputs"]["mean"] = "0x1.0000000000001p+0"
        other["outputs_sha256"] = probe.digest(other["outputs"])
        self.assertEqual(probe.compare(self.report, other)["status"], "MISMATCH_NO_CROSS_HOST")

    def test_source_change_fails(self):
        other = copy.deepcopy(self.report)
        other["module_sha256"] = "0" * 64
        self.assertEqual(probe.compare(self.report, other)["status"], "MISMATCH_NO_CROSS_HOST")

    def test_corrupt_report_rejected(self):
        other = copy.deepcopy(self.report)
        other["outputs"]["mean"] = "0x1p+0"
        with self.assertRaises(ValueError):
            probe.compare(self.report, other)

    def test_wrong_corpus_rejected(self):
        other = copy.deepcopy(self.report)
        other["corpus_sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            probe.compare(self.report, other)

    def test_two_empty_self_consistent_outputs_rejected(self):
        other = copy.deepcopy(self.report)
        other["outputs"] = {}
        other["outputs_sha256"] = probe.digest({})
        with self.assertRaises(ValueError):
            probe.compare(other, copy.deepcopy(other))

    def test_truncated_vectors_rejected_after_redigest(self):
        other = copy.deepcopy(self.report)
        other["outputs"]["dlog"].pop()
        other["outputs_sha256"] = probe.digest(other["outputs"])
        with self.assertRaises(ValueError):
            probe.compare(other, copy.deepcopy(other))

    def test_nonfinite_or_noncanonical_values_rejected(self):
        for value in ("nan", "inf", "0x1p+0", 1.0):
            with self.subTest(value=value):
                other = copy.deepcopy(self.report)
                other["outputs"]["mean"] = value
                other["outputs_sha256"] = probe.digest(other["outputs"])
                with self.assertRaises(ValueError):
                    probe.compare(other, copy.deepcopy(other))

    def test_duplicate_selection_rejected(self):
        other = copy.deepcopy(self.report)
        other["outputs"]["selection"][0] = other["outputs"]["selection"][1]
        other["outputs_sha256"] = probe.digest(other["outputs"])
        with self.assertRaises(ValueError):
            probe.compare(other, copy.deepcopy(other))

    def test_empty_runtime_rejected(self):
        other = copy.deepcopy(self.report)
        other["runtime"] = {}
        with self.assertRaises(ValueError):
            probe.compare(other, copy.deepcopy(other))

    def test_nonobject_root_rejected(self):
        with self.assertRaises(ValueError):
            probe.compare([], [])

if __name__ == "__main__":
    unittest.main()
