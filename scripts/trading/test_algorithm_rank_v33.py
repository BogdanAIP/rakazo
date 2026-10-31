import copy
import unittest
from algorithm_rank_v33 import rank_actions


class RankAdmissionTests(unittest.TestCase):
    def definition(self, factor=1):
        return {"state": ["constant", 0],
                "output": ["mul", ["constant", factor], ["feature", "flow"]]}

    def rows(self):
        return [{"restoration_available": True, "features": {"flow": ((i*7)%31-15)/1000}}
                for i in range(240)]

    def test_scale_invariance_for_nonclipped_scores(self):
        a = rank_actions(self.definition(), self.rows())
        b = rank_actions(self.definition(4), self.rows())
        self.assertEqual(a,b)
        self.assertGreater(sum(bool(x) for x in a), 0)
        self.assertEqual(a[:60], [0]*60)

    def test_future_extremes_cannot_change_past_admission(self):
        rows = self.rows()
        changed = copy.deepcopy(rows)
        for row in changed[150:]:
            row["features"]["flow"] = 7
        self.assertEqual(rank_actions(self.definition(), rows)[:150],
                         rank_actions(self.definition(), changed)[:150])

    def test_zero_score_never_creates_direction(self):
        rows = self.rows()
        for row in rows:
            row["features"]["flow"] = 0
        self.assertEqual(rank_actions(self.definition(), rows), [0]*240)


if __name__ == "__main__":
    unittest.main()
