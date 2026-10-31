# Algorithm Discovery v35 — event-order hypothesis failed development

The fixed `queue-leads-price` candidate failed all four development panels. It produced 64 alarms with a mean quoted scenario of **−27.41 bp** after spread and the fixed hypothetical fee. Canonical OFI performed better on every panel but also remained negative after that fee. No effective algorithm is confirmed.

## What changed and what stayed fixed

The [protocol](ALGORITHM-PATH-PLAN-v35-20261031.md), [nine typed AST definitions](ALGORITHM-PATH-PROPOSALS-v35.json), reviewed replay hooks and offline tests were committed and pushed at `529b3e9a3d95d00727b4c621b978a4958a9d8233` before new path extraction. These are **development** results: the October 1/8 NEAR/SOL source outcomes were already opened in the [failed independent v34 pilot](ALGORITHM-INDEPENDENT-RESULT-v34-20261031.md).

The new primitive separates unchanged-price queue contributions from replacement of the best price. A signed path-area statistic measures their temporal ordering relative to midpoint movement. The candidate multiplies canonical signed OFI by the positive part of that normalized area. The reverse-order and order-blind controls test the proposed ordering condition. Equal-timestamp packets are coalesced; no ordering inside one exchange timestamp is invented.

The v33 past-only rank admission and all v34 decision windows, one-minute entry delay, first-boundary fifteen-minute outcome, twenty-basis-point hypothetical round-trip fee and sixteen-minute cooldown stayed fixed. No sign, rank, fee, horizon or threshold sweep was performed.

## Source integrity and search budget

All four new replays reproduced every prior minute quote, restoration bucket and inspected-row count exactly. They inspected the same **9,746,740** original L2 rows, using the prior original archive, spool and feature SHA chain. All **2,476** historical quote observations remained available. Each panel retained **436 / 467** usable decisions, totaling **1,744 / 1,868**. Snapshot/reset abstentions were unchanged.

The complete relevant offline suite passed **35 tests**, including canonical OFI price/size cases, opposite event order, path reversal, direction reflection, equal-timestamp coalescing, snapshot exclusion, time causality, rank lookahead prevention and original replay/evaluation checks. Source-feature quality checks also found finite bounded path values. No test used market outcomes as a fixture.

The current budget is nine scores; the larger sequence of prior discovery attempts remains part of the selection history. Across the scores there are 579 quoted scenarios, with substantial shared source times and outcomes. They are not 579 independent trades or evidence from 579 independent market regimes. There are only two dates and two correlated instruments.

## Every fixed result

Each panel cell is **alarm count / mean bp after observed spread and hypothetical 20 bp fee**. Pooled means weight alarms and are descriptive; changing alarm times and dependence prevent interpreting them as a paired causal effect or portfolio PnL.

| Program | NEAR Oct 1 | SOL Oct 1 | NEAR Oct 8 | SOL Oct 8 | Pooled mean bp |
| --- | ---: | ---: | ---: | ---: | ---: |
| queue-leads-price | 18 / -40.22 | 13 / -21.01 | 15 / -19.01 | 18 / -26.23 | -27.41 |
| queue-follows-price | 15 / -13.73 | 17 / -27.12 | 19 / -6.34 | 15 / -16.22 | -15.62 |
| order-blind-area | 15 / -28.79 | 13 / -22.04 | 16 / 34.01 | 18 / -20.97 | -8.90 |
| canonical-ofi | 15 / -13.93 | 17 / -11.08 | 16 / -8.78 | 17 / -10.04 | -10.90 |
| static-queue | 14 / -21.18 | 16 / -27.02 | 17 / 25.61 | 17 / -24.11 | -10.99 |
| price-transport | 12 / -46.95 | 15 / -16.37 | 17 / -38.90 | 17 / -7.43 | -26.17 |
| flow-baseline | 17 / -53.87 | 18 / -23.82 | 18 / 19.85 | 17 / -27.22 | -20.72 |
| depth-baseline | 14 / -5.69 | 14 / -12.04 | 17 / -37.63 | 16 / -17.82 | -19.23 |
| return-baseline | 17 / -12.67 | 18 / -15.89 | 16 / -67.99 | 15 / -9.57 | -26.25 |

Every panel/program had a complete quote path, and all programs produced at least twelve alarms per panel. None of the nine passed the all-panel positive-mean screen. The candidate also failed the stronger prespecified comparator screen on all four panels.

The candidate's pooled gross quoted mean **before** the fixed fee was still −7.41 bp. Three of its four panel gross means were negative; NEAR October 8 was approximately +0.99 bp before the fee. A cheaper fee assumption therefore cannot rescue most of its observed panels. The proposed event-order condition did not add the required practical value over canonical OFI in this development sample.

