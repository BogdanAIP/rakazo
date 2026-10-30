"""v16 independent historical L2 quote replay and prospective source-time tests."""
from __future__ import annotations

from decimal import Decimal
from io import BytesIO
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from algorithm_historical_l2_v16 import (
    ORIGIN_SCHEMA, HORIZON_MS, replay_tar_gz, scenario, label_provisional,
    original_signal
)
from test_algorithm_manual_runner_v13 import init, MEMBERS
from test_algorithm_ai_research_v14 import candidate, OCT30
from algorithm_ai_research_v14 import propose

T=1793515500000
SYMBOL="ETH-USDT-SWAP"


def event(ts, action="update", bids=None, asks=None, seq=None, prev=None):
    e={"ts":ts,"action":action}
    if bids is not None:
        e["bids"]=bids
    if asks is not None:
        e["asks"]=asks
    if seq is not None:
        e["seqId"]=seq
        e["prevSeqId"]=prev
    return e


def archive_file(path,events,*,filename="book.jsonl"):
    data=b"".join(json.dumps(e,sort_keys=True).encode()+b"\n" for e in events)
    with tarfile.open(path,"w:gz") as tar:
        t=tarfile.TarInfo(filename)
        t.size=len(data)
        tar.addfile(t,BytesIO(data))
    return path


def quote_events():
    return [
        event(T-4000,"snapshot",bids=[["99","2"]],asks=[["99.5","3"]],seq=10,prev=-1),
        event(T-1000,"update",bids=[["99","0"],["100","4"]],asks=[["100.1","5"],["99.5","0"]],seq=11,prev=10),
        event(T+1000,"update",bids=[["100","0"],["200","2"]],asks=[["201","2"],["100.1","0"]],seq=12,prev=11),
    ]


def meta_file(folder,archive,*,claimed=T+9000,verified=False,symbol=SYMBOL):
    meta={
        "schema":ORIGIN_SCHEMA,
        "symbol":symbol,
        "archive_sha256":hashlib.sha256(Path(archive).read_bytes()).hexdigest(),
        "download_source_url":"https://www.okx.com/en-us/historical-data",
        "claimed_download_complete_utc_ms":claimed,
        "exchange_origin_independently_verified":verified,
    }
    p=Path(folder)/"origin.json"
    p.write_text(json.dumps(meta))
    return p


