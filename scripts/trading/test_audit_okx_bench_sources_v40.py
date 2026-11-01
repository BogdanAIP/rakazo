"""Offline tests of funding-coverage diagnostics; no expected schedule is fabricated."""
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import audit_okx_bench_sources_v40 as audit


class TestFundingCoverageDiagnostics(unittest.TestCase):
    def test_duplicate_variants_are_counted_without_selecting_a_price(self):
        with tempfile.TemporaryDirectory() as td:
            root, day = Path(td), dt.date(2023, 10, 1)
            t = int(dt.datetime(2023, 9, 30, 16, tzinfo=dt.timezone.utc).timestamp() * 1000)
            text = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            first = f"X-USDT-SWAP,1,1,1,1,0,0,0,{t},0\n"
            text += first + first + f"X-USDT-SWAP,2,2,2,2,0,0,0,{t},0\n"
            p = audit.source.file_at(root, "candles", day)
            p.parent.mkdir()
            with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("source.csv", text)
            result, hours = audit.inspect_candles(root, day)
            self.assertEqual(result["source_minutes"], 1)
            self.assertEqual(result["original_minute_rows"], 3)
            self.assertEqual(result["duplicate_identical_fields"], 1)
            self.assertEqual(result["duplicate_nonidentical_fields"], 1)
            self.assertFalse(result["duplicate_price_selection_performed"])
            self.assertEqual(len(hours), 1)

    def test_canonical_row_string_keeps_exact_duplicate_detection(self):
        with tempfile.TemporaryDirectory() as td:
            root, day = Path(td), dt.date(2023, 10, 1)
            t = int(dt.datetime(2023, 9, 30, 16, tzinfo=dt.timezone.utc).timestamp() * 1000)
            header = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            # A naive comma join of these two rows is identical; the fingerprint must still differ.
            text = header + f'X-USDT-SWAP,1,1,1,1,"1,2",3,0,{t},0\n' + f'X-USDT-SWAP,1,1,1,1,1,"2,3",0,{t},0\n'
            text += f"X-USDT-SWAP,1,1,1,1,1.0,3,0,{t},0\n"
            p = audit.source.file_at(root, "candles", day)
            p.parent.mkdir()
            with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("source.csv", text)
            result, _ = audit.inspect_candles(root, day)
            self.assertEqual(result["duplicate_identical_fields"], 0)
            self.assertEqual(result["duplicate_nonidentical_fields"], 2)
            self.assertEqual(result["duplicate_differing_fields"], {"vol": 2, "vol_ccy": 1})
            with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("source.csv", header + f"X-USDT-SWAP,1,1,1,1,0,0,0,{t},0,extra\n")
            with self.assertRaises(ValueError):
                audit.inspect_candles(root, day)

    def test_real_archive_audit_preserves_off_hour_event_and_counts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            day = dt.date(2023, 10, 1)
            t = int(dt.datetime(2023, 9, 30, 16, tzinfo=dt.timezone.utc).timestamp() * 1000)
            candles = "instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
            candles += "".join(f"X-USDT-SWAP,1,1,1,1,0,0,0,{t+m*60000},0\n" for m in range(60))
            funding = f"instrument_name,funding_rate,funding_time\nX-USDT-SWAP,0,{t+8000}\n"
            receipts = {}
            for kind, content in (("candles", candles), ("funding", funding)):
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    z.writestr("source.csv", content)
                payload = buf.getvalue()
                p = audit.source.file_at(root, kind, day)
                p.parent.mkdir(exist_ok=True)
                p.write_bytes(payload)
                receipts[kind] = {"sha256": hashlib.sha256(payload).hexdigest(), "zip_bytes": len(payload),
                                  "official_url": "https://static.okx.com/example.zip"}
            (root / "receipts").mkdir()
            (root / "receipts" / f"{day}.json").write_text(json.dumps(receipts))
            result = audit.audit(root, day, day, root / "manifest.json", root / "audit.json")
            self.assertEqual(result["source_minutes"], 60)
            self.assertEqual(result["per_archive_quality"][0]["original_funding_events"], 1)
            self.assertEqual(result["funding"]["observed_events"], 1)
            self.assertEqual(result["funding"]["non_hour_aligned_events"], 1)
            self.assertNotIn("funding_events", result["per_archive_quality"][0])

    def test_full_utc_day_coverage_across_archive_boundaries(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            start,end=dt.date(2023,11,1),dt.date(2023,11,2)
            (root/"receipts").mkdir()
            missing=int(dt.datetime(2023,11,1,5,tzinfo=dt.timezone.utc).timestamp()*1000)
            for day in (start,end):
                begin=int(dt.datetime.combine(day,dt.time(),dt.timezone.utc).timestamp()*1000)-8*audit.source.HOUR
                candle="instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm\n"
                funding="instrument_name,funding_rate,funding_time\n"
                for h in range(24):
                    t=begin+h*audit.source.HOUR
                    for symbol in ("X-USDT-SWAP","Y-USDT-SWAP"):
                        if symbol=="Y-USDT-SWAP" and t==missing:continue
                        row=f"{symbol},1,1,1,1,0,0,0,{t},0\n"
                        candle+=row+row  # repeated minutes cannot fill a missing hour
                        if h%8==0:
                            funding+=f"{symbol},0.001,{t+2000}\n"
                receipt={}
                for kind,text in (("candles",candle),("funding",funding)):
                    path=audit.source.file_at(root,kind,day);path.parent.mkdir(exist_ok=True)
                    with zipfile.ZipFile(path,"w",zipfile.ZIP_DEFLATED) as z:z.writestr("source.csv",text)
                    data=path.read_bytes()
                    receipt[kind]={"sha256":hashlib.sha256(data).hexdigest(),"zip_bytes":len(data),
                                   "official_url":"https://static.okx.com/example.zip"}
                (root/"receipts"/f"{day}.json").write_text(json.dumps(receipt))
            result=audit.audit(root,start,end,root/"manifest.json",root/"quality.json")
            self.assertEqual(result["funding"]["full_observed_hour_contract_days"],1)
            self.assertEqual(result["funding"]["settlement_count_histogram_full_days"],{3:1})
            self.assertEqual(result["duplicate_identical_fields"],95)
            self.assertEqual(result["duplicate_nonidentical_fields"],0)

    def test_original_off_hour_clock_is_reported_without_rounding(self):
        t = int(dt.datetime(2023, 10, 1, 8, tzinfo=dt.timezone.utc).timestamp() * 1000) + 8000
        events = {(t, "X"): 0.001}
        result = audit.funding_diagnostics(events, {("2023-10-01", "X")})
        self.assertEqual(result["non_hour_aligned_events"], 1)
        self.assertEqual(result["hour_offset_histogram_ms"], {8000: 1})
        self.assertFalse(result["hour_bucket_rounding_performed"])
        self.assertEqual(next(iter(events))[0], t)

    def test_zero_rate_is_an_observed_settlement_not_absent_data(self):
        t = int(dt.datetime(2023, 10, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        events = {(t + h * 3_600_000, "X"): 0.0 for h in (0, 8, 16)}
        result = audit.funding_diagnostics(events, {("2023-10-01", "X")})
        self.assertEqual(result["settlement_count_histogram_full_days"], {3: 1})
        self.assertEqual(result["zero_observed_settlement_full_days"], 0)
        self.assertFalse(result["coverage_certified"])

    def test_variable_and_zero_event_days_are_flagged_without_assuming_eight_hours(self):
        t = int(dt.datetime(2023, 10, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        events = {(t + h * 3_600_000, "X"): 0.001 for h in (0, 8, 16, 24, 40)}
        full = {("2023-10-01", "X"), ("2023-10-02", "X"), ("2023-10-03", "X")}
        result = audit.funding_diagnostics(events, full)
        self.assertEqual(result["settlement_count_histogram_full_days"], {0: 1, 2: 1, 3: 1})
        self.assertEqual(result["symbols_with_varying_full_day_counts"], ["X"])
        self.assertEqual(result["gaps_greater_than_eight_hours"], 1)
        self.assertFalse(result["historical_settlement_schedule_verified"])

    def test_clock_jitter_is_not_a_long_funding_gap(self):
        t = int(dt.datetime(2023, 10, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        lags = {0: 2000, 8: 9000, 16: 1000, 32: 5000}
        events = {(t + h * 3_600_000 + lag, "X"): 0.001 for h, lag in lags.items()}
        result = audit.funding_diagnostics(events, set())
        self.assertEqual(result["gaps_greater_than_eight_hours"], 2)
        self.assertEqual(result["gaps_greater_than_eight_nominal_hours"], 1)
        self.assertEqual(result["nominal_gap_hours_histogram"], {8: 2, 16: 1})


if __name__ == "__main__":
    unittest.main()
