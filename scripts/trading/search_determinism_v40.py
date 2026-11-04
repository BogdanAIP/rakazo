"""Host-independent arithmetic for the r3/r4 search code paths (J11). Stdlib only.

Why: J9-C1 showed that one seed of the r2 search gives two different best fitness values
on two hosts (Windows UCRT versus glibc). The bench calls `math.log`, `math.tanh` and
`math.log1p`, which come from the platform C library and are not correctly rounded, so
the last bits differ; the genetic search then amplifies one ulp into another trajectory.

Two layers, both for NEW code paths only (r2 code, frozen configs and the ledger stay as
they are):

1. Deterministic elementary functions. `dlog`, `dlog1p_signed` and `dtanh` evaluate in
   `decimal` (pure software bundled with CPython, ln/exp correctly rounded by the
   General Decimal Arithmetic spec) at 34 digits and convert once to binary64. The
   result depends only on the input bits, never on the host's libm, so everything
   downstream that uses + - * / sqrt fsum (all IEEE correctly rounded) is bitwise equal
   across hosts. This removes the cause instead of rounding it away.
2. Quantized selection (J11 a/b as agreed). `quantize` rounds to fixed significant
   digits through CPython's own correctly rounded float formatting, and
   `selection_key` orders genomes by quantized fitness with the genome string as the
   tie-break. Rounding alone cannot make bits agree: a value that straddles a rounding
   boundary still flips (probability about perturbation / grid per value), which is why
   layer 1 exists and why the bitwise comparator on the rounded outputs stays.

`fsum`-based statistics replace `sum()` (whose float algorithm changed in Python 3.12).
`x * x` replaces `x ** 2`, which goes through the C library's `pow`.
"""
from __future__ import annotations

import math
from decimal import Context, Decimal

CTX = Context(prec=34)
EXACT = Context(prec=1100)  # 1 + any binary64 is exact at this precision (fractions end by 2^-1074)
SCORE_DIGITS = 12
FITNESS_DIGITS = 10
_ONE = Decimal(1)
_TWO = Decimal(2)


def _finite(x: float) -> bool:
    return x == x and x not in (math.inf, -math.inf)


def dlog(x: float) -> float:
    """Natural log of a positive finite float, independent of the host's libm."""
    if not _finite(x) or x <= 0.0:
        return math.log(x) if x == x and x > 0.0 else math.nan  # inf -> inf; <= 0 or NaN -> NaN
    return float(CTX.ln(Decimal(x)))


def dlog1p_signed(x: float) -> float:
    """copysign(log1p(|x|), x), the bench `log1p` unary operator."""
    if x != x:
        return math.nan
    if x in (math.inf, -math.inf):
        return x
    if x == 0.0:
        return x
    return math.copysign(float(CTX.ln(EXACT.add(_ONE, Decimal(abs(x))))), x)


def dtanh(x: float) -> float:
    if x != x:
        return math.nan
    if abs(x) >= 20.0:  # tanh(20) rounds to 1.0 in binary64
        return math.copysign(1.0, x)
    if abs(x) < 1e-8:  # tanh x = x - x^3/3 + ..., which rounds to x here; avoids e^2x - 1 cancellation
        return x
    e = CTX.exp(CTX.multiply(_TWO, Decimal(x)))  # tanh = (e^2x - 1) / (e^2x + 1); 34 digits absorb cancellation
    return float(CTX.divide(CTX.subtract(e, _ONE), CTX.add(e, _ONE)))


def quantize(x: float, digits: int) -> float:
    """Round to `digits` significant digits; NaN and infinities pass through, -0.0 -> 0.0."""
    if not _finite(x):
        return x
    if x == 0.0:
        return 0.0
    return float(f"{x:.{digits - 1}e}")


def quantize_series(values, digits: int = SCORE_DIGITS) -> list:
    return [quantize(v, digits) for v in values]


def selection_key(fitness: float, genome_key: str, digits: int = FITNESS_DIGITS):
    """Sort key: higher quantized fitness first, then the genome string. NaN sorts last."""
    q = quantize(fitness, digits)
    return (math.inf if q != q else -q, genome_key)


def mean(xs) -> float:
    xs = list(xs)
    return math.fsum(xs) / len(xs)


def corr(a, b, min_n: int = 10) -> float:
    """Pearson correlation on the common prefix, the r2 `_corr` contract with fsum."""
    n = min(len(a), len(b))
    if n < min_n:
        return 0.0
    a, b = a[:n], b[:n]
    ma, mb = mean(a), mean(b)
    va = math.fsum((x - ma) * (x - ma) for x in a)
    vb = math.fsum((y - mb) * (y - mb) for y in b)
    if va <= 0 or vb <= 0:
        return 0.0
    return math.fsum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def pooled_fitness(parts, complexity: int) -> float:
    """parts: [(sharpe, periods, folds)] per panel; the r2 pooled formula with fsum.
    0.5 x period-weighted Sharpe + 0.5 x worst fold - 0.1 x (complexity - 1)."""
    total = math.fsum(float(n) for _, n, _ in parts)
    sharpe = math.fsum(s * n for s, n, _ in parts) / total
    worst = min(x for _, _, folds in parts for x in folds)
    return 0.5 * sharpe + 0.5 * worst - 0.1 * (complexity - 1)
