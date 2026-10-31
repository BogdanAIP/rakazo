"""v22 offline genuine-format .data single-NDJSON historical L2 replay tests.

All fixture prices are SYNTHETIC; they must not be reported as OKX trades.
"""
from __future__ import annotations
from io import BytesIO
from pathlib import Path
import hashlib
import json
import tarfile
import tempfile
import unittest

from algorithm_historical_l2_official_v22 import (
    ENTRY_MS,EXIT_MS,REQUIRED_MEMBER,SCHEMA,SYMBOL,
    replay_fixed,validate_receipt,benchmark
)
from algorithm_official_archive_download_v22 import (
    ARCHIVE_NAME,URL,SCHEMA as RECEIPT_SCHEMA,fixed_url
)
from algorithm_multiday_registry_v12 import sha256


def sample_rows():
    def frame(ts,action,bids,asks,*,symbol=SYMBOL):
        return {"instId":symbol,"action":action,"ts":str(ts),
                "bids":bids,"asks":asks}
    return [
        frame(ENTRY_MS-1_000,"snapshot",
              [["100","5","1"],["99","2","1"]],
              [["101","5","1"],["102","2","1"]]),
        frame(ENTRY_MS+1_000,"update",
              [["100","0","0"],["100.5","6","2"]],
              [["101","0","0"],["101.5","8","2"]]),
        frame(EXIT_MS-1_000,"update",
              [["100.5","0","0"],["101","10","4"]],
              [["101.5","0","0"],["102","9","3"]]),
        frame(EXIT_MS+1_000,"update",
              [["101","0","0"],["400","10","2"]],
              [["102","0","0"],["401","9","2"]])
    ]


def create_archive(folder,rows=None,*,member_name=REQUIRED_MEMBER):
    folder=Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    archive=folder/ARCHIVE_NAME
    data=b"".join(json.dumps(row).encode()+b"\n" for row in (
        sample_rows() if rows is None else rows))
    with tarfile.open(archive,"w:gz") as tf:
        f=tarfile.TarInfo(member_name)
        f.size=len(data)
        tf.addfile(f,BytesIO(data))
    return archive


def attach_receipt(folder):
    archive=Path(folder)/ARCHIVE_NAME
    r={
        "schema":RECEIPT_SCHEMA,
        "source_kind":"OKX_PUBLIC_OFFICIAL_HISTORICAL_ARCHIVE_NOT_REALTIME_MARKET_BOOK",
        "symbol":SYMBOL,
        "archive_date_utc":"2026-09-02",
        "archive_name":ARCHIVE_NAME,
        "original_archive_sha256":sha256(archive.read_bytes()),
        "original_bytes":archive.stat().st_size,
        "download_completed_utc":"2026-10-31T05:00:00+00:00",
        "http_evidence":{"url":URL,"response_status":200,"response_content_length":str(archive.stat().st_size)},
        "independently_cryptographically_venue_signed":False,
        "no_pricing_values_read":True,
        "no_orders_or_live_book_calls":True,
    }
    path=Path(folder)/(ARCHIVE_NAME+".receipt.json")
    path.write_text(json.dumps(r,sort_keys=True))
    return path


class OfficialHistoryReplayTests(unittest.TestCase):
    def test_exact_asof_entry_exit_no_future_lookahead(self):
        with tempfile.TemporaryDirectory() as td:
            archive=create_archive(td)
            r=replay_fixed(archive)
        self.assertEqual(r["entry"]["bid"],"100")
        self.assertEqual(r["entry"]["ask"],"101")
        self.assertEqual(r["entry"]["book_quote_age_ms"],1000)
        self.assertEqual(r["exit"]["bid"],"101")
        self.assertEqual(r["exit"]["ask"],"102")
        self.assertEqual(r["exit"]["book_quote_age_ms"],1000)
        self.assertEqual(r["source_events_applied"],3)
        self.assertEqual(r["full_snapshots_seen_before_exit"],1)
        self.assertFalse(r["source_seq_fields_available"])
        self.assertTrue(r["no_future_lookahead_at_entry_or_exit"])

    def test_both_directions_reported_without_selecting_profitable_side(self):
        with tempfile.TemporaryDirectory() as td:
            create_archive(td)
            attach_receipt(td)
            r=benchmark(td)
        self.assertEqual(r["schema"],SCHEMA)
        self.assertEqual(set(r["bid_ask_crossing_hypothetical_bps_both_directions"]),{"long","short"})
        self.assertLess(float(r["bid_ask_crossing_hypothetical_bps_both_directions"]["long"]["base_five_bps_per_side_proxy_net_bps"]),0)
        self.assertLess(float(r["bid_ask_crossing_hypothetical_bps_both_directions"]["short"]["base_five_bps_per_side_proxy_net_bps"]),0)
        self.assertFalse(r["prospectively_precommitted_model_signal_used"])
        self.assertFalse(r["counts_toward_validated_alpha"])
        self.assertFalse(r["can_trade"])
        self.assertIsNone(r["realized_pnl"])

    def test_missing_full_snapshot_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            archive=create_archive(td,sample_rows()[1:])
            with self.assertRaises(ValueError):
                replay_fixed(archive)

    def test_wrong_exchange_instrument_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            rows=sample_rows()
            rows[0]["instId"]="BTC-USDT-SWAP"
            archive=create_archive(td,rows)
            with self.assertRaises(ValueError):
                replay_fixed(archive)

    def test_nonchronological_time_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            rows=sample_rows()
            rows[1]["ts"]=str(ENTRY_MS-2000)
            archive=create_archive(td,rows)
            with self.assertRaises(ValueError):
                replay_fixed(archive)

    def test_stale_asof_book_rejected_not_imputed(self):
        with tempfile.TemporaryDirectory() as td:
            rows=sample_rows()
            rows[0]["ts"]=str(ENTRY_MS-6000)
            archive=create_archive(td,rows)
            with self.assertRaises(ValueError):
                replay_fixed(archive)

    def test_tampered_archive_receipt_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            archive=create_archive(td)
            attach_receipt(td)
            archive.write_bytes(archive.read_bytes()+b"GARBAGE")
            with self.assertRaises(ValueError):
                validate_receipt(td)

    def test_unknown_member_format_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            archive=create_archive(td,member_name="file.jsonl")
            with self.assertRaises(ValueError):
                replay_fixed(archive)

    def test_download_url_strictly_allowlisted(self):
        fixed_url(URL)
        with self.assertRaises(ValueError):
            fixed_url("http://static.okx.com/historical-data")
        with self.assertRaises(ValueError):
            fixed_url("https://example.com/NEAR-USDT-SWAP.tar.gz")


if __name__=="__main__":
    unittest.main()
