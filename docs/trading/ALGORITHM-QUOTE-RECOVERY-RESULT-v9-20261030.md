# Algorithm Discovery v9 — PRE-REGISTERED quote-recovery prediction test: NEGATIVE small pilot

**Executed 2026-10-30 UTC. No orders, PAPER, private endpoints, background agent, trading signals or main merge.** This is one tiny **same-morning** microstructure falsification, **not** proof against all liquidity mechanisms and **not** statistically independent evidence.

## Hypothesis and advance freeze

Registered protocol **before any NEW v9 WS collection**:
`docs/trading/ALGORITHM-QUOTE-RECOVERY-PROTOCOL-v9-20261030.md` commit `8dc77249cd33fe25107934852112b78467cdfe56`.

The preexisting v8 pilot BTC/SOL 8-second data had been inspected before hypothesis design. The new study is prospectively outcome-locked only; it is **not** a blinded discovery of strategy logic.

Frozen exactly six captures in this order: BTC run01, SOL run01, BTC run02, SOL run02, BTC run03, SOL run03. Eight seconds each, on two public OKX WebSocket channels, ordinary seq-verified orderbook `books` and per-fill `trades-all`; no credentials and no private trade/account access.

For each complete second t=0..6, when **taker buy > sell** and opposite **ask-side quote-readdition count > bid-side** count, test a **DOWNWARD** next-second midquote prediction. For taker sell > buy, and **bid-side** readdition > ask-side, test an **UPWARD** next-second prediction. Ties/no complete book+trade data abstain. Use data available only at the END of feature second t and price measured only at the END of following second t+1. Do not use next-second target price in event selection.

Primary fixed metric in basis points:
`-sign(current one-second taker imbalance) * 10000 * (next_second_last_mid / current_second_last_mid - 1)`,
where `mid=(best_bid+best_ask)/2`.

Predeclared comparison: **taker continuation** on exactly those same qualifying rows is the negative of this signed measure. A zero-change prediction is reported via **mean absolute error**, a different metric that must not be ranked numerically against a directional signed return as though directly comparable. Illustrative 14bps roundtrip cost drag (7bps/side) is reported separately, not a real execution simulator or credible seconds-level fill model.

## Six NEW valid public WebSocket captures

| Source run | Start time UTC, October 30 | Raw logical WS messages | Qualified next-second events |
| --- | --- | ---: | ---: |
| BTC 01 | 05:51:32.199 | 339 | 2 |
| SOL 01 | 05:51:54.386 | 178 | 6 |
| BTC 02 | 05:52:16.591 | 234 | **0** |
| SOL 02 | 05:52:43.281 | 427 | 2 |
| BTC 03 | 05:53:07.582 | 373 | 4 |
| SOL 03 | 05:53:29.186 | 254 | 3 |
| **Total** | 05:51–05:53 UTC | **1,805** | **17** |

Each capture lasted 8 seconds after subscriptions and full snapshot; preserved a complete raw logical WS text message log, original source order per WS, local complete receipt timestamps, raw source SHA-256, and source manifest. All **6/6 passed** the existing v8 offline integrity verifier, order-book `prevSeqId→seqId` replay and eight 1-second bins; no rejected capture was silently dropped. Those timestamps are local acquisition times, not exchange-certified cross-stream global causality.

