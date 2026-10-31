"""v29 explicitly hindsight-only alignment source integrity tests."""
from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from algorithm_onset_alignment_posthoc_v29 import (
    CATEGORIES,OUTCOMES,ORIGINAL_SOURCE_SHA,audit
)


class PostHocAlignedDepthV29Tests(unittest.TestCase):
    def test_locked_original_sources_and_no_optimized_parameter(self):
        self.assertEqual(len(ORIGINAL_SOURCE_SHA),3)
        self.assertEqual(CATEGORIES,(
            "FLOW_AND_DEPTH_CHANGE_SAME_DIRECTION",
            "FLOW_AND_DEPTH_CHANGE_OPPOSED_OR_FLAT",
        ))
        self.assertEqual(OUTCOMES[:3],(
            "DIRECTIONAL_100BPS_FIRST",
            "ADVERSE_100BPS_FIRST",
            "CENSORED_60_MINUTES",
        ))
        self.assertTrue(all(len(x)==64 for x in ORIGINAL_SOURCE_SHA.values()))

    def test_fabricated_source_can_never_be_reported_as_real(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"fabricated.json"
            p.write_text('{"signal":"all profitable"}')
            with self.assertRaises(ValueError):
                audit(p,p,p)


if __name__=="__main__":
    unittest.main()
