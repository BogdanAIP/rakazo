"""v22 bounded manual real archive L2 spool/replay/checkpoint tests.

Synthetic fixtures, no prices from the future, no trades or live market API.
"""
from __future__ import annotations
import json
from pathlib import Path
import tempfile
import unittest

from algorithm_l2_checkpoint_v22 import (
    unpack,advance,finalize,checkpoints,SPOOL_FILE,SPOOL_RECEIPT
)
from test_algorithm_historical_l2_official_v22 import (
    create_archive,attach_receipt,sample_rows
)


class CheckpointedHistoricalL2Tests(unittest.TestCase):
    def test_immutable_two_part_replay_and_both_fee_scenarios(self):
        with tempfile.TemporaryDirectory() as td:
            create_archive(td)
            attach_receipt(td)
            u=unpack(td)
            self.assertEqual(u["status"],"HISTORICAL_ARCHIVE_UNPACKED_NO_PRICES_PARSED")
            self.assertTrue((Path(td)/SPOOL_FILE).exists())
            with self.assertRaises(FileExistsError):
                unpack(td)
            one=advance(td,max_events=2,max_seconds=3)
            self.assertEqual(one["status"],"REPLAY_IN_PROGRESS_NO_OUTCOME_CLAIM")
            self.assertEqual(one["events_read_total"],2)
            two=advance(td,max_events=2,max_seconds=3)
            self.assertEqual(two["status"],"COMPLETE_FIXED_QUOTES_READY_FOR_BOTH_DIRECTION_FEES")
            self.assertEqual(two["events_read_total"],4)
            with self.assertRaises(FileExistsError):
                # Cannot write benchmark twice even if source is unchanged.
                out=Path(td)/"result.json"
                finalize(td,out)
                finalize(td,out)
            result=json.loads((Path(td)/"result.json").read_text())
            self.assertEqual(result["historical_entry_book"]["bid"],"100")
            self.assertEqual(result["historical_entry_book"]["ask"],"101")
            self.assertEqual(result["historical_exit_book"]["bid"],"101")
            self.assertEqual(result["historical_exit_book"]["ask"],"102")
            self.assertIsNone(result["realized_pnl"])
            self.assertFalse(result["counts_toward_validated_alpha"])
            self.assertFalse(result["can_trade"])
            self.assertEqual(len(list((Path(td)/"checkpoints").glob("*.json"))),2)

    def test_mutated_spool_after_checkpoint_never_authorizes_benchmark(self):
        with tempfile.TemporaryDirectory() as td:
            create_archive(td);attach_receipt(td)
            unpack(td);advance(td,max_events=4,max_seconds=4)
            spool=Path(td)/SPOOL_FILE
            raw=spool.read_bytes()
            spool.write_bytes(b'Q'+raw[1:])
            with self.assertRaises(ValueError):
                finalize(td,Path(td)/"result.json")

    def test_tampered_checkpoint_fails_chain_validation(self):
        with tempfile.TemporaryDirectory() as td:
            create_archive(td);attach_receipt(td)
            unpack(td);advance(td,max_events=2,max_seconds=4)
            checkpoint=Path(td)/"checkpoints"/"checkpoint-000001.json"
            data=json.loads(checkpoint.read_text())
            data["state"]["events_read"]=9999
            checkpoint.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                advance(td,max_events=2,max_seconds=4)

    def test_fails_out_of_order_real_source_and_preserves_state(self):
        with tempfile.TemporaryDirectory() as td:
            events=sample_rows()
            events[1]["ts"]=str(int(events[0]["ts"])-1)
            create_archive(td,events);attach_receipt(td)
            unpack(td)
            with self.assertRaises(ValueError):
                advance(td,max_events=4,max_seconds=4)
            self.assertEqual(len(list((Path(td)/"checkpoints").glob("*.json"))),0)


if __name__=="__main__":
    unittest.main()
