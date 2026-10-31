# Algorithm Discovery v28 — preregistered, *exploratory* matched non-event controls

**2026-10-31 UTC. This is a frozen, deterministic analysis plan written BEFORE the v28 all-anchor cross-source joins and outcome computations. The underlying public September 3/4 2026 data have been partially seen in v23–v27, including several historical returns. Therefore this is DEVELOPMENT / OUTCOME-AWARE MECHANISM RESEARCH, NOT a new independent holdout, a prospective backtest or evidence of new original profitable alpha.**

## Source boundaries and preservation

Use only previously immutable raw original sources on the user's connected Windows Rakazo host. Do NOT download anything:
- Two original, SHA-anchored OKX NEAR-USDT-SWAP 400-level L2 daily UTC books `2026-09-03` and `2026-09-04`; original 414 target as-of quotes per day and prices from v24, including original `t−30s` and `t`, source SHA and quote coverage. Original v24 results SHA `056aaca7417863f76b9445d692a82ae971f1f0f647c47f999d40173d000049e2` / `d66eb33ebd6e76f9fe407ba91d2bd5a41a61f94b735018125abedac9b1fa2fe5`. No inference of executed trades from quote additions/deletions.
- Original module1 OKX tick trades `NEAR-USDT-SWAP-trades-2026-09-03.zip` and `2026-09-04.zip`, UTC+8 day labels; original ZIP SHA256 `6cbc879df4aa9eb2986fb6632183eeaa640c7b1ef988cb6f4be831d94bc568ec` / `295d1a3e30c8970ae041a21906eb56ac6970698809923c5881ee3c576b6d41e8`. CSV columns `instrument_name,trade_id,side,price,size,created_time,source` and side taker-initiated buy/sell. No extra archives.
- SIX original module2 1m candles from official UTC+8 Sep03 and Sep04 day labels, each 1440 complete consecutive bars for BTC-USDT-SWAP, ETH-USDT-SWAP, NEAR-USDT-SWAP, SHA/headers from v27 validated code.
- Four original source-verified hourly NEAR-USDT-SWAP OI bodies from v27. Overlap must be exactly consistent before merging, no invented fine intrahour values.
- Ten source-linked news/scheduled/retrospective items from original v26 `docs/trading/ALGORITHM-NEWS-PIT-EVENTS-v26-20261031.json`, with original first_available_utc, reliability and known-future-event classifications. This is **not a complete news feed**. Absence of a catalogued item MUST NOT be called "no news" or assume a complete news horizon.
- Original reserved Sep05 UTC HOLDOUT untouched. Never open UTC+8 Sep05 trades/candles ZIPs or new files overlapping UTC Sep05. No Trader/PAPER/live, production main, credentials, paid services, autonomous R runs or schedule changes.

## Exact time-only anchor cohort, no winner selection

Exactly **66** events, dates 2026-09-03 and 2026-09-04, each 33 anchors:
- UTC **02:00, 02:15, ..., 09:00 inclusive** (29/day).
- UTC **14:00, 14:15, 14:30, 14:45** (4/day).
No excluded anchors after seeing their returns. This deliberately includes the previously studied winning **Sep03 14:45** and losing **Sep03 08:45 / Sep04 07:30** plus all 63 other timer-selected moments including ordinary non-move observations. Sep04 19:15 omitted only because its UTC+8 Sep05 original minute/trade source would access the untouched holdout. Nothing is sampled by outcome or by signal strength. Adjacent 15min observations and overlapping 60min outcomes are **dependent**, and two consecutive days are not two independent regimes.

**All cases are evaluated**; an absent or stale original as-of quote/trade window/bar/OI is reported MISSING, never silently dropped. The file must contain exactly 66 records plus a label-free feature/quote audit and all classifications.

## Exact ex-ante features (clock windows fixed here)

