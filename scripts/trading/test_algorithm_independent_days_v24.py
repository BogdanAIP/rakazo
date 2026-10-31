"""v24 fixed unseen days and bounded real-format synthetic L2 replay integrity.

SYNTHETIC fixtures are strictly tests, NEVER reported as OKX market returns.
"""
from __future__ import annotations

from io import BytesIO
import json
import hashlib
from pathlib import Path
import tarfile
import tempfile
import unittest

from algorithm_independent_days_v24 import (
    DAYS,SCHEMA,config,config_sha,shifted_anchors,shifted_targets,
    original_paths,filename,membername,unpack,advance,finalize,checkpoints,
    day_ms
)
from algorithm_multiday_registry_v12 import canonical,sha256


def synthetic_archive(folder,day="2026-09-03"):
    root=Path(folder);root.mkdir(parents=True,exist_ok=True)
    targets=shifted_targets(day)
    records=[]
    for i,ts in enumerate(targets):
        for when,action in ((ts-100,"snapshot"),(ts+1,"update")):
            records.append({
                "instId":"NEAR-USDT-SWAP",
                "ts":str(when),
                "action":action,
                "bids":[["100","8","1"]],
                "asks":[["101","2","1"]],
            })
    data=b"".join(canonical(x)+b"\n" for x in records)
    archive,receipt=original_paths(root,day)
    with tarfile.open(archive,"w:gz") as tf:
        member=tarfile.TarInfo(membername(day));member.size=len(data)
        tf.addfile(member,BytesIO(data))
    official_url=DAYS[day]["url"]
    info={
        "schema":"algorithm_v24_official_history_receipt",
        "symbol":"NEAR-USDT-SWAP","day_utc":day,
        "catalogue_advertised_size_mb":DAYS[day]["catalogue_size_mb"],
        "original_filename":filename(day),
        "original_sha256":sha256(archive.read_bytes()),
        "original_bytes":archive.stat().st_size,
        "http_source":{"url":official_url,"status":200,"content_length":str(archive.stat().st_size)},
        "official_origin_independently_digitally_signed":False,
        "no_price_data_viewed_before_archive_download":True,
        "can_trade":False,
    }
    receipt.write_bytes(canonical(info)+b"\n")
    return archive,receipt


class IndependentDay24Tests(unittest.TestCase):
    def test_only_frozen_03_04_dates_and_no_horizon_parameter_changes(self):
        self.assertEqual(list(DAYS),["2026-09-03","2026-09-04"])
        from algorithm_temporal_response_v23 import HORIZONS,anchors,targets
        for day in DAYS:
            a=shifted_anchors(day)
            t=shifted_targets(day)
            self.assertEqual(len(a),58)
            self.assertEqual(len(t),414)
            d=day_ms(day)-day_ms("2026-09-02")
            self.assertEqual(a[0],anchors()[0]+d)
            self.assertEqual(t[-1],targets()[-1]+d)
            self.assertEqual(config(day)["horizons_seconds"],list(HORIZONS))
            self.assertEqual(config(day)["baseline_imbalance_abs_threshold"],"0.30")
            self.assertEqual(config(day)["shock_delta_imbalance_abs_threshold"],"0.50")
            self.assertEqual(config(day)["shock_max_abs_same_30s_mid_bps"],"3.0")
        with self.assertRaises(ValueError):
            shifted_targets("2026-09-05")

    def test_full_synthetic_same_formula_58_anchors_all_horizons_and_no_fill_claim(self):
        with tempfile.TemporaryDirectory() as td:
            synthetic_archive(td)
            unpack(td,"2026-09-03")
            with self.assertRaises(FileExistsError):
                unpack(td,"2026-09-03")
            step=advance(td,"2026-09-03",max_events=10000,max_seconds=8)
            self.assertEqual(step["status"],"ALL_PREDECLARED_QUOTE_TARGETS_REPLAYED")
            self.assertEqual(step["targets_completed"],414)
            out=Path(td)/"synthetic-test-only.json"
            result=finalize(td,"2026-09-03",out)
            self.assertEqual(result["targets_available"],414)
            self.assertEqual(result["eligible"]["baseline_imbalance"],58)
            self.assertEqual(result["eligible"]["pressure_shock_without_mid_adaptation"],0)
            raw=json.loads(out.read_text())
            self.assertEqual(raw["schema"],SCHEMA)
            self.assertEqual(len(raw["anchor_candidate_horizon_rows"]),58*2*8)
            self.assertFalse(raw["counts_toward_validated_alpha"])
            self.assertFalse(raw["true_prospective_signal_prediction"])
            self.assertFalse(raw["can_trade"])
            self.assertIsNone(raw["realized_pnl"])
            self.assertLess(float(result["summary"][0]["net_fee5_mean_bps"]),0)

    def test_checkpoint_mutation_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            synthetic_archive(td);unpack(td,"2026-09-03")
            advance(td,"2026-09-03",max_events=20,max_seconds=8)
            root=Path(td)/"temporal-v24"/"checkpoints"
            path=root/"checkpoint-000001.json"
            record=json.loads(path.read_text())
            record["state"]["events_read"]=99
            path.write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                checkpoints(td,"2026-09-03")

    def test_corrupted_uncompressed_source_is_rejected_on_finalization(self):
        with tempfile.TemporaryDirectory() as td:
            synthetic_archive(td);unpack(td,"2026-09-03")
            advance(td,"2026-09-03",max_events=10000,max_seconds=8)
            from algorithm_independent_days_v24 import spool_paths
            spool,_=spool_paths(td,"2026-09-03")
            raw=spool.read_bytes()
            spool.write_bytes(b'X'+raw[1:])
            with self.assertRaises(ValueError):
                finalize(td,"2026-09-03",Path(td)/"result.json")

    def test_original_checksum_corruption_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            archive,_=synthetic_archive(td)
            archive.write_bytes(archive.read_bytes()+b'WRONG')
            with self.assertRaises(ValueError):
                unpack(td,"2026-09-03")


if __name__=="__main__":
    unittest.main()
