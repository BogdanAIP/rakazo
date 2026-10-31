import unittest
from decimal import Decimal as D
import hashlib
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

import algorithm_restoration_v32 as r


class RestorationTests(unittest.TestCase):
    def test_quantity_changes_count_only_previously_best_price(self):
        book = {"bids": {D(99): D(10), D(98): D(500)},
                "asks": {D(101): D(20)}}
        sides = {"bids": [(D(99), D(15)), (D(98), D(900))],
                 "asks": [(D(101), D(12))]}
        self.assertEqual(r.positive_and_negative_changes(book, (D(99), D(101)), sides),
                         [5., 0., 0., 8.])
        self.assertEqual(book["bids"][D(99)], D(10))

    def test_missing_interval_resets_state_instead_of_filling_data(self):
        definition = {"state": ["add", ["previous"], ["feature", "restoration"]],
                      "output": ["current"], "threshold": 1.5}
        rows = [{"restoration_available": True, "features": {"restoration": 1}},
                {"restoration_available": True, "features": {"restoration": 1}},
                {"restoration_available": False, "features": {"restoration": 999}},
                {"restoration_available": True, "features": {"restoration": 1}}]
        self.assertEqual(r.causal_available_actions(definition, rows), [0,1,0,0])

    def test_flat_midpoint_pays_observed_spread_and_fee(self):
        qs = {k*60000: {"status": "AVAILABLE", "bid": "99.99", "ask": "100.01"}
              for k in range(1,17)}
        a = {"t": 0, "direction": 1, "barrier_bps": 100}
        o = r.quote_outcome([], qs, a)
        self.assertAlmostEqual(o["gross_quote_bps"], -2., places=5)
        self.assertAlmostEqual(o["after_20bp_fee_bps"], -22., places=5)
        a["direction"] = -1
        self.assertAlmostEqual(r.quote_outcome([], qs, a)["after_20bp_fee_bps"], -22., places=5)

    def test_incomplete_quote_path_cannot_become_profitable(self):
        qs = {60000: {"status": "AVAILABLE", "bid": "99", "ask": "101"}}
        self.assertEqual(r.quote_outcome([], qs, {"t": 0, "direction": 1,
                                                "barrier_bps": 20})["status"],
                         "QUOTE_PATH_UNAVAILABLE")

    def test_no_activity_is_neutral_not_perfect_restoration(self):
        self.assertEqual(r.restoration_share(0,0), .5)
        self.assertEqual(r.restoration_share(10,0), 1)
        self.assertEqual(r.restoration_share(0,10), 0)

    def test_original_replay_excludes_update_exactly_at_decision(self):
        # Synthetic stream exercises actual seek/index/window logic, not real data.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            day, symbol = "synthetic", "SYNTHETIC"
            events = []
            for start, end in [(60, 9*60+16), (13*60, 15*60+1)]:
                events.append({"ts": (start-1)*60000, "action": "snapshot", "qty": 20})
                for k in range(start, end+1):
                    events.append({"ts": k*60000-1000, "action": "update", "qty": 20})
                    events.append({"ts": k*60000, "action": "update", "qty": 30})
                events.append({"ts": end*60000+1000, "action": "update", "qty": 30})
            events.sort(key=lambda x: x["ts"])
            spool = root/"original.data"
            snapshots, offset = [], 0
            with spool.open("wb") as out:
                for e in events:
                    line = (json.dumps(e)+"\n").encode()
                    if e["action"] == "snapshot":
                        snapshots.append({"ts": e["ts"], "offset": offset,
                                          "line_sha256": hashlib.sha256(line).hexdigest()})
                    out.write(line)
                    offset += len(line)
            idx = {"original_sha256": "fake-receipt", "tape_sha256": "fake-tape",
                   "spool_bytes": spool.stat().st_size, "spool_sha256": r.digest(spool),
                   "snapshot_entries": snapshots}
            (root/"l2").mkdir()
            (root/"l2"/f"{symbol}-{day}-snapshot-index-v30.json").write_text(json.dumps(idx))
            def unpack(line):
                e = json.loads(line)
                sides = {"bids": [(D(99), D(10))] if e["action"] == "snapshot" else [],
                         "asks": [(D(101), D(e["qty"]))]}
                return e["ts"], e["action"], None, None, sides, symbol
            def quote(book, heaps, asof, target, bracket):
                return {"ask_quantity": str(book["asks"][D(101)]), "asof": asof,
                        "target": target, "next": bracket}
            evidence = (None, spool, None, {"original_sha256": "fake-receipt"}, "fake-tape", [], [])
            with patch.object(r, "manifest", return_value=evidence), \
                 patch.object(r, "unpack_event", side_effect=unpack), \
                 patch.object(r, "asof_original", side_effect=quote), \
                 patch.object(r.lab.source.v29, "time_ms", return_value=0):
                result = r.extract(root, day, symbol)
                from algorithm_path_v35 import PathHook
                instrumented = r.extract(root, day, symbol, transition_hook=PathHook())
                class QuoteAudit:
                    def __init__(self):self.seen=[]
                    def observe(self,t,book,heaps,quote):
                        self.seen.append((t,str(book["asks"][D(101)])))
                audit=QuoteAudit()
                sampled = r.extract(root,day,symbol,quote_hook=audit)
            self.assertEqual(result["quotes"],sampled["quotes"])
            self.assertEqual(len(audit.seen),len(result["quotes"]))
            self.assertEqual(audit.seen[0],(60*60000,"20"))
            self.assertEqual(result["quotes"], instrumented["quotes"])
            self.assertEqual(instrumented["bins"][60*60000]["path"]["n"], 1)
            self.assertEqual(instrumented["bins"][60*60000]["path"]["ofi"], 0)
            first = result["quotes"][60*60000]
            self.assertEqual(first["ask_quantity"], "20")
            self.assertLess(first["asof"], 60*60000)
            self.assertEqual(first["next"], 60*60000)


if __name__ == "__main__":
    unittest.main()
