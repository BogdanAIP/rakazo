"""Offline tests for host-independent search arithmetic (J11). Stdlib only, no network.

"Host B" below is simulated: a C library whose log differs from host A's by a few ulp,
the J9-C1 failure mode (Windows UCRT versus glibc)."""
from __future__ import annotations

import decimal
import math
import random
import unittest
from decimal import Context, Decimal

import search_determinism_v40 as det


def nudge(x: float, k: int) -> float:
    for _ in range(abs(k)):
        x = math.nextafter(x, math.inf if k > 0 else -math.inf)
    return x


def host_b_log(x: float) -> float:
    """A different libm: same function, last bits off by 0-2 ulp depending on the input."""
    k = (hash(x) % 5) - 2
    return nudge(math.log(x), k)


def ulps(a: float, b: float) -> float:
    return abs(a - b) / math.ulp(b) if b else abs(a - b)


class ElementaryFunctions(unittest.TestCase):
    def setUp(self):
        rng = random.Random(11)
        self.prices = [math.exp(rng.gauss(0, 0.08)) for _ in range(3000)] + [1e-12, 1.0, 2.0, 1e12]
        self.xs = [rng.gauss(0, 2) for _ in range(3000)] + [1e-300, -1e-300, 19.99, -19.99, 25.0]

    def test_dlog_is_the_correctly_rounded_log(self):
        ref = Context(prec=60)
        for x in self.prices:
            self.assertEqual(det.dlog(x), float(ref.ln(Decimal(x))), x)
            self.assertLessEqual(ulps(det.dlog(x), math.log(x)), 1.0)

    def test_dtanh_and_dlog1p_match_libm_to_a_few_ulp(self):
        for x in self.xs:
            self.assertLessEqual(ulps(det.dtanh(x), math.tanh(x)), 2.0, x)
            ref = math.copysign(math.log1p(abs(x)), x)
            self.assertLessEqual(ulps(det.dlog1p_signed(x), ref), 2.0, x)

    def test_special_values(self):
        self.assertTrue(math.isnan(det.dlog(0.0)) and math.isnan(det.dlog(-1.0)) and math.isnan(det.dlog(math.nan)))
        self.assertEqual(det.dlog(math.inf), math.inf)
        self.assertEqual(det.dlog(1.0), 0.0)
        self.assertEqual(det.dtanh(1e6), 1.0)
        self.assertEqual(det.dtanh(-math.inf), -1.0)
        self.assertTrue(math.isnan(det.dtanh(math.nan)) and math.isnan(det.dlog1p_signed(math.nan)))
        self.assertEqual(det.dlog1p_signed(-math.inf), -math.inf)
        self.assertEqual(math.copysign(1.0, det.dlog1p_signed(-0.0)), -1.0)

    def test_caller_decimal_context_cannot_change_results(self):
        before = [det.dlog(x) for x in self.prices[:200]] + [det.dtanh(x) for x in self.xs[:200]]
        saved = decimal.getcontext().copy()
        try:
            decimal.getcontext().prec = 5
            decimal.getcontext().rounding = decimal.ROUND_FLOOR
            after = [det.dlog(x) for x in self.prices[:200]] + [det.dtanh(x) for x in self.xs[:200]]
        finally:
            decimal.setcontext(saved)
        self.assertEqual(before, after)


class Quantization(unittest.TestCase):
    def test_quantize(self):
        self.assertEqual(det.quantize(0.11606861509128619, 10), 0.1160686151)
        self.assertEqual(det.quantize(0.11606861509128552, 10), 0.1160686151)
        self.assertEqual(det.quantize(-123456.789, 4), -123500.0)
        self.assertEqual(det.quantize(-0.0, 10), 0.0)
        self.assertEqual(math.copysign(1.0, det.quantize(-0.0, 10)), 1.0)
        self.assertTrue(math.isnan(det.quantize(math.nan, 10)))
        self.assertEqual(det.quantize(-math.inf, 10), -math.inf)
        rng = random.Random(3)
        for _ in range(2000):
            x = rng.gauss(0, 1) * 10 ** rng.randint(-8, 8)
            q = det.quantize(x, 12)
            self.assertEqual(det.quantize(q, 12), q)  # idempotent
            self.assertLessEqual(abs(q - x), 0.5e-11 * abs(x) * 10 + 1e-300)

    def test_rounding_alone_does_not_make_bits_agree(self):
        """Documents why the bitwise comparator stays: a value next to a rounding boundary
        still flips. At 12 digits a 48-ulp gap (the size seen in J9-C1) flips ~0.5%."""
        rng = random.Random(5)
        xs = [rng.uniform(0.1, 1.0) for _ in range(20_000)]
        flips = sum(det.quantize(x, det.SCORE_DIGITS) != det.quantize(nudge(x, 48), det.SCORE_DIGITS) for x in xs)
        self.assertGreater(flips, 0)
        self.assertLess(flips / len(xs), 2e-2)

    def test_selection_order_survives_ulp_noise(self):
        rng = random.Random(7)
        for _ in range(200):
            fits = [rng.gauss(0, 0.5) for _ in range(80)]
            fits += fits[:10]  # exact duplicates: equivalent genomes with one return stream
            keys = [f"g{i:03d}" for i in range(len(fits))]
            a = sorted(range(len(fits)), key=lambda i: det.selection_key(fits[i], keys[i]))
            b = sorted(range(len(fits)), key=lambda i: det.selection_key(nudge(fits[i], rng.randint(-48, 48)), keys[i]))
            self.assertEqual(a, b)

    def test_selection_key_nan_last(self):
        order = sorted([("a", math.nan), ("b", -9.0), ("c", 0.5)], key=lambda p: det.selection_key(p[1], p[0]))
        self.assertEqual([k for k, _ in order], ["c", "b", "a"])


