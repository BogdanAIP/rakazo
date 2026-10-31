import copy
from datetime import datetime,timezone,timedelta
import json
from pathlib import Path
import tempfile
import unittest

import algorithm_memory_v37 as m
import algorithm_cohort_audit_v37 as a

DOC=Path(__file__).resolve().parents[2]/"docs/trading/ALGORITHM-MEMORY-PROPOSALS-v37.json"


def stamp(date):return int(datetime.fromisoformat(date).replace(tzinfo=timezone.utc).timestamp()*1000)


class DelayedMemoryTests(unittest.TestCase):
    def seeded(self,absolute=5,increment=2,count=20,require=True):
        mem=m.MaturedMemory(require)
        first=datetime(2026,7,1,tzinfo=timezone.utc)
        for i in range(count):
            t=int((first+timedelta(days=i)).timestamp()*1000)
            mem.advance(t,lambda *args:None)
            mem.schedule(t,(1,0),1,-1)
            mem.advance(t+m.MATURITY_MS,lambda *args:(absolute,increment))
        now=stamp("2026-08-01")
        mem.advance(now,lambda *args:None)
        return mem,now

    def test_resolver_is_unread_until_full_maturity(self):
        mem=m.MaturedMemory();calls=[]
        def resolve(*args):calls.append(args);return (5,2)
        mem.advance(0,resolve);mem.schedule(0,(1,0),1,0)
        self.assertEqual(mem.pending,[(m.MATURITY_MS,0,(1,0),1,0)])
        mem.advance(16*60000,resolve)
        self.assertEqual(calls,[])
        mem.advance(17*60000,resolve)
        self.assertEqual(len(calls),1)
        self.assertEqual(mem.resolved,1)

    def test_missing_outcome_is_not_a_zero_or_day_block(self):
        mem=m.MaturedMemory();mem.advance(0,lambda *x:None)
        mem.schedule(0,(1,0),1,1);mem.advance(m.MATURITY_MS,lambda *x:None)
        self.assertEqual((mem.missing,mem.resolved,len(mem.history)),(1,0,0))

    def test_nineteen_prior_days_cannot_admit(self):
        mem,t=self.seeded(count=19)
        self.assertEqual(mem.decision(t,(1,0),1),(0,"COLD_START"))

    def test_twenty_previous_days_can_admit_synthetic_data(self):
        mem,t=self.seeded()
        self.assertEqual(mem.decision(t,(1,0),1),(1,"ADMIT"))

    def test_current_day_never_supplies_twentieth_block(self):
        mem,t=self.seeded(count=19)
        mem.history[m.day(t)][(1,0)].append((100,100))
        self.assertEqual(mem.decision(t,(1,0),1),(0,"COLD_START"))

    def test_day_means_not_episode_counts_supply_blocks(self):
        mem,t=self.seeded(count=1)
        mem.history["2026-07-01"][(1,0)] += [(100,100)]*999
        self.assertEqual(mem.decision(t,(1,0),1),(0,"COLD_START"))

    def test_two_lucky_days_cannot_hide_negative_remainder(self):
        self.assertEqual(m.stable_envelope([-1]*18+[10000]*2),-1)
        self.assertIsNone(m.stable_envelope([100]*19))

    def test_negative_net_and_negative_increment_are_distinct_rejections(self):
        mem,t=self.seeded(absolute=-1,increment=5)
        self.assertEqual(mem.decision(t,(1,0),1),(0,"NO_ABSOLUTE_STABILITY"))
        mem,t=self.seeded(absolute=5,increment=-1)
        self.assertEqual(mem.decision(t,(1,0),1),(0,"NO_INCREMENTAL_STABILITY"))
        mem.require_incremental=False
        self.assertEqual(mem.decision(t,(1,0),1),(1,"ADMIT"))

    def test_no_borrowing_from_other_direction_or_capacity_state(self):
        mem,t=self.seeded()
        self.assertEqual(mem.decision(t,(-1,0),-1),(0,"COLD_START"))
        self.assertEqual(mem.decision(t,(1,1),1),(0,"COLD_START"))

    def test_observed_clock_is_required(self):
        mem=m.MaturedMemory()
        with self.assertRaises(ValueError):mem.schedule(0,(1,0),1,0)
        mem.advance(0,lambda *x:None)
        with self.assertRaises(ValueError):mem.schedule(1,(1,0),1,0)
        with self.assertRaises(ValueError):mem.decision(1,(1,0),1)
        with self.assertRaises(ValueError):mem.advance(-1,lambda *x:None)

    def test_nonfinite_label_rejected(self):
        mem=m.MaturedMemory();mem.advance(0,lambda *x:None);mem.schedule(0,(1,0),1,0)
        with self.assertRaises(ValueError):mem.advance(m.MATURITY_MS,lambda *x:(float('nan'),0))

    def test_fingerprint_detects_hidden_state_before_any_action(self):
        mem=m.MaturedMemory();mem.advance(0,lambda *x:None);mem.schedule(0,(1,0),1,0)
        before=mem.fingerprint();mem.advance(m.MATURITY_MS,lambda *x:(5,2))
        self.assertNotEqual(before,mem.fingerprint())
        self.assertEqual(mem.decision(m.MATURITY_MS,(1,0),1),(0,"COLD_START"))

    def test_cells_use_directional_capacity_and_past_price_risk(self):
        f={"buy_capacity":.5,"sell_capacity":.4,"price_capacity":.6}
        self.assertEqual(m.cell({"cell":"capacity"},f,1),(1,1))
        self.assertEqual(m.cell({"cell":"capacity"},f,-1),(-1,0))
        self.assertEqual(m.cell({"cell":"volatility"},f,-1),(-1,1))


