# Algorithm Discovery v33: rank admission, no confirmed effective algorithm

Status: NO PROGRAM PASSED THE FOUR-PANEL DEVELOPMENT SCREEN. A posthoc NEAR-specific lead requires new source dates.

[v31 result](ALGORITHM-STREAM-RESULT-v31-20261031.md), [v32 result](ALGORITHM-RESTORATION-RESULT-v32-20261031.md), [fixed v33 plan](ALGORITHM-RANK-PLAN-v33-20261031.md). Commit 431e6b8c froze admission before this run. Original cache hashes were rechecked. All nine unchanged AST scores were evaluated without a rank/threshold sweep or outcome-based exclusions.

| Program | Alarms | Early episodes / 6 | Mean quoted scenario after 20bp fees, bp |
|---|---:|---:|---:|
| depth-baseline | 67 | 0 | -17.50 |
| flow-baseline | 76 | 0 | -17.38 |
| fragile-flow-memory | 62 | 0 | -12.67 |
| fragile-flow-no-memory | 75 | 1 | -19.05 |
| price-response-baseline | 63 | 1 | -14.62 |
| restoration-flow-memory | 59 | 1 | -14.62 |
| restoration-flow-no-memory | 70 | 1 | -6.14 |
| restoration-transition-memory | 67 | 2 | -19.95 |
| restoration-transition-no-memory | 69 | 1 | -19.15 |

All programs produced alarms: scale-related nontriggering was fixed without future-value calibration. All pooled quoted diagnostics remain negative after the fixed 20bp scenario; none passed. Choosing the best of nine attempts is not independent evidence.

## Narrow development lead: restoration-flow without memory

| Instrument / date | Alarms | Mean quoted scenario after 20bp, bp |
|---|---:|---:|
| NEAR-USDT-SWAP / 2026-09-10 | 16 | 12.04 |
| NEAR-USDT-SWAP / 2026-09-17 | 17 | 3.57 |
| SOL-USDT-SWAP / 2026-09-10 | 21 | -15.39 |
| SOL-USDT-SWAP / 2026-09-17 | 16 | -22.49 |

Both NEAR panels are positive; both SOL panels are negative. This restriction was noticed AFTER outcomes and is a new hypothesis, not a revision of the failed four-panel criterion. Do not quietly exclude SOL or call NEAR effective. Consider a single frozen narrow candidate for new source dates only after provenance checks and a complete executable-pipeline freeze.

31 offline tests passed, including past-only prefix and score-scale invariance, no zero-score directions, strict prior-quote reconstruction and spread/fee handling. These validate code, not profitability. All iterations reuse two source dates and two instruments; six episodes meet the fixed definition. No statistical confirmation, scientific novelty or 50-market transfer is established.

All selected quote paths were available. Entry crosses original bid/ask after one minute and exit crosses the opposite quote. Spread is included; 20bp fees are hypothetical. Size, true fills, extra slippage, funding and receipt latency are unverified. News prediction was not tested and coverage is UNKNOWN. Original sequence IDs are absent. No account, Trader, PAPER or reserved source was changed.

Private immutable result SHA-256: `63f5f3574d5a6d4e6065a13c26e3cf83b11a9593ac1fb44e981f102af08c9c2b`. Full source/per-alarm ledgers remain outside this public repository.

Continue via [the next checkpoint](ALGORITHM-NEXT-v34.md).
