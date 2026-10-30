"""V12 fixed UTC day split, hash-chain and unobserved holdout research gates."""
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_multiday_registry_v12 import (
    FIRST_DAY, EXPECTED_UNIVERSE_SHA, HEX64, make_plan,check_plan,
    initialize,study_plan,assigned,register,read_entries,make_report,
    seal_model,utc_day,receipt_fingerprint,save_exclusive,
)
from algorithm_ws_capture_v8 import save_capture
from test_algorithm_ws_audit_v8 import fixture

NOW=int(datetime(2026,10,30,12,tzinfo=timezone.utc).timestamp()*1000)
NOV01=int(datetime(2026,11,1,12,tzinfo=timezone.utc).timestamp()*1000)
NOV10=int(datetime(2026,11,10,0,tzinfo=timezone.utc).timestamp()*1000)
MEMBERS=[f"M{i:02d}-USDT-SWAP" for i in range(50)]


def setup(root):
    p=Path(root)/"study"
    universe={"members":[{"rank":i+1,"symbol":s} for i,s in enumerate(MEMBERS)]}
    with patch("algorithm_multiday_registry_v12.frozen_universe",
               return_value=(universe,EXPECTED_UNIVERSE_SHA)):
        sha=initialize(Path(root)/"dummy-universe",p,NOW)
    return p,sha


def fake_receipt(symbol,start_ms):
    return {"capture_path":f"/fake/{symbol}/{start_ms}",
            "source_manifest_sha256":"a"*64,
            "source_messages_sha256":"b"*64,
            "capture_start_utc_ms":start_ms,
            "capture_end_utc_ms":start_ms+8000,
            "dual_stream_complete_seconds":8,
            "market":symbol,
            "status":"SOURCE_VERIFIED_NO_OUTCOME",
            "future_price_label":None}


