# r3 — independent frozen OKX validation (12 November 2026)

Four exact original r3 candidates, registered in the research branch **before** the one-time promotion. Search 2023-10-01 to 2025-02-28; validation **2025-03-01 through 2026-01-31**. Protected holdout **2026-02-01 through 2026-10-28 was not opened**. Cost gate 10 bp per side.

| Original candidate | Verdict | Sharpe at 10bp/side | Sharpe at 0bp | DSR | Positive folds | IC mean | Max drawdown |
|---|---|---:|---:|---:|---:|---:|---:|
| search-r3-1 | REJECT | -0.913827 | -0.638989 | 0.007467 | 1/4 | -0.046311 | 21.71% |
| search-r3-2 | INCONCLUSIVE_UNPOWERED | 0.207590 | 0.539727 | 0.084354 | 2/4 | -0.050875 | 22.58% |
| search-r3-3 | INCONCLUSIVE_UNPOWERED | 1.142697 | 1.683467 | 0.319646 | 2/4 | -0.051737 | 10.68% |
| search-r3-4 | INCONCLUSIVE_UNPOWERED | 0.900121 | 1.200304 | 0.239487 | 2/4 | 0.001708 | 36.53% |

**Result:** 0 PASS_VALIDATION; r3-1 REJECT; r3-2, r3-3, r3-4 INCONCLUSIVE_UNPOWERED. Only r3-3 retains the strongest *exploratory* independent Sharpe (1.1427), but has 2/4 positive folds, IC < 0, DSR 0.3196 and 95% block-bootstrap interval of daily mean crossing zero. It is NOT validated for trading. r3-4 has a much larger modeled max drawdown (36.53%).

All 4: 336 daily periods, 10 trials counted in gate, annual Sharpe null selection benchmark 1.6417054964183428. The J13 order-free procedure is required for an actual multi-rule PASS only; no PASS occurred, so no order-free qualification or holdout was performed.

## Immutable evidence
- Candidate file SHA-256: a8586399d5bb6b5211c69f2dd9ed66c771415482d07373349368b7cb3c1a3e00
- Daily frozen panel: 7aef07bd222a429d7b39d56cd0273ed0a9c34001c4cc6e1bd5b62e1874df0cce
- Frozen config: de588938f5006ce426d5b927a6fec1189d854c410ca757ba242146b677e59e9e
- Bench source: 80fe24eacc8c2972e6e0cc870c9c3ef92566f51da90c96d87c7151c3a23d1e6e
- Private full output SHA-256: 680e5da73413263d0b161b43a405ddc92de592f8a950379566548cdf53fe1855
- One append-only ledger promotion: 46 to 50 rows, exact four registered rule SHAs and validation rows. No repeat promotion, no PAPER/Trader/orders/funding/holdout.
