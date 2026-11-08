"""Offline tests for the J8 replay receipt check around the pinned `j8` CLI (synthetic data only)."""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import algorithm_search_v40 as search
import j8_receipts_v40 as receipts

DAY = 86_400_000
CARRY = {"blend": [[-1, "fund3"]], "h": 7, "w": "inverse_vol"}
VREV = {"blend": [[1, "vrev1"]], "h": 1, "w": "inverse_vol"}


class ReceiptCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="j8-receipts-"))
        cls.panels = []
        for name, seed in (("a", 7), ("b", 8)):
            src = cls.tmp / f"{name}.csv"
            search.synthesize_regime_daily(src, symbols=24, days=650, seed=seed, volume_plant=0.15)
            panel = bench.load_panel(src)
            t0 = panel.times[0]
            bench.freeze_config(panel, 0.25, cls.tmp / f"{name}.cfg.json", {"prior_trials": 0}, expect_bar_ms=DAY,
                                holdout_start_ts=t0 + 550 * DAY, search_end_ts=t0 + 400 * DAY)
            cls.panels.append((src, cls.tmp / f"{name}.cfg.json", t0))
        cls.shas = [bench.sha256_file(p) for p, _, _ in cls.panels]
        cls.out, cls.ledger = cls.replay("new", VREV, "r3-f1")
        cls.self_out, cls.self_ledger = cls.replay("self", CARRY, "r2")
        cls.late_out, cls.late_ledger = cls.replay("late", VREV, "r3-f1", start_days=270)

    @classmethod
    def tearDownClass(cls):
        search.use_library("r2")
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def argv(cls, name, cand, lib, start_days=150):
        (a, acfg, _), (b, bcfg, t0) = cls.panels
        start = dt.datetime.fromtimestamp((t0 + start_days * DAY) / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        return ["j8", "--panel", str(a), "--config", str(acfg), "--extra-panel", str(b), "--extra-config", str(bcfg),
                "--extra-folds", "3", "--extra-start", start, "--ledger", str(cls.tmp / f"{name}.jsonl"),
                "--out", str(cls.tmp / f"{name}.json"), "--reference", json.dumps(CARRY),
                "--candidate", json.dumps(cand), "--candidate-library", lib]

    @classmethod
    def replay(cls, name, cand, lib, start_days=150):
        receipts.preflight(cls.tmp / f"{name}.json", cls.tmp / f"{name}.jsonl")
        with contextlib.redirect_stdout(io.StringIO()):
            search.main(cls.argv(name, cand, lib, start_days))
        return cls.tmp / f"{name}.json", cls.tmp / f"{name}.jsonl"

    def copy(self, src, name):
        dst = self.tmp / name
        shutil.copyfile(src, dst)
        return dst

    def test_new_and_not_new_receipts_bind(self):
        res = receipts.check(self.out, self.ledger, self.shas, CARRY, VREV, "r3-f1")
        self.assertEqual((res["verdict"], res["eligible"], res["replays_in_ledger"]), ("NEW", True, 1), res)
        res = receipts.check(self.self_out, self.self_ledger, self.shas, CARRY, CARRY, "r2")
        self.assertEqual((res["verdict"], res["eligible"]), ("NOT_NEW", False), res)

    def test_preflight_refuses_existing_paths(self):
        for out, ledger in ((self.out, self.tmp / "fresh.jsonl"), (self.tmp / "fresh.json", self.ledger)):
            with self.assertRaises(SystemExit):
                receipts.preflight(out, ledger)
        with self.assertRaises(SystemExit):
            receipts.preflight(self.tmp / "same", self.tmp / "same")

    def test_pinned_cli_appends_before_refusing_report_and_check_reconciles(self):
        """GPT 04:23 reproduced: an existing --out fails only after rows are appended."""
        ledger = self.copy(self.ledger, "rep.jsonl")
        out = self.copy(self.out, "rep.json")
        argv = self.argv("rep", VREV, "r3-f1")
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(FileExistsError):
            search.main(argv)
        self.assertEqual(len(ledger.read_text().splitlines()), 8)
        self.assertEqual(out.read_bytes(), self.out.read_bytes())
        res = receipts.check(out, ledger, self.shas, CARRY, VREV, "r3-f1")
        self.assertEqual((res["verdict"], res["replays_in_ledger"]), ("NEW", 2), res)

    def test_partial_foreign_or_altered_rows_are_invalid(self):
        lines = self.ledger.read_text().splitlines()
        altered = json.loads(lines[0])
        altered["fitness"] += 1e-12
        foreign = json.loads(lines[0])
        foreign["genome"] = {"blend": [[1, "vrev5"]], "h": 1, "w": "inverse_vol"}
        cases = {"partial": lines[:3], "half-repeat": lines + lines[:2], "altered-repeat": lines + [json.dumps(altered)]
                 + lines[1:], "foreign": lines + [json.dumps(foreign)], "empty": []}
        for name, body in cases.items():
            path = self.tmp / f"bad-{name}.jsonl"
            path.write_text("".join(x + "\n" for x in body))
            res = receipts.check(self.out, path, self.shas, CARRY, VREV, "r3-f1")
            self.assertEqual(res["verdict"], "INVALID", name)
            self.assertFalse(res["eligible"], name)

    def test_wrong_panel_genome_library_or_verdict_is_invalid(self):
        bad = [(self.out, self.ledger, self.shas[::-1], CARRY, VREV, "r3-f1"),
               (self.out, self.ledger, self.shas[:1], CARRY, VREV, "r3-f1"),
               (self.out, self.ledger, self.shas, CARRY, CARRY, "r3-f1"),
               (self.out, self.ledger, self.shas, CARRY, VREV, "r2"),
               (self.out, self.self_ledger, self.shas, CARRY, VREV, "r3-f1"),
               (self.tmp / "missing.json", self.ledger, self.shas, CARRY, VREV, "r3-f1")]
        for args in bad:
            self.assertEqual(receipts.check(*args)["verdict"], "INVALID", args[2:])
        report = json.loads(self.out.read_text())
        for edit in ({"verdict": "NOT_NEW"}, {"pooled": {**report["pooled"], "matched": 9}}):
            path = self.tmp / "edited.json"
            path.write_text(json.dumps({**report, **edit}))
            self.assertEqual(receipts.check(path, self.ledger, self.shas, CARRY, VREV, "r3-f1")["verdict"], "INVALID")
            path.unlink()

    def edited(self, report, name="edited.json"):
        path = self.tmp / name
        path.write_text(json.dumps(report))
        return path

    def test_report_from_another_replay_is_invalid(self):
        """GPT 05:50: same panel and genome keys, different --extra-start."""
        res = receipts.check(self.late_out, self.late_ledger, self.shas, CARRY, VREV, "r3-f1")
        self.assertEqual(res["verdict"], "NEW", res)
        self.assertNotEqual(json.loads(self.late_out.read_text())["candidate"]["fitness"],
                            json.loads(self.out.read_text())["candidate"]["fitness"])
        for out, ledger in ((self.out, self.late_ledger), (self.late_out, self.ledger)):
            res = receipts.check(out, ledger, self.shas, CARRY, VREV, "r3-f1")
            self.assertEqual(res["verdict"], "INVALID", res)
            self.assertIn("does not follow from its ledger rows", " ".join(res["problems"]))

    def test_receipt_hashes_are_reported(self):
        res = receipts.check(self.out, self.ledger, self.shas, CARRY, VREV, "r3-f1")
        self.assertEqual(res["report_sha256"], bench.sha256_file(self.out))
        self.assertEqual(res["ledger_sha256"], bench.sha256_file(self.ledger))

    def test_impossible_step_counts_are_invalid(self):
        report = json.loads(self.out.read_text())
        m = report["panels"][0]["matched"]
        for edit in ({"reference_steps": 0, "candidate_steps": 1}, {"candidate_steps": m - 1},
                     {"reference_steps": True}, {"matched": float(m)}, {"reference_steps": -1}):
            bad = {**report, "panels": [{**report["panels"][0], **edit}] + report["panels"][1:]}
            self.assertEqual(receipts.check(self.edited(bad), self.ledger, self.shas, CARRY, VREV, "r3-f1")["verdict"],
                             "INVALID", edit)

    def test_non_object_rows_or_report_are_invalid_not_errors(self):
        lines = self.ledger.read_text().splitlines()
        for body in (["null"] + lines[1:], ["[]"] + lines[1:], ["3"] + lines[1:]):
            path = self.tmp / "nonobj.jsonl"
            path.write_text("".join(x + "\n" for x in body))
            self.assertEqual(receipts.check(self.out, path, self.shas, CARRY, VREV, "r3-f1")["verdict"], "INVALID")
        for report in (None, [], {"panels": "ab"}):
            self.assertEqual(receipts.check(self.edited(report), self.ledger, self.shas, CARRY, VREV,
                                            "r3-f1")["verdict"], "INVALID")

    def test_self_match_rounded_past_one_is_not_new(self):
        """GPT 05:50: pinned fsum/sqrt returned pooled rho 1.0000000000000002 on a self-match."""
        report = json.loads(self.self_out.read_text())
        over = 1.0000000000000002
        bad = {**report, "pooled": {**report["pooled"], "rho": over}}
        res = receipts.check(self.edited(bad), self.self_ledger, self.shas, CARRY, CARRY, "r2")
        self.assertEqual((res["verdict"], res["eligible"]), ("NOT_NEW", False), res)
        for rho in (1.001, -1.001, float("nan")):
            bad = {**report, "pooled": {**report["pooled"], "rho": rho}}
            self.assertEqual(receipts.check(self.edited(bad), self.self_ledger, self.shas, CARRY, CARRY,
                                            "r2")["verdict"], "INVALID", rho)

    def test_overflowing_ledger_metrics_are_invalid(self):
        """GPT 07:23: Sharpe 1.7e308 and fitness -1.7e308 rebuilt a NaN fitness that compared as equal."""
        rows = [json.loads(x) for x in self.ledger.read_text().splitlines()]
        path = self.tmp / "overflow.jsonl"
        path.write_text("".join(json.dumps({**r, "sharpe_annual_gate": 1.7e308, "fitness": -1.7e308}) + "\n"
                                for r in rows))
        res = receipts.check(self.out, path, self.shas, CARRY, VREV, "r3-f1")
        self.assertEqual((res["verdict"], res["eligible"]), ("INVALID", False), res)

    def test_unrepresentable_report_numbers_are_invalid_not_errors(self):
        """GPT 07:23: a JSON integer 10**400 raised OverflowError in fitness or rho."""
        report = json.loads(self.out.read_text())
        huge = 10 ** 400
        for bad in ({**report, "candidate": {**report["candidate"], "fitness": huge}},
                    {**report, "reference": {**report["reference"], "fitness": -huge}},
                    {**report, "pooled": {**report["pooled"], "rho": huge}},
                    {**report, "panels": [{**report["panels"][0], "rho": -huge}] + report["panels"][1:]},
                    {**report, "panels": [{**report["panels"][0], "reference_steps": huge,
                                           "candidate_steps": huge}] + report["panels"][1:]}):
            res = receipts.check(self.edited(bad), self.ledger, self.shas, CARRY, VREV, "r3-f1")
            self.assertEqual((res["verdict"], res["eligible"]), ("INVALID", False))

    def test_undefined_needs_valid_counts_and_rhos(self):
        """GPT 07:23: UNDEFINED with a negative count or another rho of 1.001 was returned as UNDEFINED."""
        report = json.loads(self.out.read_text())
        base = {**report, "verdict": "UNDEFINED", "pooled": {**report["pooled"], "rho": None}}
        res = receipts.check(self.edited(base), self.ledger, self.shas, CARRY, VREV, "r3-f1")
        self.assertEqual((res["verdict"], res["eligible"]), ("UNDEFINED", False), res)
        p0 = base["panels"][0]
        for edit in ({"panels": [{**p0, "matched": -1}] + base["panels"][1:]},
                     {"panels": [{**p0, "rho": 1.001}] + base["panels"][1:]},
                     {"panels": [{**p0, "rho": float("nan")}] + base["panels"][1:]},
                     {"panels": [{**p0, "matched": 9}] + base["panels"][1:]},
                     {"pooled": {**base["pooled"], "matched": base["pooled"]["matched"] + 1}}):
            res = receipts.check(self.edited({**base, **edit}), self.ledger, self.shas, CARRY, VREV, "r3-f1")
            self.assertEqual(res["verdict"], "INVALID", edit)

    def test_cli_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(receipts.main(["preflight", "--out", str(self.tmp / "n.json"),
                                            "--ledger", str(self.tmp / "n.jsonl")]), 0)
            base = ["check", "--out", str(self.out), "--ledger", str(self.ledger), "--reference", json.dumps(CARRY),
                    "--candidate", json.dumps(VREV), "--candidate-library", "r3-f1"]
            shas = [x for s in self.shas for x in ("--panel-sha", s)]
            self.assertEqual(receipts.main(base + shas), 0)
            self.assertEqual(receipts.main(base + shas[:2]), 1)


if __name__ == "__main__":
    unittest.main()
