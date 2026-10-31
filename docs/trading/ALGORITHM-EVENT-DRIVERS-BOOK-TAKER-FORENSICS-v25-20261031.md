# Algorithm Discovery v25 — **executed** original orderbook updates + original OKX taker trade archives: can spoofing explain NEAR moves?

**UTC 2026-10-31. This is a genuinely EXECUTED additional forensic/engineering diagnosis via manual, read-only Python commands through connected Rakazo R on existing original source files.** All individual examples were identified after knowing v24 outcomes. It is outcome-selected **POST-HOC EXPLORATION**, not prospective predictor validation, statistical proof, accusation of exchange manipulation or identification of any trader.

This **does not assert** that the separate `scripts/trading/algorithm_event_drivers_v25.py` source-replay module was executed/tested: that previously attempted Git worktree command was blocked by tool safety. The figures below were collected by separate smaller read-only source audits against verified existing v24 book checkpoints and independently downloaded actual OKX tick-trade archives. Do not falsely claim v25 full suite passed. V24 279 tests remain the last complete reported regression count.

## 1. Original source provenance, what actually is observed

Original genuine OKX 400-level `NEAR-USDT-SWAP` aggregated L2 book archives for UTC Sept03 and Sept04 are unchanged from v24:
- Sep03 original gzip SHA256 `6af42fdb315f7249b2c6f863e30b79b5019c90020749d266c20176b96bffe2c9`, original v24 per-day scored report SHA256 `056aaca7417863f76b9445d692a82ae971f1f0f647c47f999d40173d000049e2`.
- Sep04 original gzip SHA256 `81d74d4d05adf227ff33173ad111344179b72a84c2c913c489f7d3ae5a516734`, original v24 per-day report SHA256 `d66eb33ebd6e76f9fe407ba91d2bd5a41a61f94b735018125abedac9b1fa2fe5`.

New supplementary trade-source ADDENDUM `docs/trading/ALGORITHM-EVENT-DRIVERS-TRADE-ARCHIVE-ADDENDUM-v25-20261031.md` was committed **BEFORE any new trade file was downloaded or individual trade inspected**. This is only a registered reproducible *post-result explanatory measurement*, not an independently precommitted price prediction.

The **OFFICIAL** public OKX historical market-data catalogue `GET /api/v5/public/market-data-history` `module=1` gave exact real tick trades. Note critical difference from original orderbook archives: module1 `dateAggrType=daily` uses **UTC+8** date labels, not the book archive's UTC.

- `NEAR-USDT-SWAP-trades-2026-09-03.zip`: actual original 661,470 ZIP bytes, SHA256 **`6cbc879df4aa9eb2986fb6632183eeaa640c7b1ef988cb6f4be831d94bc568ec`**; HTTP 200; official download URL `https://static.okx.com/cdn/okex/traderecords/trades/daily/20260903/NEAR-USDT-SWAP-trades-2026-09-03.zip?v=1001`. Inside original single CSV `NEAR-USDT-SWAP-trades-2026-09-03.csv`, **110,736** individual records. Actual min/max trade timestamps UTC **2026-09-02 16:00:01.973 to 2026-09-03 15:59:59.380**.
- `NEAR-USDT-SWAP-trades-2026-09-04.zip`: actual original 1,111,701 ZIP bytes, SHA256 **`295d1a3e30c8970ae041a21906eb56ac6970698809923c5881ee3c576b6d41e8`**; HTTP200; official URL `https://static.okx.com/cdn/okex/traderecords/trades/daily/20260904/NEAR-USDT-SWAP-trades-2026-09-04.zip?v=1001`. Single genuine CSV `NEAR-USDT-SWAP-trades-2026-09-04.csv`, **189,559** individual records. Timestamp UTC **2026-09-03 16:00:00.313 to 2026-09-04 15:59:08.609**.
- Genuine CSV header `instrument_name,trade_id,side,price,size,created_time,source`; contract quantities, milliseconds UTC, `side` = aggressor/taker buy/sell by official OKX API semantics. Source original file SHA checked against immutable on-host JSON HTTP receipt; source symbols and sides verified. **No duplicate trade IDs** or chronologically reversed rows in either original file (0 duplicate, 0 out of order). This confirms the files' internal consistency, NOT guaranteed market-wide gaplessness or exchange actor provenance.
- Both original trade files kept PRIVATE under `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/official-trades-v25/`, source receipts alongside. Nothing placed in live Trader or PAPER.
- **THE UTC+8 SEP05 trade archive was not requested, downloaded, or opened**, because it would overlap the v24 reserved untouched **2026-09-05 UTC** holdout. Consequently Sep04 19:15 UTC has L2 evidence but NO independent executed-taker-trade archive in this analysis. Do NOT claim its contemporaneous 91% buying or a verified 19:15 short-squeeze.

The official CSV is small enough for manual, one-off Python STDOUT analyses; the code did not use private customer/order data.

## 2. Direct original 400-level book `.data` delta audit at four explicitly selected outcomes

