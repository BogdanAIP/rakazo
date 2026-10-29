# Algorithm Discovery v7 — preregistered book-vs-taker antagonism test

**Preregistered on 2026-10-29 UTC; BEFORE any post-freeze forward candle outcomes are retrieved.** Entire project is isolated, public read-only, no trading.

## Ground truth and source limitations

We collected 50 five-level standard (non-RPI) order books and 50 separate **100-most-recent public trade reports** via official OKX `/api/v5/market/books?instId=...&sz=5` and `/api/v5/market/trades?instId=...&limit=100` with ten public-time control pairs. Exact raw response bytes, server generation/trade timestamps, distinct complete-receipt times, and SHA-256s are preserved on the Windows research host.

The official documentation says derivatives depth and trade sizes are **contracts**, and `trade.side` is from the **taker** perspective. For reference: https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book and https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-trades .

These are **not** an atomic combined view. A recent-100 trade sample is NOT an interval complete feed. Actual 100-trade sample spans for our 50 markets range from **766 ms to 113,373 ms** (median 8,616 ms), rendering direct fixed-horizon buy/sell quantity comparisons across markets invalid. Standard 5-level book does not include full RPI liquidity or deeper queue, and cannot demonstrate absorption, replenishment, spoofing, or liquidation. Samples were collected sequentially over 254 seconds; 50 rows are one time block, not independent experiments. Our frozen market screen originated from a previous source with unretained raw responses, so historical/survivorship-free membership is unverified.

## Falsifiable PRIMARY hypothesis (no return selection)

Let `D=(sum(top5_bid_contracts)-sum(top5_ask_contracts))/(sum(...))` and `F=(sum(last100_taker_buy_contracts)-sum(last100_taker_sell_contracts))/(sum(...))`, each computed *within its own symbol*, strictly before any future outcome.

**Antagonistic condition `D*F < 0`:** presence of visible displayed depth on the side opposing recent aggressive taker flow. Freeze hypothetical direction to `sign(D)`, without choosing any minimum magnitude. Primary hypothesis: mean signed 60-minute open-to-open return net of 7bps each side is positive. We must not flip directions after seeing prices, cherry-pick only winners, add new magnitude thresholds or change to a shorter outcome window. This is a descriptive liquidity-absorption hypothesis, not a novel algorithmic-complexity breakthrough.

**All 26 opposing-sign symbols are primary**, regardless of spread, rank, future profitability, or market name. All 24 aligned-sign symbols stay explicit no-position contemporaneous controls. No parameter fitting. The exact source audit and numerical directions must be frozen by SHA-256 before any post-freeze candle requests; the number 26 and the first observations were inspected, so this is a **prospective price outcome lock**, not an independently blinded strategy-family discovery.

## Timing, affordability and fees

- A freeze is permitted only within 15 minutes of the last completed v7 raw-source capture receipt.
- Earliest hypothetical entry = first aligned UTC 15-minute bar open **strictly later than freeze UTC + five-minute write guard** and later than all source receipts. This will usually mean a delayed signal; no pretend real-time fills.
- Diagnostic exit = 15-minute future open. Primary exit = exactly +60 minutes after entry, using complete official OKX 15-minute candles only. Do not retrieve future candle outcomes before **entry+75min**, when the 60-minute exit candle has itself completed.
- Total initial-equity **hypothetical notional budget is 50%**, equally allocated among all 26 qualifying opposite-sign instruments: each weight = `Decimal('0.5')/26` of initial equity. No leverage claim, not a real futures simulator. Costs: base 7bps each executed side, stress 14bps each executed side; signed gross and net basket relative to initial equity. All 24 controls are cash abstentions, not opportunities to mine new signals.
- Fees are a predeclared proxy, **not verified fills**, and ignore funding settlement cashflows, mark/index, liquidity impact, contract lot sizing, margin and liquidation.

## Hypothesis verdict protocol

- Single 50-market time block is descriptive only. Even a positive result is NOT evidence of statistically independent advantage or justification for PAPER deployment. Always report the return and status, including negative outcomes.
- Before a plausible general edge claim: at least 30 nonoverlapping future time blocks spanning >=10 UTC calendar days, >=100 qualifying events across >=20 symbols; verify historical point-in-time market membership and data availability, untruncated time-bucket flows/WS sequencing, real contract/funding accounting, dependence-aware uncertainty and multiple-testing controls. The gates are necessary not sufficient.
- If the forecast gate lacks completed candles or authentic received-at provenance, fail closed, never invent or forward-fill.
- Do not use the earlier v6 negative pilot as the performance of v7: new mechanism requires a separate forward evaluation.

**Prohibited:** any automatic monitor/polling, browser automation, Codex/Work, API credentials, account orders, trades, PAPER enabling, paid sources, main merge. All collection via bounded user-triggered public-only R calls.