At signal t, NEAR L2 original as-of `t−30s` and `t`, only book states at or BEFORE target and source bracket evidence from v24:
- displayed top bid/ask size, imbalance `I=(bid_top_qty−ask_top_qty)/(sum)`; `dI=I_t−I_tminus30s`; `mid30_bps = 10000*(mid_t/mid_tminus30s−1)`, spread bps at t. Also source quality status and quote age.
- v23 `pressure_shock_without_mid_adaptation` exactly `abs(dI)>=0.50 AND abs(mid30_bps)<=3`; report eligible and direction sign(dI) but DO NOT tune rule, call it novel, or use future outcomes as signal.
- original authentic taker-trade CSV `side=buy/sell`, `size` contracts, within `[t−300s,t−30s)` and `[t−30s,t)`, not including t or later. Zero-trade window gets unavailable buy share, zero contract rate, no division by zero. Report count, buy/sell contracts, signed imbalance fraction `(buy−sell)/(sum)`, buy share, and 30s vs 270s contract-per-second intensity ratio `(30s_volume/30)/(270s_volume/270)`. No post-signal trade leakage. No reliance on post-target interpolation/price levels.
- NEAR OI: last **two original hourly timestamps strictly before the signal hour**: hour_floor(t)−2h and hour_floor(t)−1h; report percent historical change. The availability of hourly OI at these historical timestamps was NOT independently authenticated; describe as **historical pre-event timestamp context, NOT certified live point-in-time signal input**, and do not train prospective trade from it.
- News: only curated registry items with `first_available_utc <= t`, event_time <= t (past occurrence), as well as a separate bucket of pre-announced FUTURE scheduled events. Report each item's URL and timestamp-provenance class; retrospective full-hour or later-published items never counted. Count prior **120min** known-and-occurred items as contextual description, plus prior **360min** bucket; this is only **count of 10 curated news items**, not general "news/no-news" classification, and should not be used as a strong predictive proxy.

## Frozen outcomes (NEVER in feature classification)

From authentic original minute candles, base = CLOSE of minute starting `t−60s` (the last COMPLETED bar by t), horizons **5min,15min,60min**, future close from exact minute starting `t+h−60s`; all three assets same OKX perpetual market and timestamps, with complete=1; no high/low as filled order. All 66 anchors have possible complete coverage, and must be checked not assumed. Directionless NEAR percent/bps, BTC bps, ETH bps; fixed control = `(BTC+ETH)/2`; "NEAR-specific excess" = NEAR minus this simple equal-weight control, NOT a calibrated factor beta or tradable hedge.
- Frozen **EXPLORATORY outcome classification**: `EXTREME_UP` if NEAR absolute +60min move **>= +100bps (1%)**; `EXTREME_DOWN` if <= −100bps; else `NONEXTREME`. Also `NEAR_RELATIVE_UP` if excess vs BTC/ETH >=+100bps and corresponding negative class if <=−100bps. Arbitrary research bins and dependent cases, not alpha labels for a live algo.
- All outcomes are visible for **all 66 anchors** irrespective of signal eligibility, plus full continuous outcomes (not just selected winners). Per-day and overall descriptive counts, median/mean presignal trade share, trade-rate ratio, book dI, source shock count for extremes vs nonevents. Report each outcome group's number of cases and number of distinct market days. No inferential p-values from overlapping 15m windows or a small 2-day sample, no threshold search, no selecting profitable horizon based on study.

## Falsifiable interpretation / hard constraints

If a large fraction of extreme moves lacks presignal pressure shock or news, acknowledge sensitivity weakness; if many presignal shocks precede nonextreme/losing moves, acknowledge lack of specificity. Normal market beta drives shared BTC/ETH moves, not necessarily NEAR-specific cause. OI net change is NOT liquidation, individual order identity or direction. Curated headline corpus is incomplete. Spoofing/manipulative intent cannot be established without order lifecycle data. Do NOT publish source-derived claim as original discovery or profitable trading system.

Reproducibility: immutable script in isolated v28 research branch, dedicated synthetic tests, original archive SHA audits via existing validators, one output JSON local to `alpha-research/controls-v28` with SHA and GitHub human results. Frozen v12 Nov1–12 registry untouched. All work manually user-invoked R foreground, release lease afterward.
