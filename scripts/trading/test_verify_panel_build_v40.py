"""Offline tests: post-build panel verifier and the audit -> freeze preflight."""
from __future__ import annotations

import contextlib
import csv
import datetime as dt
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import algorithm_bench_v40 as bench
import binance_bench_archive_v40 as bn
import okx_bench_archive_v40 as archive
import verify_panel_build_v40 as verify
from test_binance_bench_archive_v40 import funding_rows, kline_rows, month_start, put
from test_okx_bench_archive_v40 import compressed

HYP_DIR = Path(__file__).resolve().parents[2] / "docs" / "trading" / "bench" / "hypotheses"
REGISTERED = ["claude-2026-10-31.json", "gpt-2026-10-31.json", "gpt-medium-horizon-2026-10-31.json",
              "claude-composites-2026-11-01.json"]


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
            flagged = verify.scan(path)[4]
            self.assertEqual(flagged, {"FLIP"})


class TestBinanceVerifier(unittest.TestCase):
    FUND_HEADER = ["calc_time", "funding_interval_hours", "last_funding_rate"]

    def build(self, td, drop_hours=0):
        root = Path(td)
        for mth in ("2020-01", "2020-02", "2020-03"):
            rows = kline_rows(mth, 400_000)
            if mth == "2020-02" and drop_hours:
                rows = rows[:100] + rows[100 + drop_hours:]  # a gap inside the contract's span
            put(root, "klines", "BIGUSDT", mth, rows)
            put(root, "fundingRate", "BIGUSDT", mth, funding_rows(mth), header=self.FUND_HEADER)
            if mth != "2020-03":  # delisted: its span ends, which is not a gap
                stop = month_start("2020-02") + 10 * 24 * verify.HOUR if mth == "2020-02" else None
                put(root, "klines", "GONEUSDT", mth, kline_rows(mth, 500_000, stop))
                put(root, "fundingRate", "GONEUSDT", mth, funding_rows(mth), header=self.FUND_HEADER)
        panel = root / "panel.csv"
        bn.build(root, ["BIGUSDT", "GONEUSDT"], "2020-01", "2020-03", panel)
        return panel

    def test_clean_binance_build_proceeds_with_minutes_unknown(self):
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td)
            audit = panel.with_suffix(".audit.json")
            self.assertNotIn("missing_source_minutes", json.loads(audit.read_text()))
            out = verify.verify(panel, audit, None, 0.05, 0.001, None, None)
            self.assertEqual(out["verdict"], "PROCEED", out["reasons"])
            self.assertEqual(out["source"], "binance")
            self.assertEqual(out["minute_coverage"], "UNKNOWN")
            self.assertIsNone(out["missing_minute_share_of_panel"])  # never a silent zero
            self.assertEqual(out["funding_off_clock_events"], 0)
            self.assertNotIn("unavailable_off_hour_markers", out)  # no invented OKX counters
            hourly = out["hourly_coverage"]
            self.assertEqual(hourly["missing_hours_in_spans"], 0)
            self.assertEqual(hourly["expected_hours_in_spans"], (31 + 29 + 31) * 24 + (31 + 10) * 24)
            self.assertGreater(out["eligible_rows"], 0)

    def test_hour_gap_is_counted_and_gated(self):
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td, drop_hours=5)
            out = verify.verify(panel, panel.with_suffix(".audit.json"), None, 0.05, 0.001, None, None)
            self.assertEqual(out["hourly_coverage"]["missing_hours_in_spans"], 5)
            self.assertEqual(out["hourly_coverage"]["worst_contracts_by_missing_hours"], [("BIGUSDT", 5)])
            self.assertEqual(out["verdict"], "STOP")  # 5 / 3168 hours > 0.1%
            loose = verify.verify(panel, panel.with_suffix(".audit.json"), None, 0.05, 0.001, None, None,
                                  max_missing_hours=0.01)
            self.assertEqual(loose["verdict"], "PROCEED", loose["reasons"])

    def test_okx_counters_cannot_be_applied_to_binance(self):
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td)
            with self.assertRaises(ValueError):
                verify.verify(panel, panel.with_suffix(".audit.json"), None, 0.05, 0.001, 3, 3)
            with self.assertRaises(SystemExit) as done, contextlib.redirect_stdout(io.StringIO()):
                verify.main(["--panel", str(panel)])  # OKX defaults 3/3 are not applied to Binance
            self.assertEqual(done.exception.code, 0)

    def test_tampered_binance_panel_stops(self):
        with tempfile.TemporaryDirectory() as td:
            panel = self.build(td)
            text = panel.read_text().splitlines()
            panel.write_text("\n".join(text[:-1]) + "\n")
            out = verify.verify(panel, panel.with_suffix(".audit.json"), None, 0.05, 0.001, None, None)
            self.assertIn("panel SHA differs from the builder audit", out["reasons"])
            self.assertEqual(out["verdict"], "STOP")

    def test_source_detection(self):
        self.assertEqual(verify.detect_source({"funding_clock": {}, "missing_source_minutes": 0}), "okx")
        self.assertEqual(verify.detect_source({"funding_off_clock_events": 0}), "binance")
        with self.assertRaises(ValueError):
            verify.detect_source({"panel_rows": 1})


class TestOkxAuditFieldsRequired(unittest.TestCase):
    def test_missing_minute_field_stops_instead_of_zero(self):
        with tempfile.TemporaryDirectory() as td:
            panel = TestVerifier().build(td)
            audit = panel.with_suffix(".audit.json")
            data = json.loads(audit.read_text())
            data.pop("missing_source_minutes")
            audit.write_text(json.dumps(data))
            out = verify.verify(panel, audit, None, 0.05, 0.001, 0, 0, source="okx")
            self.assertEqual(out["verdict"], "STOP")
            self.assertIn("OKX audit has no missing_source_minutes", out["reasons"])


class TestFreezePreflight(unittest.TestCase):
    def test_registered_batches_are_stable_and_in_range(self):
        hyps = [h for f in REGISTERED for h in bench.read_hypotheses(HYP_DIR / f)]
        self.assertEqual(len(hyps), 39)
        self.assertEqual(len({bench.hypothesis_sha(h) for h in hyps}), 39)
        self.assertEqual(len({h["id"] for h in hyps}), 39)
        for f in REGISTERED[2:]:
            self.assertTrue(all(48 <= h["horizon_bars"] <= 2160 for h in bench.read_hypotheses(HYP_DIR / f)))

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
            self.assertEqual(len(gate["registered_hypotheses"]), 39)
            self.assertEqual(gate["gate_cost_bp_per_side"], 10)
            self.assertEqual(bench.count_trials(gate, []), 239)
            self.assertEqual(len(cfg["symbols"]), 9)  # never-eligible contracts are not in the frozen universe


if __name__ == "__main__":
    unittest.main()
