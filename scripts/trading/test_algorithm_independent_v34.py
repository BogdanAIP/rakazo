import copy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import algorithm_independent_v34 as pilot


class IndependentPilotTests(unittest.TestCase):
    def test_dirty_or_changed_pipeline_cannot_access_independent_sources(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)/"not-created"
            with patch.object(pilot.subprocess,"run",side_effect=[
                    SimpleNamespace(stdout="actual-head\n"),SimpleNamespace(stdout="")]):
                with self.assertRaises(ValueError):
                    pilot.run_all(root,"different-head")
            self.assertFalse(root.exists())

    def test_old_allowlist_unchanged_and_new_cohort_exact(self):
        with self.assertRaises(ValueError):
            pilot.archives.registered("2026-10-01","NEAR-USDT-SWAP","L2")
        for day,symbol in pilot.CASES:
            _, url = pilot.registered(day,symbol,"L2")
            self.assertTrue(url.startswith("https://static.okx.com/"))
            self.assertIn(day.replace("-",""),url)
        for day in ("2026-09-05","2026-11-01","2026-10-02"):
            with self.assertRaises(ValueError):
                pilot.registered(day,"NEAR-USDT-SWAP","L2")
        with self.assertRaises(ValueError):
            pilot.registered("2026-10-01","BTC-USDT-SWAP","L2")

    def test_selection_is_exact_existing_candidate_and_two_baselines(self):
        docs = Path(__file__).resolve().parents[2]/"docs/trading"
        original = json.loads((docs/"ALGORITHM-RESTORATION-PROPOSALS-v32.json").read_bytes())
        fixed = json.loads((docs/"ALGORITHM-INDEPENDENT-PROPOSALS-v34.json").read_bytes())
        selected = {p["id"]:p for p in fixed["programs"]}
        self.assertEqual(set(selected),pilot.PROGRAM_IDS)
        for p in original["programs"]:
            if p["id"] in selected:
                self.assertEqual(selected[p["id"]],p)

    def test_tar_paths_and_existing_sources_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            day,symbol = pilot.CASES[0]
            original,spool,url = pilot.file_paths(root,day,symbol)
            original.parent.mkdir(parents=True)
            with tarfile.open(original,"w:gz") as tf:
                entry = tarfile.TarInfo("../../outside.data")
                content = b"not a valid source"
                entry.size = len(content)
                tf.addfile(entry,io.BytesIO(content))
            receipt = {"source_url":url,"original_sha256":pilot.archives.digest(original)}
            Path(str(original)+".receipt.json").write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):
                pilot.unpack_and_index(root,day,symbol)
            self.assertFalse(spool.exists())
            spool.write_text("preserved")
            with self.assertRaises(FileExistsError):
                pilot.unpack_and_index(root,day,symbol)
            self.assertEqual(spool.read_text(),"preserved")

    def test_one_successful_near_day_cannot_pass_or_be_replaced_by_sol(self):
        definitions = [{"id":x} for x in pilot.PROGRAM_IDS]
        rows = []
        for day,symbol in pilot.CASES:
            cm = 15 if day == pilot.DAYS[0] or symbol == "SOL-USDT-SWAP" else -1
            scores = {x:{"alarms":10,"quote_path_unavailable":0,
                         "mean_quote_20bp":cm if x == "restoration-flow-no-memory" else -5}
                      for x in pilot.PROGRAM_IDS}
            rows.append({"day":day,"symbol":symbol,"programs":scores})
        with patch.object(pilot.lab,"FEATURES",set(pilot.lab.FEATURES)), \
             patch.object(pilot.lab,"proposals",return_value=(definitions,"fixed")), \
             patch.object(pilot.restoration,"evaluate",return_value={"cases":copy.deepcopy(rows)}):
            result = pilot.evaluate(Path("fake"),Path("unused"))
        self.assertFalse(result["primary_both_days_pass"])
        self.assertEqual(len(result["primary_NEAR"]),2)
        self.assertTrue(result["primary_NEAR"][0]["prespecified_pilot_pass"])
        self.assertFalse(result["primary_NEAR"][1]["prespecified_pilot_pass"])

    def test_incomplete_quote_path_fails_even_with_positive_return(self):
        definitions = [{"id":x} for x in pilot.PROGRAM_IDS]
        rows = []
        for day,symbol in pilot.CASES:
            scores = {x:{"alarms":10,"quote_path_unavailable":1,
                         "mean_quote_20bp":10 if x == "restoration-flow-no-memory" else -5}
                      for x in pilot.PROGRAM_IDS}
            rows.append({"day":day,"symbol":symbol,"programs":scores})
        with patch.object(pilot.lab,"FEATURES",set(pilot.lab.FEATURES)), \
             patch.object(pilot.lab,"proposals",return_value=(definitions,"fixed")), \
             patch.object(pilot.restoration,"evaluate",return_value={"cases":rows}):
            result = pilot.evaluate(Path("fake"),Path("unused"))
        self.assertFalse(result["primary_both_days_pass"])


if __name__ == "__main__":
    unittest.main()
