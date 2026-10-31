# Algorithm Discovery v27 — real OHLC cross-market NEAR/BTC/ETH and NEAR OI around September 2026 shocks

**Study executed manually UTC 2026-10-31 on connected Rakazo Windows, research only. This is POST-OUTCOME analysis of four ALREADY-known v24 winners and losers, NOT an independent trading-signal test, statistical causal proof, short-squeeze diagnosis or verified profitability.**

## Preregistration and source-deviation transparency

- Original fixed research plan `docs/trading/ALGORITHM-CROSSMARKET-CAUSES-PROTOCOL-v27-20261031.md`, commit `afe2dfa94ddc793e4337d6e46a89f49feea4ae58`, BEFORE obtaining new BTC/ETH and NEAR one-minute sources or original OI. Freeze: NEAR-USDT-SWAP, BTC-USDT-SWAP, ETH-USDT-SWAP, exactly four original L2 shock cases (Sep03 08:45 loss, Sep03 14:45 win, Sep04 07:30 loss, Sep04 19:15 win), one-minute CLOSE at last completed bar ending at signal T, 5,15,30,60 minute targets. Equal-weight market comparison `(BTC_return_bps + ETH_return_bps)/2`. No fitted beta, no hindsight asset selection and NO price crossing/fills claimed.
- An initial connectivity probe retrieved but failed to persist one BTC response and one NEAR OI response; transparent source-level addendum `docs/trading/ALGORITHM-CROSSMARKET-CONNECTIVITY-PROBES-ADDENDUM-v27-20261031.md` committed BEFORE provenance reacquisition. The two retried exact frozen responses had matching raw SHA to those first logged: BTC `99fe53321a693004b40c12861ed15a87fd746c9a11a5ef91a692a1fb2cf831f1`; NEAR OI `f58dbc1c353175df97495f92dc5df779dadb08ee796d6439784028a44742b8c3`. This was one transparently documented duplicate retrieval per source, not a secret search for better prices.
- Historical public REST `GET /api/v5/market/history-candles` was repeatedly rate-limited with 429 on **new distinct registered requests**. No HTTP429 request was retried in that same source flow. Successful original 100-minute REST bodies were saved with URL and SHA. Official alternate bulk `module=2` tiny 1-minute ZIP source was predeclared as allowed and further frozen in `docs/trading/ALGORITHM-CROSSMARKET-MODULE2-FALLBACK-v27-20261031.md` **before prices from new ZIPs were opened**. Data remain real original OKX historical candles, not a substitute live ticker, external venue, synthetic data or book bid/ask.
- Module2 calendar dates use **UTC+8**, unlike L2 400lvl UTC: UTC+8 Sep03 file covers Sept02 16:00–Sep03 15:59 UTC (both Sept03 events); UTC+8 Sep04 file covers Sept03 16:00–Sept04 15:59 UTC (Sep04 07:30). All timestamps validated to 1-minute steps with full original 1440 rows/file, confirm=1, exact instrument ID and OHLC constraints. Original REST sources succeeded for FIVE same-symbol/event combinations; their 100 original minute closes each **matched the module2 source for all 500 rows** exactly. No choosing more profitable of two source feeds.
- UTC+8 **Sep05** file, which would cover Sep04 19:15, was **NOT requested/downloaded/opened**, to preserve the established Sep05 UTC research holdout even though this leaves a key price comparison unavailable. No source containing data on Sep05 UTC was accessed.

## Original OKX primary source evidence

Six original official 1-minute historical ZIPs, all HTTP200, exact paths:
`https://static.okx.com/cdn/okex/traderecords/candlesticks/daily/YYYYMMDD/<symbol>-candlesticks-YYYY-MM-DD.zip?v=1001`.
Original source ZIP SHA256:

| Day label (UTC+8) | BTC-USDT-SWAP | ETH-USDT-SWAP | NEAR-USDT-SWAP |
|---|---|---|---|
| 2026-09-03 | `4ce4e8320fdc719786430dcb85cf226f2ae3a014aafec3f277cf5fa3763e9b5f` | `f6c527070e0b13dbe5b9b5ec63a3c1879da27dae9b14c9e80a4f4fda2e2ffda2` | `bd11ddaedd4e2cff8c32a8601ad34ffa69d04f60aa732dc12d526309d6ba6bfd` |
| 2026-09-04 | `70aad5f5805c73942bc239bc155c902036e24ea6df3576aba7f55174c3c07aba` | `b502f5440e939de961dcc64fc1ec50d730612be50af22fa62459cad01628d4a1` | `7394858c34ad1973c924b3092e1d10179f85595d8e5150891a410cfd50cfef86` |