Under the unchanged retrospective early-detection label, the candidate warned ahead of zero of nine episodes; canonical OFI warned ahead of two. This separate label does not replace the financial endpoint.

## Mathematical antecedents and source conventions

An additional literature check during extraction confirmed that signed path area and event-order features have established antecedents. See [Chevyrev and Kormilitzin, A Primer on the Signature Method in Machine Learning](https://arxiv.org/abs/1603.03788), especially signed area, and the canonical OFI paper [Cont, Kukanov and Stoikov](https://arxiv.org/abs/1011.6402). A [2026 LOB path-signature preprint](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6635378) also shows that this broad research direction is not new; its performance claims were not independently verified here. The specific reviewed feature construction is a falsifiable research proposal, not an established mathematical or scientific invention.

The [OKX public API specification](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-trades) defines the public trade side as the taker's side and derivative quantity in contracts. This cross-check supports the inherited flow convention; it is not a trade-by-trade independent audit of original archive records. No maker identity, cancellation/execution attribution or information-arrival clock is inferred from L2 size changes.

## Secondary cost/opportunity diagnostic

The [separate diagnostic design](ALGORITHM-QUOTE-BUDGET-DIAGNOSTIC-v35-20261031.md) was written during extraction, after v34 outcomes were known, and executed only after frozen v35 completed. Its all-minute hindsight quantities cannot change this candidate or verdict.

Every panel reproduced the original 436-minute eligible universe. The table uses future direction and, in its final column, future exit timing; **it is not a strategy or a causal forecast**. Each quantity already crosses bid/ask and deducts the same twenty-basis-point fee.

| Panel | Perfect terminal direction: mean bp | Median bp | Positive terminal opportunities | Perfect direction and exit: mean bp |
| --- | ---: | ---: | ---: | ---: |
| NEAR 10-01 | 34.23 | 22.14 | 320 / 436 (73.4%) | 58.32 |
| SOL 10-01 | -2.26 | -8.99 | 135 / 436 (31.0%) | 7.42 |
| NEAR 10-08 | 58.01 | 43.08 | 348 / 436 (79.8%) | 82.02 |
| SOL 10-08 | 1.45 | -3.49 | 180 / 436 (41.3%) | 10.97 |

NEAR contained sizeable hindsight opportunities that these candidate features failed to select profitably. SOL's terminal hindsight medians were negative on both dates: correct direction alone would not pay the assumed cost on most of these minutes. This does not prove selective SOL strategies impossible or establish that NEAR is predictably profitable. The last column shows the extra optimism introduced by knowing the best future exit too. Overlapping minute labels cannot be accumulated into account returns.

Unconditional always-long terminal means across the four panels were −29.25, −23.05, −29.29 and −23.77 bp; always-short means were −14.57, −18.64, −14.45 and −17.97 bp, in the same panel order. Complete detailed records are retained. The secondary output SHA-256 is `8bb6c9215b9da4443cd1cdc0b4bbd35d18497a504d8e77087b715a21777237d0`. Constant-price/spread, future-exit spike and missing-path sanity checks passed. No fees or horizons were changed.

## Limits and continuation

These development results cannot validate a new rule independently. Historical timestamps and five-second freshness brackets do not establish trader receipt time or continuous sequence coverage. Minute observations omit intraminute crossings. Executable size, extra slippage, funding and actual account fees remain unverified. The [selective v34 news register](ALGORITHM-NEWS-CONTEXT-v34-20261031.md) remains incomplete; actual news coverage is unknown and no news-based exclusion was fitted.

The immutable primary result SHA-256 is `c2fd98fc7d153b27faa5c77510f8b56d396509bb4810b3ffd6fee8bf361366f8`. First outputs, detailed alarms, source bytes, receipts and process logs are preserved privately. The frozen run completed all five stages without errors or parameter changes.

The [v36 continuation proposal](ALGORITHM-NEXT-v36.md) changes the research target to cost-aware opportunity selection and fixed-price-band liquidity accounting, with explicit uncertainty about hidden execution. It is not a frozen algorithm or a positive result. The next worker must audit existing implementations, implement and test the complete bounded pipeline, then run it on opened development data. New independent dates stay closed until a candidate earns that test. Rank admission alone should not force research to treat quiet markets as economically equivalent to markets with larger movements.

No reserved September 5 or November 1–12 study was opened. No live/PAPER order, Trader or risk setting, account, paid source, main branch, merge or deployment was changed.
