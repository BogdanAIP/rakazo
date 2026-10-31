# Algorithm Discovery v25 — first post-hoc evidence on causes of unusually large NEAR moves

**31 October 2026. This note reports ACTUAL observations already retrieved from the user's original immutable v24 result files, NOT the unexecuted v25 follow-up source replay. Source-level, not an invented narrative. All event selection was made AFTER knowing historical outcomes and therefore CANNOT establish predictiveness or independent validation.**

Existing frozen source results (genuine official OKX 400-level NEAR-USDT-SWAP L2):
- September 3 `NEAR-2026-09-03-frozen-v23-replication-v24.json` SHA256 `056aaca7417863f76b9445d692a82ae971f1f0f647c47f999d40173d000049e2`.
- September 4 `NEAR-2026-09-04-frozen-v23-replication-v24.json` SHA256 `d66eb33ebd6e76f9fe407ba91d2bd5a41a61f94b735018125abedac9b1fa2fe5`.
- All sources and original binary files remain stored on the user's Rakazo host. These two result files contain frozen quote evidence for `t-30sec`, `t`, and the eight preset horizons. They contain displayed order-book quantities, NOT taker buy/sell executions.

## Two largest hypothetical winning 60-minute pressure-shock cases

| Field | Thu Sep 3, 2026 14:45:00 UTC | Fri Sep 4, 2026 19:15:00 UTC |
|---|---|---|
| v23 original source signal | LONG | LONG |
| Signal midquote and previous-30-second midquote | 1.9295 USDT, UNCHANGED | 2.0285 USDT, UNCHANGED |
| Bid top-level size `t−30s→t` | **31.1→700.3**, ×22.52 | **9.6→185.1**, ×19.28 |
| Ask top-level size `t−30s→t` | **1021.3→74.4**, ×0.073 | **233.2→276.5**, ×1.186 |
| Exact original pressure imbalance change `dI` | **+1.749** | **+0.723** |
| 60min source quote bid/ask | 1.976 / 1.977 | 2.114 / 2.115 |
| 60min hypothetical net proxy after assumed 5bps per side, real spread | **+228.22bps** | **+408.72bps** |
| 30min source bid/ask | 1.946 / 1.947 | 2.163 / 2.164 |
| 30min signed midquote rise | +88.11bps | **+665.52bps** |

These source prices DO NOT prove a position could be filled at the quote (no taker stream, no order execution confirmations, no slippage, actual fee or funding). A ×20 top-level size ratio does not establish 20× market buying; size can change through limit-order addition, cancel/replacement, changes in best level or snapshot handling, with unknown trader identity and intent.

The Sep 4 rally was much larger at +30min (+6.66% midquote) than +60min (+4.24%), illustrating a **non-monotonic, event-driven price response** rather than a meaningful universal one-hour holding period.

## Counterexamples exist in the original SAME v24 data

- Sep 3 **08:45 UTC**, LONG pressure shock, top bid size multiplier ×8.58 during prior 30sec, yet the 60min hypothetical net was **−41.87bps**.
- Sep 3 **17:15 UTC**, LONG, bid size multiplier ×64.79, 60min hypothetical net **+65.00bps**. Relative multipliers can become enormous when starting visible size is tiny.
- Sep 4 **16:00 UTC**, LONG, bid size ×6.60, net 60min **+144.32bps**.
- Sep 4 **07:30 UTC**, LONG, bid size ×1.80, net 60min **−50.53bps**.
- ALL 23 original pressure-shock eligible anchors of Sep 3 (11) and Sep 4 (12) were read and displayed in the on-host diagnostic. This is only two consecutive market DAYS. Different outcome-dependent selected subsets MUST NOT be called a validated signal rule.

The fixed v23 shock requires `|midquote_30sec|<=3bps`, which around NEAR ~2 USDT and tick=0.001 is strongly close to a **no-price-move condition**. This may capture ordinary short-lived limit-book reshuffling as well as true subsequent breakout pressure. The distinction must be tested on untouched data, including NONBREAKOUT events, not assumed away.

