# Algorithm Discovery v11 — preregistered 60–90s quote-crossing research

**Freeze before NEW v11 data collection (2026-10-30 UTC).** Prior v6/v7/v9/v10 forecasts produced NEGATIVE single-day pilots. Never retune them or treat this fresh hypothesis as independent strategy-family discovery. No accounts, orders, PAPER, main edits, paid sources, schedules or background tasks.

## Hypothesis

Persistent signed taker flow across an eight-second source window may predict later marketable quote-crossing price continuation on a 60–90-second horizon, after fixed transaction costs. This is an exploratory, falsifiable economic-feasibility test, not a claim of novel profitable alpha. The organic OKX public book can omit RPI liquidity; trade WS has no certified gapless all-fill sequence, and the two streams have no total exchange order.

OKX published futures fee example shows a taker rate 0.05% per side for a standard level, but actual applicable account/instrument fees can differ (https://www.okx.com/en-us/help/how-to-calculate-the-contract-transaction-fee and https://www.okx.com/en-us/help/trading-fee-rules-faq). Predefine **5bps per side base** and **7bps per side stress**, not a claim of actual account fees.

## Frozen cohort and new source requirements

Capture exactly FOUR NEW 8-second public, manually invoked WebSocket source runs in order: BTC-USDT-SWAP run01, SOL-USDT-SWAP run01, BTC run02, SOL run02; unique raw source folders ws-v11-{btc|sol}-20261030-runNN. Original logical WS message SHA, complete receipt timestamps, book prevSeqId→seqId and trade uniqueness must independently audit successfully. No historic v8–v10 source accepted, and no favorable reruns. Failed attempts retained as failed.

Before requesting ANY post-observation quote for a run, produce an immutable source-signal lock, hashing exact source manifest and data, locking entry bid/ask, chosen direction or abstention, capture end time, and exit receipt deadline.

## Frozen feature formula: no after-outcome selection

Compute eight 1-second bins from verified original messages. Sum received taker buy/sell contract quantity separately over bins 0–3 and 4–7. Denote signed differences F_early and F_late. Primary event qualifies if: (1) >=5 fills each half and >=6/8 bins with book AND trade activity; (2) final bin 7 has >=1 book update and its last received quote is <=500ms older than source window end; (3) F_early and F_late are nonzero and have the SAME sign. No magnitude threshold. Direction=their sign (LONG buy-positive, SHORT sell-positive). All others abstain.

Predeclared controls for each source-valid run: flow-only sign(F_early+F_late) if nonzero; price-only sign(midquote second7 – midquote second0) if valid nonzero; 0bps cash benchmark. Compare controls on explicitly reported counts, not a combined winner chart. For qualified H1, opposite direction on the EXACT SAME rows is also a negative control. Selection uses no future price.

## Exactly one fresh public REST exit snapshot per frozen source

Public URL: GET https://www.okx.com/api/v5/market/books?instId=SYMBOL&sz=5 . Only allow request-start UTC >= capture_end+60,000ms and response-receipt UTC <= capture_end+90,000ms. Exchange book-generation timestamp must also be >=capture_end+60,000ms and <=receive+1,000ms, with age <=5,000ms. Missing, malformed, crossed or stale quotes fail closed; no prices from pre-freeze or convenient historic data. Do NOT retry an invalid response to seek a favorable outcome. Actual effective horizon varies **60–90 seconds** and must be reported exactly; it is NOT an exact 60-second fill.

Optimistic marketable quote crossing: long buys at frozen entry ask, exits at fresh exit bid, gross bps = 10000*(exit_bid/entry_ask−1). Short sells at frozen entry bid, covers at exit ask, gross bps=10000*(1−exit_ask/entry_bid). Fee bps=10000*fee_rate*(1 + exit_quote/entry_quote) for each scenario, where exit_quote/entry_quote is exit_bid/entry_ask for long and exit_ask/entry_bid for short. Net=gross−fees. No guarantee of either fill, size or liquidity; no contract lots, impact, funding settlement, latency or margin model.

For complete four-run evidence report all qualified events, all abstentions, source SHA and exit SHA, base 5bps and stress 7bps per side, flow-only and price-only controls, reverse control, and observed receipt horizons. Single-day/four-window observations are correlated, insufficient for confidence intervals/alpha. Main criterion mean base-net bps on all eligible valid events >0; if <=0 NEGATIVE. If zero qualifying, INSUFFICIENT. If any source/exit invalid, INCOMPLETE; never suppress missing runs. Even a positive descriptive result cannot authorize PAPER or real trades.

Independent advantage would require at least 30 disjoint future market-time blocks over >=10 UTC days, 100+ events >=20 unique markets, genuine holdout, multiple hypothesis and dependence control, and realistic exchange/contract/fill cost model. Counts alone are not proof. All work manual, bounded and research-only.
