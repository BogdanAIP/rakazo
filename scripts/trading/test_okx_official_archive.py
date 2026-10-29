"""Official archive import integration checks with synthetic, signed-locally ZIPs.

These tests do not assert historical authenticity or trading profitability.
"""
import csv
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from calendar import monthrange
from datetime import datetime, timedelta, timezone
from pathlib import Path

from okx_archive_import import convert, read_month
from okx_funding_archive import import_archives
from run_alpha_audited import verify_snapshot

SYMBOL="BTC-USDT-SWAP"
MONTH="2026-07"
TZ8=timezone(timedelta(hours=8))


def make_zip(folder, rows, module="2"):
    prefix="candlesticks" if module=="2" else "fundingrates"
    filename=f"{SYMBOL}-{prefix}-{MONTH}"
    zipped=Path(folder)/(filename+".zip")
    columns=(["instrument_name","open","high","low","close",
              "vol","vol_ccy","vol_quote","open_time","confirm"]
             if module=="2" else
             ["instrument_name","funding_rate","funding_time"])
    buffer=io.StringIO(newline="")
    writer=csv.writer(buffer,lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(rows)
    with zipfile.ZipFile(zipped,"w",compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(filename+".csv",buffer.getvalue().encode())
    digest=hashlib.sha256(zipped.read_bytes()).hexdigest()
    url=(f"https://static.okx.com/cdn/okex/traderecords/{prefix}/"
         f"monthly/202607/{zipped.name}")
    receipt={
        "protocol":"okx_official_archive_v5","symbol":SYMBOL,
        "month":MONTH,"module":module,"zip_file":zipped.name,
        "archive_url":url,"sha256":digest,
        "size_bytes":zipped.stat().st_size
    }
    Path(str(zipped)+".receipt.json").write_text(json.dumps(receipt))
    return zipped


def july_rows(remove_index=None):
    n=monthrange(2026,7)[1]*1440
    t=int(datetime(2026,7,1,tzinfo=TZ8).timestamp()*1000)
    for i in range(n):
        if i==remove_index:
            continue
        op=100+i/100000
        yield [SYMBOL,str(op),str(op+0.01),str(op-0.01),
               str(op+0.001),"100","1","1000",str(t+i*60000),"1"]


class ArchiveTests(unittest.TestCase):
    def test_complete_archive_aggregates_15m_and_verifies_source_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            zipped=make_zip(d,july_rows())
            dest=Path(d)/"out.csv"
            result=convert([zipped],SYMBOL,dest,
                           as_of=datetime(2026,10,1,tzinfo=timezone.utc))
            self.assertEqual(result["minutes_verified"],44640)
            self.assertEqual(result["closed_15m_bars"],2976)
            bars,manifest,_=verify_snapshot(dest,dest.with_suffix(".manifest.json"))
            self.assertEqual(len(bars),2976)
            self.assertEqual(manifest["source"],"official_archive")
            zipped.write_bytes(zipped.read_bytes()+b"X")
            with self.assertRaises(ValueError):
                verify_snapshot(dest,dest.with_suffix(".manifest.json"))

    def test_missing_one_minute_rejects_archive(self):
        with tempfile.TemporaryDirectory() as d:
            zipped=make_zip(d,july_rows(remove_index=133))
            with self.assertRaises(ValueError):
                read_month(zipped,SYMBOL)

    def test_funding_events_are_preserved_without_claiming_settled_account_bills(self):
        with tempfile.TemporaryDirectory() as d:
            t=int(datetime(2026,7,1,tzinfo=TZ8).timestamp()*1000)
            rows=[[SYMBOL,"0.0001",str(t)],
                  [SYMBOL,"-0.0002",str(t+8*3600000)],
                  [SYMBOL,"0.0003",str(t+16*3600000)]]
            zipped=make_zip(d,rows,module="3")
            output=Path(d)/"funding.json"
            result=import_archives([zipped],SYMBOL,output)
            self.assertEqual(result["events"],3)
            self.assertEqual(result["observed_intervals_hours"],[8.0])
            self.assertFalse(result["account_funding_verified"])
            records=json.loads(output.read_text())
            self.assertFalse(records["calendar_completeness_certified"])


if __name__=="__main__":
    unittest.main()
