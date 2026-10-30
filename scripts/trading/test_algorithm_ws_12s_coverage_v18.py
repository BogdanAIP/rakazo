"""v18 independent 12s provenance/coverage tests before fresh source receipts."""
from pathlib import Path
import tempfile
import unittest

from algorithm_ws_capture_v8 import save_capture
from test_algorithm_ws_audit_v8 import fixture,T
from algorithm_ws_12s_coverage_v18 import analyze


def sample(*,gap=False,duplicate_trade=False):
    m,frames=fixture(gap=gap,duplicate_trade=duplicate_trade)
    m["observation_seconds"]=12
    m["end_utc_ms"]=m["start_utc_ms"]+12000
    return m,frames


class V18CoverageTests(unittest.TestCase):
    def test_good_source_and_all_five_predeclared_windows(self):
        m,frames=sample()
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"source"
            save_capture(path,m,frames)
            r=analyze(path)
        self.assertEqual(r["recorded_original_messages"],7)
        self.assertEqual(r["book_updates_total"],2)
        self.assertEqual(r["received_valid_taker_fills_total"],2)
        self.assertEqual(r["joint_seconds"],1)
        self.assertEqual(len(r["each_one_second"]),12)
        self.assertEqual(len(r["predeclared_overlapping_eight_second_windows"]),5)
        self.assertEqual(r["coverage_fraction"],str(1/12) if False else "0.08333333333333333333333333333")
        self.assertTrue(r["verified_incremental_books"])
        self.assertFalse(r["overlapping_windows_are_independent"])
        self.assertIsNone(r["future_price_labels"])
        self.assertFalse(r["can_trade"])

    def test_gap_or_duplicate_fill_rejected(self):
        for kwargs in ({"gap":True},{"duplicate_trade":True}):
            m,frames=sample(**kwargs)
            with tempfile.TemporaryDirectory() as td:
                path=Path(td)/"source"
                save_capture(path,m,frames)
                with self.assertRaises(ValueError):
                    analyze(path)

    def test_raw_tamper_or_wrong_window_rejected(self):
        m,frames=sample()
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"source"
            save_capture(path,m,frames)
            with (path/"messages.jsonl").open("ab") as f:
                f.write(b"\n{}\n")
            with self.assertRaises(ValueError):
                analyze(path)
        m["end_utc_ms"]=m["start_utc_ms"]+8000
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/"source"
            save_capture(path,m,frames)
            with self.assertRaises(ValueError):
                analyze(path)


if __name__=="__main__":
    unittest.main()