Actual read-only replay started from the **most recent original v24 immutable checkpoint with an exchange event timestamp strictly preceding the respective case's −300 seconds**. Checked its prior source book sizes, replayed original `snapshot/update` `.data` rows and tracked the **SAME FIXED price level** as the `t−30s` best bid/ask. A larger displayed size at that level after the signal does NOT mean the original same actor's orders persisted; old orders can be cancelled or filled and replaced.

| Event UTC | v24 60m proxy net, **historical** | Best-level displayed bid quantity t−30s → t | Bid quantity at SAME price t+10s / t+30s | Original book incremental messages in pre30s | FULL book snapshot in pre30s |
|---|---:|---|---|---:|---:|
| **Sep03 14:45**, big winning long | +228.22 bps | **31.1 → 700.3 (×22.52)** | 952.4 / 2955.7 | **779** | **0** |
| **Sep04 19:15**, big winning long | +408.72 bps | **9.6 → 185.1 (×19.28)** | 478.0 / 609.8 | **650** | **0** |
| Sep03 08:45, losing long | −41.87 bps | 67.1 → 576.0 (×8.58) | 2174.0 / 1915.8 | **417** | **0** |
| Sep04 07:30, losing long | −50.53 bps | 345.1 → 622.1 (×1.80) | 3254.7 / 3192.0 | **393** | **0** |

In ALL four examples the original L2 book **really was modified through incremental update messages**, not a fresh original full snapshot in the pre-signal 30s. The same-price bid quantity did **not collapse to near zero within 10 or 30s after these signals**. But the originally shown individual orders could have been replaced, so this only weakens a simplistic whole-best-quote one-off flash-spoof scenario, **not** spoofing/manipulation generally. The original snapshots occurring at some points during the subsequent 0–30s period require care in any further post-signal queue attribution.

Sum of original individual **absolute level quantity updates at these same tracked prices during t−30s to t** (not executed trade volumes, not directly identifiable cancels):
- Sep03 14:45 winning: tracked best bid **+6160.9** gross displayed-size increases and **−5491.7** reductions (= net+669.2), tracked best ask **+7082.1** increases and **−8029.0** reductions (= net−946.9). In same period original taker trades actually totaled **1123.3 bought vs 106.0 sold** contracts. Cannot simply equate `8029` quote reductions with executed volume; amendments, cancellation, level replacement and consumption coexist.
- Sep04 19:15 winning: tracked best bid increases **+1287.3**, reductions **−1111.8** (net+175.5), ask increases **+2553.8** and reductions **−2510.5** (net+43.3); original executed taker side **UNAVAILABLE** by holdout rule.
- Sep03 08:45 losing: tracked best bid gross increases +576.0, reductions−67.1; best ask increases+1531.5, reductions−2037.1. There was real quote replenishment/depletion in this **losing case too**.
- Sep04 07:30 losing: best bid increases+1975.7/reductions−1698.7; best ask increases+686.3/reductions−944.2. Also a losing quote-shock after similar book reconfiguration.

These are **displayed price-level changes** on a public, aggregated source. Without individual order IDs/cancel messages (not available in this source), cannot link actions to a particular market maker or assert unlawful spoofing.

## 3. Direct source-matched REAL taker buy/sell volume at original signal times

**Contract volumes, authentic original CSV.** Four frozen intervals around signal: `[-300s,-30s)`, `[-30s,0)`, `[0,30s)`, `[30s,300s)`. Side comes from official recorded `side` not best-level inferred removals. No off-book synthetic executions.

| Case | Preceding **4.5 minutes** taker buy share | **Last 30 seconds** taker buy volume / sell volume | Last 30s buy share | First 30s AFTER buy share | Next 30s–5min AFTER buy share |
|---|---:|---:|---:|---:|---:|
| **Sep03 14:45 win long** | **50.9%** | **1123.3 / 106.0** | **91.4%** | **92.4%** | **63.9%** |
| Sep03 08:45 loss long | **73.6%** | **156.3 / 82.5** | **65.5%** | **67.7%** | **47.5%** |
| Sep04 07:30 loss long | **54.4%** | **569.1 / 456.1** | **55.5%** | **55.5%** | **45.7%** |
| Sep04 19:15 win long | **NO ORIGINAL COVERED TAKERS** | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE | UNAVAILABLE |

For Sep03 14:45 62 actual trades in last30s: 34 buyer-initiated and 28 seller-initiated, but buyer-initiated **contract sizes overwhelmingly exceeded** seller-initiated size. At best price levels there were 836.0 buyer-taker contracts executed at price1.929 and287.3 at1.930, alongside79.3+26.7 seller-taker contracts, so the **TRUE trade tape is NOT simply the displayed best ask being stripped**. Exact L2/order execution clock ordering is not exchange-certified. Trade prices fell in 1.929–1.930; as-of best quote midpoint was equal at the two fixed `t−30` and `t` endpoints but need not have stayed fixed at every instant in between.