Data root on Windows R host:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`.

Raw source manifests exact SHA-256:
- `ws-v9-btc-20261030-run01/manifest.json`: `56c2e31959597ef0fd026cc52e6d5e520a95dedbc034196108624ce4b414ec1e`
- `ws-v9-sol-20261030-run01/manifest.json`: `604f036ead5e47f35986da6916f72ab2c54dc42c22a3db4ce620651f301cb2af`
- `ws-v9-btc-20261030-run02/manifest.json`: `2574b5d2fa60451c720302f61ce5f0621a0980bc3424dd95ee2a2a89cbd911c0`
- `ws-v9-sol-20261030-run02/manifest.json`: `14fc5e3020715dc46cbbc7c6454fd407a7ff31d87e16fdda24165577ff60c1c6`
- `ws-v9-btc-20261030-run03/manifest.json`: `13ea85a3ea0cc4588a5625d245c2eb7e7e254de2b36bfb02c9ce61da48545b27`
- `ws-v9-sol-20261030-run03/manifest.json`: `112d67d362bffa65039fa4fcce8222eced26cd9cc2d8152b8572b6cd7eda49cd`

## Main result and independent second arithmetic audit

The frozen reversal predictor's **average next-second midpoint signed drift** across the 17 fixed selected events was:

- **PRIMARY:** `−0.03956898373493876006112270588` **basis points**.
- **Taker continuation control on exactly the same rows:** `+0.03956898373493876006112270588` bps (algebraic opposite; NOT an independent demonstration of profitable momentum).
- **Zero-change null:** mean absolute next-second midquote error `0.3231087168244998228607149412` bps, **not directly comparable as a signed directional performance score**.
- **Illustrative 14bps roundtrip subtraction:** `−14.03956898373493876006112271` bps; this is not guaranteed executable and not a real trading backtest.

The 17 qualified events contained:
- **4 positive**, **5 negative**, and **8 exactly-zero** signed midpoint changes.
- No selection among markets, runs, seconds, best outcomes or time horizons was made after examining prices.
- **BTC run02 had zero eligible observations** and remains included explicitly rather than omitted.

An **independent decimal-based replay directly from the original v8 one-second source extractor**, not the v9 scoring module, reproduced `−0.672672723493958921039086000` total signed bps across 17 qualifying events; dividing by 17 produced precisely `−0.03956898373493876006112270588` bps. Exact agreement with the separately written v9 scorer.

Full immutable result file on Windows:
`ws-v9-queue-recovery-20261030-outcome.json`,
SHA-256 **`0da5c3d356c597871a291c4d6c7fae90d79c8a5187dfcec148fbe278f80aa250`**.
All six source attempt IDs, manifest SHA-256s, per-second decisions and next-second quote outcomes are stored there. The model flags `verdict=NEGATIVE_PILOT_NOT_VALIDATED`, `can_trade=false`, `can_start_paper=false`, `independent_alpha_validation=false`.

## Interpretation and hard limits

The hypothesis **is not supported by this fixed pilot**: its mean signed one-second next-mid drift was slightly negative, not positive. It is an extremely small magnitude with many zeros, a single day, two symbols, six eight-second windows within ~2 minutes; event-level observations are time-correlated. **No p-value, statistical edge, Sharpe, predicted daily profitability, or production decision is justified.**

Operational limitations inherited from source verification:
- Exchange book update sequence continuity was verified, but `trades-all` **does not provide a documented gapless fill sequence**, so no proof that zero fills were missed.
- A quote readdition after a previous reduction is a **price-level displayed-depth proxy**, not evidence that any named market maker replenished passive quotes after actual fills. A reduction can be cancellation, execution, replacement or movement.
- Two different WS connections have no verified matching-engine total event ordering, so observed concurrent flows do not establish passive fill absorption.
- Midquote outcome is **not a guarantee of bid/ask execution**, especially on a one-second horizon; model omits fees, slippage, queue, latency, contract size, funding, liquidation, and trades at real bid/ask.

The preliminary v6 one-hour OI+funding and v7 book/opposing last100 strategies also produced negative preregistered pilots. The cumulative evidence supports continuing to investigate *data integrity, causal event timing, and alternative mechanisms with new preregistration*, not tuning a loss-making result, announcing a secret algorithm, or enabling PAPER trades.

## Code and reproducibility

Read-only v9 scorer: `scripts/trading/algorithm_quote_recovery_score_v9.py`
Regression tests: `scripts/trading/test_algorithm_quote_recovery_score_v9.py`

For reproducibility: replay `algorithm_ws_audit_v8.py` on each of the six raw folders, derive eight bins with `algorithm_ws_buckets_v8.py`, and then run `algorithm_quote_recovery_score_v9.py --root <capture-root> --out <NEW unique file>` on the same research branch. The scorer rejects missing files and source gaps (it never treats missing prices as zero) and shows all six attempts.

**Verdict: NEGATIVE descriptive pilot, independent performance UNKNOWN, no trading permitted.**