All raw sources and immutable HTTP/SHA receipts kept at:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/crossmarket-v27/module2/`.
Additional public REST 1-minute source bodies and immutable per-URL receipts at parent folder `crossmarket-v27/`; genuine historical NEAR hourly OI sources 4/4 succeeded, no OI date substituted.

**Final complete registered output**:
`crossmarket-v27/NEAR_BTC_ETH_2026-09-03_04-crossmarket-v27.json`;
SHA256 **`50a1a663ad07673c54f158db84dcc9afca1d75a4e5c1568e876c6b360a676c6d`**.
Original source URL and gzip ZIP raw SHA included per row. Outputs are NOT synthetic, though analysis of their outcome selection is necessarily post-hoc.

## What actually happened in BTC/ETH/NEAR in the SAME exact minutes

All figures are **minute candle CLOSE TO CLOSE %**, calculated from last one-minute candle completed at/before each exact signal T, not L2 midquote and NOT executable limit-order / market PnL; basis points in immutable machine result.

| Original source case, direction | Horizon | NEAR | BTC | ETH | NEAR minus equal-weight BTC/ETH |
|---|---:|---:|---:|---:|---:|
| **Sep03 08:45, losing long** | +15min | −0.213% | −0.056% | −0.095% | **−0.137%** |
| | +60min | −0.266% | −0.196% | −0.370% | **+0.017%** |
| **Sep03 14:45, winning long** | +5min | **+1.037%** | +0.750% | +0.983% | **+0.170%** |
| | +15min | +0.829% | **+0.983%** | **+1.333%** | **−0.329%** |
| | +30min | +0.933% | +1.000% | +1.205% | **−0.169%** |
| | +60min | **+2.436%** | +1.371% | +1.468% | **+1.017%** |
| **Sep04 07:30, losing long** | +15min | −0.456% | −0.106% | −0.161% | **−0.323%** |
| | +60min | **−0.355%** | +0.149% | +0.215% | **−0.537%** |
| **Sep04 19:15, winning long** | All 4 | **UNAVAILABLE** | **UNAVAILABLE** | **UNAVAILABLE** | **UNAVAILABLE** |

The +5/+15/+30 and +60 profiles matter: the Sep03 14:45 NEAR jump coincides with a substantial BTC/ETH rally; at +15 and +30min NEAR UNDERPERFORMED the simple equal-weight reference before showing significant relative outperformance by +60min. This is consistent with a combination of BROAD market stimulus and delayed idiosyncratic NEAR liquidity/positioning, but the exact driver remains unidentified. It does not prove Bybit NEAR-upgrade suspension caused the difference. The Sep03 08:45 bad long was mostly a marketwide downward move by +60min; Sep04 07:30 bad long was distinctly NEAR-specific underperformance even as BTC/ETH rose by hour end.

This confirms why an unadjusted 1-hour return cannot reliably identify a uniquely NEAR-specific book effect: part of an apparent winning/losing position can be MARKET BETA (risk-on/down) and part relative NEAR flow. A 50/50 BTC/ETH normalisation is purely descriptive, NOT a calibrated neutral portfolio/alpha.

## Genuine NEAR hourly open-interest (OI) evidence from public OKX Rubik history

Per-event original public read-only `GET /api/v5/rubik/stat/contracts/open-interest-history` with exact NEAR-USDT-SWAP, `period=1H`, timestamp window per prereg. All **4 historical source responses HTTP200, code0** and survived checksum checks. OI original unit = contracts. Values below changes between exact neighboring hour UTC sample timestamps, **NOT** a continuous 60-minute interval exactly before the signal. The official API does NOT guarantee the corresponding hourly statistic was publicly available at the same instant as its timestamp; thus not automatically usable in a source-only live signal.

| Event | Historical OI hour prior to hour of signal | Change to hour of signal | Following hour change | Scientific caveat |
|---|---|---:|---:|---|
| Sep03 **08:45 losing** | 07:00→08:00 | **−1.094%** | 08:00→09:00 **+0.222%** | Partial OI recovery even though long loses |
| Sep03 **14:45 winning** | 13:00→14:00 | **+0.509%** | 14:00→15:00 **+0.721%**, 15→16 **+2.305%** | OI growing alongside/after price rise, not solely collapsing short positions |
| Sep04 **07:30 losing** | 06:00→07:00 | **−0.409%** | 07:00→08:00 **−0.311%** | Falling OI in a weak NEAR interval |
| Sep04 **19:15 winning** | 18:00→19:00 | **+4.242%** | 19:00→20:00 **−0.708%** | Strong pre-event position expansion followed by modest net reduction; not proof of liquidation |

The Sep04 19:15 event is particularly interesting because OI expanded quickly BEFORE the time bucket of the large quote move and subsequently shrank slightly; that is consistent with position crowding followed by covering/closed contracts, but ALSO consistent with voluntary unwinds and changes in other participants. **An OI increase never specifies buyer/seller order ownership or forced liquidation, and an OI decrease by itself does not prove a short squeeze.** Compare the positive Sept03 case where OI increased further after the move, arguing against one universal large-move=collapsing OI theory.

## News context carried over, not relabeled as causes

v26 report `docs/trading/ALGORITHM-NEWS-CONTEXT-RESULT-v26-20261031.md` verified Sep03 14:00 UTC US ISM services release and 14:30 UTC Bybit NEAR deposit/withdraw suspension ahead of a planned 15:00 network upgrade. These are PRE-signal contexts and temporally compatible with the 14:45 case, but price control shows BTC and ETH also rose in the ensuing hour. No causal separation of macro vs upgrade yet.

Sep04 12:30 UTC BLS jobs surprise is 6h45 BEFORE the extreme 19:15 NEAR event; BTC initially declined. The subsequent NEAR OI swing is authentic and interesting but no exact NEAR-specific 19:15 headline was authenticated. Retrospective 19:00–20:00 news and liquidations are hindsight, not original available signals.

## Liquidation history availability — verified limitation

Official OKX **public liquidation-orders** WS documentation explicitly says it only reports RECENT liquidation orders and **does not represent the total number of OKX liquidations**. The historical module1/2/4 archives used here consist of trades, 1m candles and orderbook, **not independently authenticated full minute-by-minute NEAR OKX liquidation notices or participant-order lifecycles**. The Rubik `open-interest-history` snapshots are NOT liquidation records. Source context: https://www.okx.com/docs-v5/en/. Therefore original per-minute forced closures of NEAR-USDT-SWAP Sep03/04 remain **UNVERIFIED**, and a short-squeeze or spoofing allegation is unsupported.

## Software and test evidence

New source code:
- `scripts/trading/algorithm_crossmarket_v27.py`: frozen case/symbol allowlist, original historical 1m REST bytes and NEAR 1h OI with immutable SHA receipts, strict complete prior-minute source quotes, holdout guard, no synthetic missing-data imputation.
- `scripts/trading/algorithm_module2_archive_v27.py`: exact six allowlisted official daily UTC+8 module2 ZIP downloads and original hash provenance.
- `scripts/trading/algorithm_module2_crossmarket_v27.py`: validates 1440 original 1m CSV records per file and exact source hours, matches 500 overlapping original REST candle rows, reports 3 market control comparisons and 4 original OI cases including withheld Sept04 evening price row.

Dedicated new unit tests: `test_algorithm_crossmarket_v27.py` 6 PASS and `test_algorithm_module2_crossmarket_v27.py` 4 PASS. Executed entire disjoint regression groups: **271/271** `test_algorithm*.py` and **26/26** `test_[!a]*.py`, total **297/297 executed tests PASSED**. The separately blocked/unchecked `test_alpha*.py` group was NOT attempted and is NOT counted.

No change to original Nov v12 immutable plan SHA `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`, main branch, active Trader/PAPER/live, accounts, credentials, paid services or schedules.

## Causal decision / recommended next hypothesis

1. **Do not call either extreme move exclusively a spoof, news rally or forced short-cover.** Sep03 price rose with BTC/ETH, then NEAR gained ~1.02 percentage point extra by +60min. Sep04 big winner shows unusually large OI build and subsequent limited unwind, but historical synchronized BTC/ETH 19:15 close data and official liquidation time series are unavailable under held-out source protection.
2. The emerging mechanism to test is whether **pre-event OI expansion plus genuine taker-flow acceleration + liquidity absorption at fixed/muted quote price** distinguishes idiosyncratic NEAR breakouts from marketwide risk-on rallies. This is a RESEARCH HYPOTHESIS developed after seeing outcomes; thresholds and event-time windows must be frozen before accessing a NEW independent archive-day cohort. The present four cases are too few to infer a predictive rule.
3. Need wider **separately sampled nonevent controls**, independently timestamped NEAR-specific announcements, cross-market BTC/ETH at all signal times, and genuinely authenticated liquidation/actor-level records to attribute cause. Earlier v24 Sep05 remains untouched.

**STATUS: REPRODUCIBLE_HISTORICAL_CROSSMARKET_AND_OI_ANALYSIS_DONE; historical causality unproved; validated alpha=false; can_trade=false; can_start_paper=false.**