class Statistics(unittest.TestCase):
    def test_fsum_statistics_ignore_summation_order(self):
        rng = random.Random(9)
        a = [rng.gauss(0, 1) * 10 ** rng.randint(-6, 6) for _ in range(500)]
        b = [x * 0.3 + rng.gauss(0, 1) for x in a]
        pairs = list(zip(a, b))
        rng.shuffle(pairs)
        a2, b2 = [p[0] for p in pairs], [p[1] for p in pairs]
        self.assertEqual(det.mean(a), det.mean(a2))
        self.assertEqual(det.corr(a, b), det.corr(a2, b2))
        self.assertEqual(det.corr(a[:9], b[:9]), 0.0)

    def test_pooled_fitness_matches_r2_formula(self):
        parts = [(0.8, 700, [0.4, 0.9]), (0.3, 1000, [0.03, 0.15, 0.5])]
        want = 0.5 * (0.8 * 700 + 0.3 * 1000) / 1700 + 0.5 * 0.03 - 0.1 * 2
        self.assertAlmostEqual(det.pooled_fitness(parts, 3), want, places=14)
        self.assertEqual(det.pooled_fitness(parts, 3), det.pooled_fitness(parts[::-1], 3))


# ------------------------------------------------- a toy genetic search on two "hosts"

def _toy_fitness(genome, log):
    # Blends of the same terms in a different order are mathematically equal but round
    # differently: the near-ties that let a few ulp reorder an elite.
    acc = 0.0
    for x in genome:
        acc += log(1.0 + x / 7.0) * 0.37
    return acc - 0.001 * len(set(genome))


def _toy_search(log, quantized, seed=41, population=40, generations=25, elite=8):
    rng = random.Random(seed)
    pop = [tuple(rng.randint(1, 9) for _ in range(rng.randint(2, 4))) for _ in range(population)]
    trail = []
    for _ in range(generations):
        scored = [(_toy_fitness(g, log), repr(g), g) for g in pop]
        if quantized:
            scored.sort(key=lambda x: det.selection_key(x[0], x[1]))
        else:
            scored.sort(key=lambda x: -x[0])  # the r2 rule: stable sort on raw fitness
        parents = [g for _, _, g in scored[:elite]]
        trail.append([repr(g) for g in parents])
        nxt = list(parents)
        while len(nxt) < population:
            p = list(rng.choice(parents))
            if rng.random() < 0.5 and len(p) > 1:
                rng.shuffle(p)  # reorder the blend
            else:
                p[rng.randrange(len(p))] = rng.randint(1, 9)
            nxt.append(tuple(p))
        pop = nxt
    best = max(_toy_fitness(g, log) for g in pop)
    return trail, best


class CrossHostSearch(unittest.TestCase):
    def test_raw_selection_diverges_across_hosts(self):
        """Reproduces J9-C1: same seed, libm differs by <= 2 ulp, different search."""
        a, _ = _toy_search(math.log, quantized=False)
        b, _ = _toy_search(host_b_log, quantized=False)
        self.assertNotEqual(a, b)

    def test_quantized_selection_keeps_the_trajectory(self):
        a, fa = _toy_search(math.log, quantized=True)
        b, fb = _toy_search(host_b_log, quantized=True)
        self.assertEqual(a, b)
        self.assertEqual(det.quantize(fa, det.FITNESS_DIGITS), det.quantize(fb, det.FITNESS_DIGITS))

    def test_deterministic_log_gives_bitwise_equal_results(self):
        a, fa = _toy_search(det.dlog, quantized=True)
        b, fb = _toy_search(det.dlog, quantized=True)
        self.assertEqual((a, fa), (b, fb))
        self.assertEqual(fa.hex(), fb.hex())


if __name__ == "__main__":
    unittest.main()