class MultidayRegistryTests(unittest.TestCase):
    def test_twelve_days_frozen_universe_and_holdout_calendar(self):
        with tempfile.TemporaryDirectory() as td:
            p,sha=setup(td)
            x,actual=study_plan(p)
            self.assertEqual(sha,actual)
            self.assertEqual(len(x["calendar"]),12)
            self.assertEqual(sum(b["split"]=="development" for b in x["calendar"]),6)
            self.assertEqual(sum(b["split"]=="validation" for b in x["calendar"]),3)
            self.assertEqual(sum(b["split"]=="holdout" for b in x["calendar"]),3)
            self.assertEqual(x["calendar"][0]["symbols"],MEMBERS[:5])
            self.assertEqual(x["calendar"][9]["symbols"],MEMBERS[45:50])
            self.assertEqual(x["calendar"][10]["symbols"],MEMBERS[:5])
            self.assertEqual(len(set(s for b in x["calendar"][:10] for s in b["symbols"])),50)
            self.assertFalse(x["can_trade"])
            with self.assertRaises(FileExistsError):
                setup(td)

    def test_modified_plan_universe_dates_or_splits_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            data=json.loads((p/"plan.json").read_text())
            data["calendar"][10]["split"]="development"
            (p/"plan.json").write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                study_plan(p)

    def test_future_registration_and_wrong_market_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            with self.assertRaises(ValueError):
                register(p,"2026-11-01",MEMBERS[0],reason="not yet",now=NOW)
            with self.assertRaises(ValueError):
                register(p,"2026-11-01",MEMBERS[10],reason="wrong rank",now=NOV01)
            self.assertEqual(len(read_entries(p)),0)

    def test_immutable_chain_and_source_verification(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            t=NOV01
            with patch("algorithm_multiday_registry_v12.receipt_fingerprint",
                       return_value=fake_receipt(MEMBERS[0],t-2000)):
                digest=register(p,"2026-11-01",MEMBERS[0],source="/fake/capture",now=t+8000)
                entries=read_entries(p,recheck_source=True)
                self.assertEqual(len(entries),1)
                self.assertEqual(entries[0]["entry_sha256"],digest)
                with self.assertRaises(FileExistsError):
                    register(p,"2026-11-01",MEMBERS[0],source="/fake/new",now=t+9000)
            missing_digest=register(p,"2026-11-01",MEMBERS[1],reason="manual source failed",now=t+9000)
            entries=read_entries(p,recheck_source=False)
            self.assertEqual(entries[1]["previous_sha256"],digest)
            self.assertEqual(entries[1]["entry_sha256"],missing_digest)
            report=make_report(p)
            self.assertEqual(report["source_verified_count"],1)
            self.assertEqual(report["explicit_failed_count"],1)
            self.assertEqual(report["source_unregistered_count"],58)
            self.assertEqual(report["future_outcome_labels_verified"],0)
            self.assertFalse(report["independent_alpha_validated"])
            self.assertEqual(report["status"],"SOURCE_ONLY_AWAITING_FUTURE_DAYS_AND_AUTHENTIC_OUTCOMES")

    def test_source_replacement_detected_by_reaudit(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            t=NOV01
            with patch("algorithm_multiday_registry_v12.receipt_fingerprint",
                       return_value=fake_receipt(MEMBERS[0],t-2000)):
                register(p,"2026-11-01",MEMBERS[0],source="/fake/capture",now=t+8000)
            with patch("algorithm_multiday_registry_v12.receipt_fingerprint",
                       return_value={**fake_receipt(MEMBERS[0],t-2000),
                                     "source_messages_sha256":"c"*64}):
                with self.assertRaises(ValueError):
                    make_report(p)

    def test_hash_chain_detects_tampered_entry_even_if_json_valid(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            register(p,"2026-11-01",MEMBERS[1],reason="no public source",now=NOV01)
            path=p/"entries"/"000001.json"
            obj=json.loads(path.read_text())
            obj["observation"]["reason"]="altered"
            path.write_text(json.dumps(obj))
            with self.assertRaises(ValueError):
                read_entries(p)

    def test_missing_not_a_zero_return_or_order(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            register(p,"2026-11-01",MEMBERS[2],reason="book channel timeout",now=NOV01)
            out=make_report(p)
            self.assertEqual(out["explicit_failed_count"],1)
            self.assertEqual(out["future_outcome_labels_verified"],0)
            self.assertFalse(out["can_trade"])
            self.assertFalse(out["can_start_paper"])

    def test_model_holdout_seal_requires_precommitted_spec_and_prior_date(self):
        with tempfile.TemporaryDirectory() as td:
            p,_=setup(td)
            model=Path(td)/"candidate.json"
            spec={"schema":"algorithm_multiday_model_spec_v12",
                  "code_git_commit":"c"*64,
                  "feature_logic":"Deterministic source-only taker-flow sign and fixed threshold, no future data.",
                  "forward_horizon_ms":300000,
                  "outcome_source":"independent verified public bid/ask receipt data",
                  "baselines":["cash","flow_only","price_only"]}
            model.write_text(json.dumps(spec))
            with self.assertRaises(ValueError):
                seal_model(p,model,NOV10)
            out=seal_model(p,model,NOV01)
            self.assertTrue(HEX64.fullmatch(out))
            self.assertTrue(make_report(p)["holdout_sealed_model"])
            with self.assertRaises(FileExistsError):
                seal_model(p,model,NOV01)

    def test_original_ws_source_receipt_replays_and_is_not_future_pnl(self):
        m,e=fixture()
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"source"
            save_capture(p,m,e)
            rec=receipt_fingerprint(p)
            self.assertEqual(rec["market"],"BTC-USDT-SWAP")
            self.assertEqual(rec["dual_stream_complete_seconds"],1)
            self.assertEqual(rec["status"],"SOURCE_VERIFIED_NO_OUTCOME")
            self.assertIsNone(rec["future_price_label"])


if __name__=="__main__":
    unittest.main()