## Historical outside context, explicitly not causal evidence

Public sources subsequently checked:
- A dated hourly reconstruction says **NEAR Sep 4 19:00–20:00 UTC rose roughly $2.02→$2.17**, which overlaps the specific recorded 19:15 signal and confirms a broader rally in that hour: https://zipmex.com/blog/near-weekly-2026-09-08/
- A Sep 4 10:04 UTC CoinMarketCap AI article suggested general market risk-on plus NEAR positioning and macro as background, but not verified as the immediate 19:15 trigger: https://coinmarketcap.com/top-stories/6a9a97bb7b7655596150e719/
- Another later analysis explicitly said it could NOT verify a particular NEAR-specific cause for the Sep 4 daily ~11% advance, despite contrasting peers: https://phemex.com/blogs/near-price-prediction-september-2026
- Other community and derivatives aggregators make different claims about Sep 4 long/short liquidations and windows. Do NOT cherry-pick any to label this specific event a proven short squeeze. There is **NO reliably authenticated exact-to-minute liquidation/OI or taker-flow record in the available original v24 archive.**

**Current evidence is CONSISTENT WITH one or several causes (resting-liquidity reallocation, marketwide impulse, NEAR-specific catalyst, forced liquidations, book refresh artefact), but does not uniquely identify a cause.** More general book data alone will not establish whether a displayed bid was a true executed buyer, passive spoof/cancel or natural liquidity provision. Beware snapshot/update artifacts: prove none occurred inside the 30sec feature interval before inferring genuine gradual size accumulation.

## Additional offline v25 source replay

Prepared `scripts/trading/algorithm_event_drivers_v25.py` and `test_algorithm_event_drivers_v25.py`, plus a method document `docs/trading/ALGORITHM-EXTREME-MOVES-DIAGNOSTIC-PROTOCOL-v25-20261031.md`. These aim to restore original prior checkpoints, replay top-5 depth, quote and spread at fixed offsets −300s through +3600s, quantify displayed-order addition/removal and compare two winning cases with two losing examples. The original 5 Sep v24 holdout is explicitly EXCLUDED.

**EXECUTION STATUS: NOT RUN.** The connected tool blocked the attempted remote Windows worktree/test command with an OpenAI safety gate. This is not a failed price outcome or completed microstructure audit. Do not report full five-level liquidity, additions/cancels, snapshot timing or book churn as measured until the module has actually run and passed tests through an allowed authorized route. Original v24 research results and 279 previously completed tests are unaffected; no v25 tests were asserted to pass.

## Best new scientific questions

1. Are the 30-second top-level quantity reversals primarily genuine **limit order placements/cancellations**, or a source/full-snapshot reset? Reconstruct actual delta events and distinguish **book additions/withdrawals** from fills (the latter requires a separate taker-trade feed).
2. In the 1–15 minutes BEFORE extreme moves, did actual **taker volume imbalance and trade intensity** change, or only passive posted depth? Do NOT infer execution from book deltas.
3. Did NEAR-specific **funding, open interest, liquidations, whale transfers** or a timestamped listing/protocol/news event occur BEFORE each shock? Cross-verify reputable exchange data and original publication times.
4. Did **BTC/ETH and comparable alts** rise at the same absolute UTC times? If yes, test independent NEAR-relative residual, not mere market beta.
5. In ALL detected shocks including LOSSES, is price response systematically different under an independently PREDEFINED market volatility/liquidity regime? Test any new formula on untouched dates and holdout, not on these outcome-selected four cases.

**Verdict:** examining WHY the rare large moves happened is scientifically more promising than deleting them. Actual archived sources reveal unusually large **pre-move displayed top-level size changes at constant price** for two winners, but similar moves can fail. External cause and exploitable mechanism remain unproven. NO algorithm is cleared for PAPER or live trading. No change to original November v12 study, main or active Trader.
