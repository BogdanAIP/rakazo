"""Funding evidence integrity, publication embargo, and v4 fail-closed ablations."""
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from alpha_discovery import Candle
from algorithm_funding_v4 import (
    BAR_MS, FundingEvent, available_pair, development, gate_decisions,
    verified_funding,
)

T0 = datetime(2025, 1, 1, tzinfo=timezone.utc)
BASE = int(T0.timestamp() * 1000)


def bars(n=1200):
    return [Candle(T0 + timedelta(minutes=15*i), 100, 101, 99, 100, 100)
            for i in range(n)]


class FundingV4Tests(unittest.TestCase):
    def test_embargo_cannot_use_current_unpublished_settlement(self):
        data = [FundingEvent(BASE-8*BAR_MS, .0002),
                FundingEvent(BASE, -.0003)]
        # 15 minute embargo: recent funding not known at 00:14, known at 00:15.
        self.assertIsNone(available_pair(data, BASE+BAR_MS-1, 1))
        self.assertEqual(available_pair(data, BASE+BAR_MS, 1)[1].rate, -.0003)
        self.assertIsNone(available_pair(data, BASE+BAR_MS, 4))
        self.assertEqual(available_pair(data, BASE+4*BAR_MS, 4)[1].rate, -.0003)

    def test_missing_stale_or_bad_frequency_abstains(self):
        history = [FundingEvent(BASE-16*BAR_MS,.0001),
                   FundingEvent(BASE,.0002)]
        self.assertIsNone(available_pair([],BASE+BAR_MS,1))
        self.assertIsNone(available_pair(history, BASE+35*BAR_MS,1))
        with self.assertRaises(ValueError):
            available_pair(history, BASE+BAR_MS,0)
        with self.assertRaises(ValueError):
            available_pair(history[::-1], BASE+BAR_MS,1)

    def test_sign_and_trend_are_distinct_hypotheses(self):
        sample = bars(25)
        records = [FundingEvent(BASE,.0005), FundingEvent(BASE+BAR_MS*8,.0002)]
        targets = [0]*18 + [1]*4 + [0]*3
        receive, m = gate_decisions(sample,targets,records,"carry_receive",1)
        decline, n = gate_decisions(sample,targets,records,"funding_deceleration",1)
        self.assertEqual(receive,[0]*25)
        self.assertEqual(decline[18:22],[1]*4)
        self.assertEqual((m["considered"],m["accepted"]), (1,0))
        self.assertEqual((n["considered"],n["accepted"]), (1,1))
        inverse, _ = gate_decisions(sample,[-x for x in targets],records,"carry_receive",1)
        self.assertEqual(inverse[18:22],[-1]*4)

    def test_suppression_does_not_reenter_during_same_lease(self):
        sample=bars(25)
        records=[FundingEvent(BASE,.0005),FundingEvent(BASE+BAR_MS*8,.0002),
                 FundingEvent(BASE+BAR_MS*19,-.0001)]
        targets=[0]*18+[1]*4+[0]*3
        result,metrics=gate_decisions(sample,targets,records,"carry_receive",1)
        self.assertEqual(result,[0]*25)
        self.assertEqual(metrics["considered"],1)

    def test_future_mutations_do_not_affect_past_decisions(self):
        sample=bars(100)
        targets=[0]*18+[1]*4+[0]*78
        history=[FundingEvent(BASE,.0001),FundingEvent(BASE+BAR_MS*8,-.0002)]
        original,_=gate_decisions(sample,targets,history,"carry_receive",1)
        altered,_=gate_decisions(sample,targets,history+
                [FundingEvent(BASE+BAR_MS*50,.01)],"carry_receive",1)
        self.assertEqual(original,altered)

    def test_final_twenty_percent_never_accessed(self):
        class Guarded(list):
            def __getitem__(self,key):
                if isinstance(key,slice) and (key.stop is None or key.stop>960):
                    raise AssertionError("Read holdout")
                if isinstance(key,int) and (key<0 or key>=960):
                    raise AssertionError("Read holdout")
                return super().__getitem__(key)
        sample=Guarded(bars())
        data=development(sample,[])
        self.assertFalse(data["holdout_used"])
        self.assertEqual(data["reserved_range"],[960,1200])

    def test_unknown_gate_and_target_rejected(self):
        with self.assertRaises(ValueError):
            gate_decisions(bars(3),[0,1,0],[],"magic",1)
        with self.assertRaises(ValueError):
            gate_decisions(bars(3),[0,2,0],[],"price_coverage",1)

    def test_zip_receipt_tamper_detected(self):
        symbol="BTC-USDT-SWAP"
        month="2025-01"
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            zpath=root/f"{symbol}-fundingrates-{month}.zip"
            lines="instrument_name,funding_rate,funding_time\n"+f"{symbol},0.0001,{BASE}\n"+f"{symbol},-0.0002,{BASE+8*BAR_MS}\n"
            with zipfile.ZipFile(zpath,"w") as z:
                z.writestr(f"{symbol}-fundingrates-{month}.csv",lines)
            data=zpath.read_bytes()
            digest=hashlib.sha256(data).hexdigest()
            source={"month":month,"archive_path":str(zpath.resolve()),"archive_sha256":digest}
            report={"format":"okx_archive_funding_v5","symbol":symbol,
                    "source":"OKX_OFFICIAL_MONTHLY_ARCHIVE",
                    "calendar_completeness_certified":False,
                    "account_realized_funding_verified":False,"allow_trading":False,
                    "source_archives":[source],"downloaded_zip_sha256":[digest],
                    "events_count":2,"events":[
                        {"time_ms":BASE,"archive_funding_rate":.0001},
                        {"time_ms":BASE+8*BAR_MS,"archive_funding_rate":-.0002}]}
            receipt={"protocol":"okx_official_archive_v5","module":"3",
                     "symbol":symbol,"month":month,"sha256":digest,
                     "size_bytes":len(data),
                     "archive_url":"https://static.okx.com/cdn/okex/traderecords/example"}
            Path(str(zpath)+".receipt.json").write_text(json.dumps(receipt))
            report_path=root/"funding.json"
            report_path.write_text(json.dumps(report))
            e,_=verified_funding(report_path,symbol)
            self.assertEqual(len(e),2)
            report["events"][1]["archive_funding_rate"]=.0003
            report_path.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                verified_funding(report_path,symbol)
            report["events"][1]["archive_funding_rate"]=-.0002
            report_path.write_text(json.dumps(report))
            receipt["sha256"]="0"*64
            Path(str(zpath)+".receipt.json").write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):
                verified_funding(report_path,symbol)


if __name__ == "__main__":
    unittest.main()
