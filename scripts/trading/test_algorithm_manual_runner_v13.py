"""v13 finite foreground sessions: exact-day resume, proposals and fail-closed audit."""
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from algorithm_manual_runner_v13 import (
    catalog,catalog_bytes,setup,status,manual_run,verify_sessions,
    source_path,SESSION_SCHEMA,MAX_CAPTURES_PER_LAUNCH
)
from algorithm_multiday_registry_v12 import (
    EXPECTED_UNIVERSE_SHA,initialize,read_entries
)
from test_algorithm_ws_audit_v8 import fixture

OCT30=int(datetime(2026,10,30,12,tzinfo=timezone.utc).timestamp()*1000)
NOV01=int(datetime(2026,11,1,12,tzinfo=timezone.utc).timestamp()*1000)
NOV02=int(datetime(2026,11,2,12,tzinfo=timezone.utc).timestamp()*1000)
MEMBERS=["ETH-USDT-SWAP","BTC-USDT-SWAP","ZEC-USDT-SWAP",
         "SOL-USDT-SWAP","PEPE-USDT-SWAP"] + [
         f"Q{i:02d}-USDT-SWAP" for i in range(45)]


def init(root):
    study=Path(root)/"multiday-v12-20261030"
    u={"members":[{"rank":i+1,"symbol":s} for i,s in enumerate(MEMBERS)]}
    with patch("algorithm_multiday_registry_v12.frozen_universe",
               return_value=(u,EXPECTED_UNIVERSE_SHA)):
        initialize(Path(root)/"input",study,OCT30)
    return study


def fake_source_fingerprint(path):
    p=Path(path)
    sym=p.name.split("-")[-1]+"-USDT-SWAP"
    return {
        "capture_path":str(p.resolve()),
        "source_manifest_sha256":hashlib.sha256((p/"manifest.json").read_bytes()).hexdigest(),
        "source_messages_sha256":hashlib.sha256((p/"messages.jsonl").read_bytes()).hexdigest(),
        "capture_start_utc_ms":NOV01-4000,
        "capture_end_utc_ms":NOV01+4000,
        "dual_stream_complete_seconds":7,
        "market":sym,
        "status":"SOURCE_VERIFIED_NO_OUTCOME",
        "future_price_label":None,
    }


def harmless_capture(symbol):
    m,events=fixture()
    m["symbol"]=symbol
    return m,events


class ManualRunnerTests(unittest.TestCase):
    def test_proposals_are_bounded_unscored_not_an_llm(self):
        x=catalog()
        self.assertEqual(len(x["proposals"]),12)
        self.assertEqual(len({v["id"] for v in x["proposals"]}),12)
        self.assertFalse(x["is_self_training_llm"])
        self.assertFalse(x["future_price_outcomes_inspected"])
        self.assertTrue(all(v["status"]=="UNTESTED_HYPOTHESIS_PROPOSAL"
                            and v["predictive_direction"] is None
                            and not v["profitability_validated"]
                            for v in x["proposals"]))

    def test_manual_launch_before_schedule_does_not_capture(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            spy=[]
            result=manual_run(study,max_captures=5,now_fn=lambda:OCT30,
                              capture_fn=lambda s:spy.append(s))
            self.assertEqual(spy,[])
            self.assertEqual(result["source_attempt_count"],0)
            self.assertEqual(result["after"],"WAIT_FOR_NEXT_ASSIGNED_UTC_DAY")
            state=status(study,OCT30)
            self.assertEqual(state["manual_sessions_completed"],1)
            self.assertEqual(state["next_scheduled_utc_day"],"2026-11-01")
            self.assertEqual(state["candidate_proposals_not_evaluated"],12)
            self.assertEqual(state["future_price_labels_verified"],0)
            self.assertTrue(state["no_daemon"])

    def test_one_manual_launch_then_resume_next_two_members(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            calls=[]
            def capture(symbol):
                calls.append(symbol)
                return harmless_capture(symbol)
            with patch("algorithm_multiday_registry_v12.receipt_fingerprint",
                       side_effect=fake_source_fingerprint):
                result=manual_run(study,max_captures=2,now_fn=lambda:NOV01,
                                  capture_fn=capture)
                self.assertEqual(calls,MEMBERS[:2])
                self.assertEqual(result["source_attempt_count"],2)
                self.assertEqual(status(study,NOV01)["next_assigned_symbol"],MEMBERS[2])
                self.assertEqual(len(read_entries(study,recheck_source=True)),2)
                second=manual_run(study,max_captures=1,now_fn=lambda:NOV01,
                                  capture_fn=capture)
                self.assertEqual(second["source_attempt_count"],1)
                self.assertEqual(calls,MEMBERS[:3])
                self.assertEqual(status(study,NOV01)["manual_sessions_completed"],2)
                self.assertEqual(len(read_entries(study,recheck_source=True)),3)

    def test_existing_unregistered_raw_source_resumed_without_network(self):
        from algorithm_ws_capture_v8 import save_capture
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            src=source_path(study,"2026-11-01",MEMBERS[0])
            m,events=harmless_capture(MEMBERS[0])
            save_capture(src,m,events)
            with patch("algorithm_multiday_registry_v12.receipt_fingerprint",
                       side_effect=fake_source_fingerprint):
                result=manual_run(study,max_captures=1,now_fn=lambda:NOV01,
                                  capture_fn=lambda s: (_ for _ in ()).throw(
                                      AssertionError("Must not repeat network capture")))
            self.assertEqual(result["source_attempts"][0]["operation"],
                             "RESUME_EXISTING_RAW_CAPTURE")
            self.assertEqual(result["source_attempts"][0]["capture_status"],
                             "SOURCE_REPLAY_VERIFIED_NO_OUTCOME")

    def test_failed_one_time_capture_is_recorded_and_not_retried(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            called=[]
            def fail(symbol):
                called.append(symbol)
                raise ConnectionError("closed public feed")
            first=manual_run(study,max_captures=1,now_fn=lambda:NOV01,
                             capture_fn=fail)
            self.assertEqual(called,[MEMBERS[0]])
            self.assertEqual(first["source_attempts"][0]["capture_status"],
                             "SOURCE_FAILED_NOT_RETRIED")
            self.assertEqual(status(study,NOV01)["next_assigned_symbol"],MEMBERS[1])
            next_run=manual_run(study,max_captures=1,now_fn=lambda:NOV01,
                                capture_fn=fail)
            self.assertEqual(called,MEMBERS[:2])
            self.assertEqual(next_run["source_attempt_count"],1)
            self.assertEqual(status(study,NOV01)["source_records_failed"],2)
            self.assertEqual(status(study,NOV01)["future_price_labels_verified"],0)

    def test_session_hash_chain_catches_altered_local_history(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            manual_run(study,max_captures=0,now_fn=lambda:OCT30)
            manual_run(study,max_captures=0,now_fn=lambda:OCT30)
            p=study/"manual-runner-v13"/"sessions"/"000001.json"
            x=json.loads(p.read_text())
            x["session"]["before"]="TAMPERED"
            p.write_text(json.dumps(x))
            with self.assertRaises(ValueError):
                status(study,OCT30)

    def test_cannot_force_unbounded_captures(self):
        with tempfile.TemporaryDirectory() as td:
            study=init(td)
            for n in [-1,MAX_CAPTURES_PER_LAUNCH+1]:
                with self.assertRaises(ValueError):
                    manual_run(study,max_captures=n,now_fn=lambda:NOV01)
            self.assertFalse((study/"manual-runner-v13").exists())


if __name__=="__main__":
    unittest.main()