class TypedProposalTests(unittest.TestCase):
    def mutated(self,change):
        doc=json.loads(DOC.read_bytes());change(doc)
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/"hypotheses.json";p.write_text(json.dumps(doc),encoding="utf-8")
            return m.load_definitions(p)

    def test_six_fixed_typed_programs_load(self):
        original=m.band.lab.FEATURES.copy()
        definitions,sha=m.load_definitions(DOC)
        self.assertEqual({d["id"] for d in definitions},m.IDS)
        self.assertEqual(len(sha),64)
        self.assertEqual(m.band.lab.FEATURES,original)

    def test_floor_cannot_be_lowered_or_float_encoded(self):
        for value in (2,20.0):
            with self.assertRaises(ValueError):self.mutated(lambda d:d["settings"].update(minimum_days=value))

    def test_eager_execution_mode_and_arbitrary_code_are_forbidden(self):
        for op in ("eager-payoff", "eval('arbitrary')"):
            with self.assertRaises(ValueError):self.mutated(lambda d:d["programs"][0].update(operator=op))

    def test_unknown_fields_cannot_enter_program(self):
        with self.assertRaises(ValueError):self.mutated(lambda d:d["programs"][0].update(python="run()"))

    def test_implicit_state_reference_is_rejected(self):
        with self.assertRaises(ValueError):self.mutated(lambda d:d["programs"][0].update(score=["previous"]))

    def test_duplicate_semantics_rejected(self):
        def duplicate(doc):
            other=copy.deepcopy(doc["programs"][0]);other["id"]=doc["programs"][1]["id"]
            doc["programs"][1]=other
        with self.assertRaises(ValueError):self.mutated(duplicate)


class MetadataOnlyAuditTests(unittest.TestCase):
    def manifest(self):
        first=stamp("2026-06-30T16:00:00");n=5952
        return ("fake.manifest.json",json.dumps({"closed_bars":n,"candle_interval_minutes":15,
            "first_open_ms":first,"last_open_ms":first+(n-1)*900000,
            "symbol":"SOL-USDT-SWAP","csv_sha256":"a"*64}).encode())

    def test_august_nineteenth_and_twentieth_cross_conservative_tail(self):
        z=a.audit([self.manifest()],[f"2026-08-{i:02d}" for i in range(1,21)],{"SOL-USDT-SWAP"})
        self.assertEqual(z["status"],"REJECTED_CONSERVATIVE_OVERLAP")
        self.assertEqual([x["archive_day_label"] for x in z["conflicts"]],["2026-08-19","2026-08-20"])
        self.assertEqual(z["conflicts"][0]["protected_from_utc"],"2026-08-19T06:15:00+00:00")

    def test_july_no_known_conflict_is_not_full_clearance(self):
        z=a.audit([self.manifest()],[f"2026-07-{i:02d}" for i in range(1,21)],{"SOL-USDT-SWAP"})
        self.assertEqual(z["status"],"NO_KNOWN_OVERLAP_NOT_FULLY_CLEARED")
        for k in ("payloads_opened","claim_registry_locations_fully_resolved","independent_cohort_certified"):
            self.assertFalse(z[k])

    def test_adjacent_day_labels_can_read_reserved_utc_dates(self):
        z=a.audit([],["2026-09-06","2026-11-13"],{"NEAR-USDT-SWAP"})
        self.assertEqual(len(z["conflicts"]),2)

    def test_half_open_endpoints_do_not_overlap(self):
        self.assertFalse(a.intersects((1,2),(2,3)))
        self.assertTrue(a.intersects((1,3),(2,4)))
        self.assertEqual(a.archive_span("2026-09-06"),(stamp("2026-09-05T16:00:00"),stamp("2026-09-06T16:00:00")))

    def test_inconsistent_manifest_count_fails_closed(self):
        name,raw=self.manifest();z=json.loads(raw);z["closed_bars"]+=1
        with self.assertRaises(ValueError):a.audit([(name,json.dumps(z).encode())],["2026-07-01"],{"SOL-USDT-SWAP"})


if __name__=="__main__":unittest.main()
