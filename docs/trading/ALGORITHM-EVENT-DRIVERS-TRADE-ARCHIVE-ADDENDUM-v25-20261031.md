# Algorithm Discovery v25 — supplementary original taker-trade source, post-hoc cause investigation

**UTC 2026-10-31; after preliminary L2 results, BEFORE downloading or inspecting individual historical trades.** This is explicitly POST-RESULT exploration, NOT a frozen predictive alpha test, and cannot by itself prove spoofing, manipulative intent, order attribution or causal origin.

OFFICIAL OKX read-only historical catalogue `GET /api/v5/public/market-data-history` module=1 (tick trades) returned exactly these small original files:
- `2026-09-03` in **UTC+8 calendar convention** (which spans UTC 2026-09-02 16:00 through Sep 03 16:00). Official zip `https://static.okx.com/cdn/okex/traderecords/trades/daily/20260903/NEAR-USDT-SWAP-trades-2026-09-03.zip?v=1001`, declared 0.63 MB.
- `2026-09-04` in **UTC+8 convention** (spans UTC 2026-09-03 16:00 through Sep 04 16:00). Official zip `https://static.okx.com/cdn/okex/traderecords/trades/daily/20260904/NEAR-USDT-SWAP-trades-2026-09-04.zip?v=1001`, declared 1.06 MB.

**DO NOT request the UTC+8 Sep05 trade file**; it contains Sep04 19:15 UTC but overlaps the intentionally reserved Sep05 UTC holdout. Thus the largest Sep04 19:15 win remains BOOK-ONLY, and the absence of its taker archive must be disclosed explicitly. No substitution with a live REST /market/books or /market/trades endpoint.

Frozen exact event-time comparison cases:
1. Sep03 08:45 UTC losing LONG (v24 -41.87bps/60m)
2. Sep03 14:45 UTC winning LONG (v24 +228.22bps/60m)
3. Sep04 07:30 UTC losing LONG (v24 -50.53bps/60m)
4. Sep04 19:15 UTC winning LONG (v24 +408.72bps/60m) **book-only, trade history NOT accessed**.

For each fully covered event, report records, sum contracts of buyer-initiated and seller-initiated fills, net signed contracts and buyer share separately for `[-300,-30)`, `[-30,0)`, `[0,30)`, `[30,300)` seconds relative to event. In particular, `[-30,0)` is information available BEFORE the signal; `[0,30)` and `[30,300)` are POST-SIGNAL EXPLANATION only, forbidden as pre-signal predictor. Extract true source fields and date/time conventions from the ZIP/CSV BEFORE computing any numerical claims. Verify original actual bytes, original SHA, zip member, schema, symbol and timestamps, retain precise timezone source, reject missing or ambiguous signed-taker-side field, incomplete window or inconsistent original rows. Do not assume all displayed book reductions correspond to sells, cancels or executed volume; a public L2 archive has no individual order IDs and cannot prove whether the same actor placed/cancelled the order.

Download limits 10MiB per source, max 25s single request each, one immutable source ZIP per day. Preserve original files and SHA on local Rakazo disk, never upload raw files publicly. If source missing/bad, stop UNSCORABLE; don't invent trade counts. Do not read any Sep05 market outcomes or change original Nov1–12 plan, Trader/PAPER/live, production main, paid services, private accounts or automations.

Expected interpretation: correlation of posted depth reconfiguration and executed taker flow at same market times may SUPPORT (not prove) genuine pressure. Lack of matching taker volume may instead support passive repricing, quote stuffing/cancellation, other book changes, venue time aggregation or data gaps; it DOES NOT establish illegal spoofing/motive. Independently identifying a manipulator requires actor-linked original order lifecycle/cancellation records, regulatory evidence or venue cooperation.
