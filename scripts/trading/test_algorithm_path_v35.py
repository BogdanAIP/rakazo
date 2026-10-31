import math
from decimal import Decimal as D
import unittest

from algorithm_path_v35 import PathHook, accumulate, contributions, normalized


class EventPathTests(unittest.TestCase):
    def setUp(self):
        self.q = (D(100),D(10),D(102),D(10))

    def test_same_price_queue_changes(self):
        all_ofi, static, transport, dy = contributions(self.q,(D(100),D(15),D(102),D(7)))
        self.assertEqual(all_ofi,[5.0,3.0])
        self.assertEqual(static,all_ofi)
        self.assertEqual(transport,[0.0,0.0])
        self.assertEqual(dy,0)

    def test_bid_improvement_and_ask_worsening(self):
        ofi, static, transport, _ = contributions(self.q,(D(101),D(7),D(103),D(9)))
        self.assertEqual(ofi,[7.0,10.0])
        self.assertEqual(static,[0.0,0.0])
        self.assertEqual(transport,ofi)

    def test_bid_worsening_and_ask_improvement(self):
        ofi, _, _, _ = contributions(self.q,(D(99),D(7),D(101),D(9)))
        self.assertEqual(ofi,[-10.0,-9.0])

    def test_pressure_then_price_has_positive_area(self):
        middle=(D(100),D(20),D(102),D(10))
        end=(D(101),D(20),D(103),D(10))
        b={}
        accumulate(b,self.q,middle)
        accumulate(b,middle,end)
        self.assertAlmostEqual(normalized(b["path"])["phase_area"],1)
        self.assertAlmostEqual(normalized(b["path"])["event_ofi"],1)

    def test_price_then_pressure_has_negative_area(self):
        middle=(D(101),D(10),D(103),D(10))
        end=(D(101),D(20),D(103),D(10))
        b={}
        accumulate(b,self.q,middle)
        accumulate(b,middle,end)
        self.assertAlmostEqual(normalized(b["path"])["phase_area"],-1)

    def test_reversing_entire_path_flips_area(self):
        middle=(D(100),D(20),D(102),D(10))
        end=(D(101),D(20),D(103),D(10))
        forward, reverse={},{}
        for a,b in ((self.q,middle),(middle,end)):accumulate(forward,a,b)
        for a,b in ((end,middle),(middle,self.q)):accumulate(reverse,a,b)
        self.assertAlmostEqual(forward["path"]["area"],-reverse["path"]["area"])

    def test_direction_reflection_preserves_area_and_flips_ofi(self):
        points=[self.q,(D(100),D(20),D(102),D(10)),(D(101),D(20),D(103),D(10))]
        mirror=lambda q:(D(300)-q[2],q[3],D(300)-q[0],q[1])
        a,b={},{}
        for x,y in zip(points,points[1:]):
            accumulate(a,x,y)
            accumulate(b,mirror(x),mirror(y))
        self.assertEqual(normalized(a["path"])["event_ofi"],-normalized(b["path"])["event_ofi"])
        self.assertAlmostEqual(normalized(a["path"])["phase_area"],normalized(b["path"])["phase_area"])

    def test_zero_path_has_no_direction_or_area(self):
        b={}
        accumulate(b,self.q,self.q)
        self.assertTrue(all(v==0 for v in normalized(b["path"]).values()))

    def test_equal_timestamp_changes_are_coalesced(self):
        book={"bids":{D(100):D(10)},"asks":{D(102):D(10)}}
        heaps={"bids":[D(-100)],"asks":[D(102)]}
        h,b=PathHook(),{}
        h.advance(1000,book,heaps)
        h.stage(1000,"update",book,heaps,b)
        book["bids"][D(100)]=D(20)
        h.advance(1000,book,heaps)
        h.stage(1000,"update",book,heaps,b)
        book["bids"][D(100)]=D(10)
        self.assertNotIn("path",b)
        h.advance(1001,book,heaps)
        self.assertEqual(b["path"]["n"],1)
        self.assertEqual(b["path"]["ofi"],0)

    def test_snapshot_group_does_not_create_pressure(self):
        book={"bids":{D(100):D(10)},"asks":{D(102):D(10)}}
        heaps={"bids":[D(-100)],"asks":[D(102)]}
        h,b=PathHook(),{}
        h.advance(1000,book,heaps)
        h.stage(1000,"update",book,heaps,b)
        h.stage(1000,"snapshot",book,heaps,b)
        book["bids"][D(100)]=D(20)
        h.stage(1000,"update",book,heaps,b)
        h.advance(1001,book,heaps)
        self.assertNotIn("path",b)

    def test_backwards_time_rejected(self):
        h=PathHook()
        h.advance(1001,None,None)
        with self.assertRaises(ValueError):h.advance(1000,None,None)


if __name__ == "__main__":
    unittest.main()