A possible microstructure explanation for the Sep03 14:45 breakout is **real buyer-initiated flow appearing while replenished passive sell liquidity absorbs the price impact, followed by persistent buyer dominance when that liquidity/price regime changes**. This is CONSISTENT with these records; it has not been causally identified and is not necessarily unlawful manipulation. A rival explanation is **liquidity reallocation or strategic cancellation together with normal aggressive trading**.

The losing Sep03 08:45 and Sep04 07:30 cases also show visible bid levels persisting and active buyer-initiated trades at/after the signal, but after the first30s through five minutes the net executed aggressor volume shifts toward sellers (buyer shares47.5% and45.7%), unlike winning Sep03 14:45 (63.9%). Note this post-signal distinction is NOT known at original signal time; it cannot be used retroactively to claim predictive success.

## 4. All 23 original v24 pressure-shock signals: avoid single-event story

Read all **23** original predeclared shock signals (11 Sep03 +12 Sep04) from exact original book replay results and attempted same-time genuine tick-trade matching. **19** signal dates/times had a complete 5-min surrounding window in the available two original UTC+8 ZIPs. **4 late Sep04** signals were excluded from the trade study, with no replacement by held-out Sep05.

Of 19 covered historical signals, one Sep03 short at 03:45 had **zero trades in the last30sec**, so the buy share is undefined. For the other 18, exactly **9** 60-minute hypothetical fee5/side signals were positive and **9** were negative. Treat the following as a strictly **post-result and non-independent descriptive sensitivity test**, not a classifier or an optimized new strategy:
- **Positive** original outcomes: unweighted mean fraction of actual pre30s taker volume ALIGNED to the predicted signal direction was **54.5%** (n=9).
- **Negative** original outcomes: corresponding aligned share **57.6%** (n=9).

Thus a single-period raw aggressor side fraction **does not distinguish winners from losers in the small audited set**; arguably its direction is even less favourable in the positive group. Not independently robust, no statistical tests justified with 2 adjacent archive market-days, no forecast/paper alpha. The striking 91.4% Sep03 winner must not be mined for a new magic threshold before studying other independent dates.

## 5. NEWS and forced-liquidation context — verify, do not invent

Official OKX tick trades and 400lv aggregated L2 do not contain the identity/intention of the party placing or cancelling an order, a market maker ID, open interest evolution, leverage liquidation flags, or timestamped outside news.

A third-party market-wide Sep03 daily liquidation account shows the **14:00–15:00 UTC hour**, including the 14:45 signal, was highly active in cross-asset short liquidations; however its aggregate figures are NOT NEAR-specific at 14:45 and are **not proof** that this particular NEAR uptick was a short squeeze or manipulated. Later reports of Sep04 NEAR rising ~11% differ on whether it was a sector-wide rally or NEAR-specific news, and at least one analyst explicitly says they cannot verify the exact cause. No synchronized NEAR maker order-lifecycle, minute-by-minute OI and liquidation original dataset was authenticated for these cases.

A statement that this was "spoofing", "a single whale", "news caused the jump" or "an engineered liquidation squeeze" would be an **unsupported causal conclusion**. A more precise, empirically grounded statement is:

**On Sep03 at14:45, a large shift in posted liquidity at stable feature-endpoint midpoint coincided with a sharp contemporaneous rise in genuine buyer-initiated executed contracts, with positive buy pressure continuing over the next five minutes. In loser contrast cases, passive-book shifts also occurred but sustained buyer-initiated flow was weaker. Other winners and losers prevent a simple one-feature trading rule. The agent/source causing these events is unknown.**

## 6. Next correct research, not retrofitted profit

A new prereg study should use authenticated same-venue multiple-source quote and trade archives to attempt:
- Quantify `orderbook displayed-depth update residual minus price-matched executions` with explicit uncertainty and source clock limits. Never equate residual automatically with cancellations or manipulative intent.
- Examine BEFORE-signal acceleration of real initiated trades (e.g., change in taker buy/sell share between `[-300,-30)` and `[-30,0)`), accompanying top5 depth, executed volume concentration vs previously available 4.5min, spread and mid response. These are HYPOTHESIS CANDIDATES, not prechosen winners. Validate with a different holdout date/source after prereg, not current hindsight.
- Check whether same UTC NEAR events correspond to BTC/ETH orderflow, independently timestamped economic news/NEAR upgrades or actual venue-linked open interest and liquidation events. Need reliable exact timestamps and venue-specific provenance. A correlation with daily news is not a minute-level causal explanation.
- For forensic proof of spoofing, need individual order-ID placement/modification/cancellation lifecycle and evidence of intent or exchange's own regulatory investigation, unavailable from public L2 and tick-trade archives.

**STATUS: POST_HOC_REAL_BOOK_AND_TAKER_FLOW_AUDIT_COMPLETED, causal_spoofing_attribution=false, signal_validated_alpha=false, can_trade=false, can_start_paper=false.** Source archives preserved; intended Sep05 UTC holdout untouched, original November v12 plan, Trader/PAPER/main and scheduled jobs unchanged. No autonomous future execution implied.