class HistoricalL2ReplayTests(unittest.TestCase):
    def test_asof_price_is_last_update_not_future_first_bracket(self):
        with tempfile.TemporaryDirectory() as td:
            f=archive_file(Path(td)/"book.tar.gz",quote_events())
            result=replay_tar_gz(f,T)
        self.assertEqual(result["best_bid"],"100")
        self.assertEqual(result["best_ask"],"100.1")
        self.assertEqual(result["bid_qty_at_best"],"4")
        self.assertEqual(result["ask_qty_at_best"],"5")
        self.assertEqual(result["first_after_target_exchange_ts"],T+1000)
        self.assertEqual(result["latest_book_exchange_ts"],T-1000)
        self.assertTrue(result["sequence_integrity_checked_if_available"])
        self.assertFalse(result["is_actual_order_fill"])

    def test_no_snapshot_or_stale_target_or_far_bracket_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            for name,rows in (
                ("no-snapshot",[event(T-1000,"update",bids=[["100","2"]]),event(T+1000,"update",bids=[["101","2"]])]),
                ("stale",[event(T-6000,"snapshot",bids=[["100","2"]],asks=[["101","2"]]),event(T+1000,"update",bids=[["100","3"]])]),
                ("far-bracket",[event(T-1000,"snapshot",bids=[["100","2"]],asks=[["101","2"]]),event(T+8000,"update",bids=[["100","3"]])]),
            ):
                a=archive_file(p/f"{name}.tar.gz",rows)
                with self.assertRaises(ValueError,msg=name):
                    replay_tar_gz(a,T)

    def test_sequence_gap_crossed_book_timestamp_backwards_invalid(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            variants=[
                [quote_events()[0],event(T-1000,"update",bids=[["100","2"]],seq=20,prev=9),quote_events()[2]],
                [event(T-4000,"snapshot",bids=[["100","1"]],asks=[["100.1","1"]]),event(T-1000,"update",asks=[["99","1"]]),event(T+1000,"update",bids=[["100","3"]])],
                [event(T-1000,"snapshot",bids=[["100","1"]],asks=[["101","1"]]),event(T-2000,"update",bids=[["100","3"]]),event(T+1000,"update",bids=[["100","4"]])],
            ]
            for i,rows in enumerate(variants):
                a=archive_file(p/f"bad{i}.tar.gz",rows)
                with self.assertRaises(ValueError):
                    replay_tar_gz(a,T)

    def test_embedded_wrong_instrument_rejected_not_blindly_trusted(self):
        with tempfile.TemporaryDirectory() as td:
            good=quote_events()
            for row in good:
                row["instId"]="BTC-USDT-SWAP"
            f=archive_file(Path(td)/"wrong-market.tar.gz",good)
            with self.assertRaises(ValueError):
                replay_tar_gz(f,T,expected_symbol="ETH-USDT-SWAP")
            same=replay_tar_gz(f,T,expected_symbol="BTC-USDT-SWAP")
            self.assertTrue(same["archive_instrument_present_and_matching"])

    def test_without_sequence_still_provisional(self):
        with tempfile.TemporaryDirectory() as td:
            rows=[event(T-1000,"snapshot",bids=[["99","2"]],asks=[["100","2"]]),
                  event(T+1000,"update",bids=[["101","3"]])]
            f=archive_file(Path(td)/"no-seq.tar.gz",rows)
            r=replay_tar_gz(f,T)
        self.assertFalse(r["sequence_integrity_checked_if_available"])

    def test_market_crossing_fees_and_symmetric_direction(self):
        long=scenario(1,Decimal("100"),Decimal("101"),Decimal("100"),Decimal("101"))
        short=scenario(-1,Decimal("100"),Decimal("101"),Decimal("100"),Decimal("101"))
        self.assertLess(Decimal(long["gross_crossing_quote_bps"]),0)
        self.assertLess(Decimal(short["gross_crossing_quote_bps"]),0)
        self.assertLess(Decimal(long["stress_seven_bps_per_side_proxy_net_bps"]),
                        Decimal(long["base_five_bps_per_side_proxy_net_bps"]))
        self.assertIsNone(long["realized_pnl"])
        with self.assertRaises(ValueError):
            scenario(0,Decimal("100"),Decimal("101"),Decimal("100"),Decimal("101"))

    def test_unauthenticated_archive_produces_numbers_not_alpha(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            file=archive_file(p/"book.tar.gz",quote_events())
            origin=meta_file(p,file)
            study=p/"study"
            study.mkdir()
            source_info={"capture_end_utc_ms":T-HORIZON_MS,
                         "source_manifest_sha256":"a"*64,
                         "source_messages_sha256":"b"*64}
            fake=(None,source_info,"signal-sha",{"hypothetical_direction":1},
                  Decimal("99.9"),Decimal("100.1"))
            with patch("algorithm_historical_l2_v16.original_signal",return_value=fake):
                result=label_provisional(study,candidate()["id"],"2026-11-01",SYMBOL,file,origin)
            self.assertEqual(result["future_archived_quote"]["best_bid"],"100")
            self.assertFalse(result["counts_toward_validated_alpha"])
            self.assertIsNone(result["hypothetical_quote_crossing_math"]["realized_pnl"])
            self.assertEqual(result["provenance_status"],"USER_SUPPLIED_UNAUTHENTICATED_OFFLINE_ARCHIVE")
            self.assertFalse(result["can_trade"])
            # Merely declaring trusted exchange origin cannot upgrade a file.
            meta=json.loads(origin.read_text());meta["exchange_origin_independently_verified"]=True
            origin.write_text(json.dumps(meta))
            with patch("algorithm_historical_l2_v16.original_signal",return_value=fake):
                with self.assertRaises(ValueError):
                    label_provisional(study,candidate()["id"],"2026-11-01",SYMBOL,file,origin)

    def test_forged_early_download_or_wrong_symbol_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            a=archive_file(p/"book.tar.gz",quote_events())
            study=p/"study";study.mkdir()
            fake=(None,{"capture_end_utc_ms":T-HORIZON_MS,
                        "source_manifest_sha256":"a"*64,
                        "source_messages_sha256":"b"*64},"sig",{"hypothetical_direction":-1},
                  Decimal("99.9"),Decimal("100.1"))
            o=meta_file(p,a,claimed=T-1000)
            with patch("algorithm_historical_l2_v16.original_signal",return_value=fake):
                with self.assertRaises(ValueError):
                    label_provisional(study,"flow-memory-flip-20261030","2026-11-01",SYMBOL,a,o)
            o=meta_file(p,a,claimed=T+1000,symbol="BTC-USDT-SWAP")
            with patch("algorithm_historical_l2_v16.original_signal",return_value=fake):
                with self.assertRaises(ValueError):
                    label_provisional(study,"flow-memory-flip-20261030","2026-11-01",SYMBOL,a,o)

    def test_missing_frozen_source_signal_cannot_be_fabricated(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            src=Path(td)/"proposal.json"
            src.write_text(json.dumps(candidate()))
            propose(study,src,now=OCT30+1000)
            with self.assertRaises(FileNotFoundError):
                original_signal(study,candidate()["id"],"2026-11-01",MEMBERS[0])


if __name__=="__main__":
    unittest.main()
