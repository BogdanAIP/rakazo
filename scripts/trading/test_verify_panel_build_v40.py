"""Offline tests: post-build panel verifier and the audit -> freeze preflight."""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import okx_bench_archive_v40 as archive
import verify_panel_build_v40 as verify
from test_okx_bench_archive_v40 import compressed

HYP_DIR = Path(__file__).resolve().parents[2] / "docs" / "trading" / "bench" / "hypotheses"
REGISTERED = ["claude-2026-10-31.json", "gpt-2026-10-31.json", "gpt-medium-horizon-2026-10-31.json"]


def write_archives(root: Path, start: dt.date, end: dt.date, symbols, skip_funding=()):
    """Hourly-constant minute candles and one 8 h-style settlement per bar for each symbol."""
    for day in archive.days(start, end):
        base = int(dt.datetime.combine(day - dt.timedelta(days=1), dt.time(16), dt.timezone.utc).timestamp() * 1000)
        cand, fund = io.StringIO(newline=""), io.StringIO(newline="")
        wc, wf = csv.writer(cand), csv.writer(fund)
        wc.writerow(("instrument_name", "open", "high", "low", "close", "vol", "vol_ccy", "vol_quote", "open_time", "confirm"))
        wf.writerow(("instrument_name", "funding_rate", "funding_time"))
        for sym, daily in symbols:
            for m in range(24 * 60):
                wc.writerow((sym, "1", "1", "1", "1", 1, 1, daily / 1440, base + m * 60_000, 0))
            if (day, sym) in skip_funding:
                continue
            for h in range(24):
                settle = base + (h + 1) * archive.HOUR
                if (settle // archive.HOUR) % 8 == 0:
                    wf.writerow((sym, "0.0001", settle))
        receipt = {}
        for kind, doc in (("candles", cand.getvalue()), ("funding", fund.getvalue())):
            payload = compressed(f"{kind}.csv", doc)
            path = archive.file_at(root, kind, day)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
            receipt[kind] = {"sha256": hashlib.sha256(payload).hexdigest(), "zip_bytes": len(payload)}
        rec = root / "receipts" / f"{day.isoformat()}.json"
        rec.parent.mkdir(parents=True, exist_ok=True)
        rec.write_text(json.dumps(receipt))


class TestVerifier(unittest.TestCase):
    def build(self, td, skip_funding=()):
        root = Path(td)
        start, end = dt.date(2023, 10, 1), dt.date(2023, 11, 12)
        write_archives(root, start, end, (("A-USDT-SWAP", 9e6), ("B-USDT-SWAP", 8e6), ("C-USDT-SWAP", 1e6)),
                       skip_funding)
        panel = root / "panel.csv"
        archive.build(root, start, end, dt.date(2023, 11, 1), dt.date(2023, 11, 10), panel, 5_000_000)
        return panel

    def test_clean_build_proceeds(self):
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td)
            out = verify.verify(panel, panel.with_suffix(".audit.json"), None, 0.05, 0.001, 0, 0)
            self.assertEqual(out["verdict"], "PROCEED", out["reasons"])
            self.assertGreater(out["eligible_rows"], 0)
            self.assertEqual(out["flagged_contracts"], 0)

    def test_funding_gap_raises_na_and_stops(self):
        days = [dt.date(2023, 10, 1) + dt.timedelta(days=i) for i in range(43)]
        gaps = {(d, s) for d in days[30:] for s in ("A-USDT-SWAP", "B-USDT-SWAP")}
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td, skip_funding=gaps)
            out = verify.verify(panel, panel.with_suffix(".audit.json"), None, 0.05, 0.001, 0, 0)
            self.assertEqual(out["verdict"], "STOP")
            self.assertGreater(out["eligible_funding_na_share"], 0.05)

    def test_tampered_panel_and_wrong_counters_stop(self):
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td)
            audit = panel.with_suffix(".audit.json")
            out = verify.verify(panel, audit, None, 0.05, 0.001, 3, 3)
            self.assertEqual(out["verdict"], "STOP")  # expected 3 markers, fixture has 0
            text = panel.read_text().splitlines()
            panel.write_text("\n".join(text[:-1]) + "\n")
            out = verify.verify(panel, audit, None, 0.05, 0.001, 0, 0)
            self.assertIn("panel SHA differs from the builder audit", out["reasons"])

    def test_cadence_flag_from_panel(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "p.csv"
            with open(path, "w", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(verify.HEADER)
                for d in range(3):
                    for h in range(24):
                        ts = d * verify.DAY + h * 3_600_000
                        every = 8 if d < 2 else 4
                        for sym in ("FLIP", "STEADY"):
                            step = every if sym == "FLIP" else 8
                            w.writerow((ts, sym, 1, 1, 1, 1, 1, 1, "0.0001" if h % step == step - 1 else "", ""))
            *_, flagged = verify.scan(path)
            self.assertEqual(flagged, {"FLIP"})


class TestFreezePreflight(unittest.TestCase):
    def test_registered_batches_are_stable_and_in_range(self):
        hyps = [h for f in REGISTERED for h in bench.read_hypotheses(HYP_DIR / f)]
        self.assertEqual(len(hyps), 31)
        self.assertEqual(len({bench.hypothesis_sha(h) for h in hyps}), 31)
        self.assertEqual(len({h["id"] for h in hyps}), 31)
        medium = bench.read_hypotheses(HYP_DIR / REGISTERED[2])
        self.assertTrue(all(48 <= h["horizon_bars"] <= 2160 for h in medium))

    def test_cli_audit_then_freeze_with_trial_floor(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            panel = td / "p.csv"
            bench.synthesize(panel, symbols=12, bars=800, seed=5, never_eligible_frac=0.25)
            bench.main(["audit", "--panel", str(panel), "--expect-bar-ms", "3600000"])
            args = ["freeze", "--panel", str(panel), "--out", str(td / "cfg.json"), "--holdout-frac", "0.25",
                    "--prior-trials", "200"]
            for f in REGISTERED:
                args += ["--registered-hyp", str(HYP_DIR / f)]
            bench.main(args)
            cfg = json.loads((td / "cfg.json").read_text())
            gate = cfg["gate"]
            self.assertEqual(gate["prior_trials"], 200)
            self.assertEqual(len(gate["registered_hypotheses"]), 31)
            self.assertEqual(gate["gate_cost_bp_per_side"], 10)
            self.assertEqual(bench.count_trials(gate, []), 231)
            self.assertEqual(len(cfg["symbols"]), 9)  # never-eligible contracts are not in the frozen universe


if __name__ == "__main__":
    unittest.main()
