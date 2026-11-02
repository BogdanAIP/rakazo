# Binance J6 completed hourly panel — build and independent gate audit

**As of 2026-11-02 12:00:39 UTC (15:00:39 Europe/Moscow).** Research-only artifact on authorized private Windows Rakazo. This is a Binance **search-source** panel under agreed J4, **not an independent Binance validation verdict**. No strategy was evaluated; OKX validation/holdout remain untouched.

## Immutable input and lineage

- Original MONTHLY 1h Binance USDT-M klines + funding ZIPs, Jan 2020–Dec 2023, all **12,171** catalog-listed archives independently verified against official SHA-256, original filename, and ZIP CRC.
- Original first monthly-only Binance panel **J5 STOP** remains immutable, SHA `4baa9326a588b0778d31770b700bd56c781be585c37d76b55ce8911ded68cdd9`; missing-hour rate 7,780/4,358,147 (**0.178516% > 0.1%**).
- J6 source-lock record was published **before build**: [`binance-j6-manifest-lock-20261102.md`](binance-j6-manifest-lock-20261102.md), commit `8d495c9`.
- Exact original request-list SHA: `7501d399f89c673d261e122d156f5c5b7057a9fd39772c00010a11f939634f81`.
- **Private SHA-pinned overlay manifest** SHA-256: `f247e96ffa14edbf8b94276c13dad36145ff418f368ef777b691996aeb6e63c0`.
- Code builder SHA-256: `ea5f0caafca194ca7c309e2b7128b1c3c22b8928862e57cca554fb77d47e8702`; independently approved by Claude before the single authorized production rebuild.
- Exactly 321 verified DAILY source files, 7,632 truly missing monthly hours restored, 44 matching original overlaps, 5 explicitly absent ICPUSDT September 2022 days; all four counts matched predeclared J6 invariants **before output publication**. No interpolation, fabricated zeros, changed eligibility rule, or original-source editing.

## New versioned hourly panel

- Private filename: `panels/binance-v40-J6-hourly-20261102.csv`.
- SHA-256, **recomputed from the completed CSV bytes**: `eefdcfaa9f1f7849a9dc1869e7310dd3beb9c9807d3c27dd7732c2d7b988c170`.
- CSV bytes: **298,097,844**.
- **4,357,999 hourly rows**, **265 historical observed symbols**, Jan 1 2020 through Dec 31 2023, 35,064 unique hourly slots.
- **3,922,559** eligible rows using original point-in-time 30-earlier-day median native USDT quote volume threshold USD 5 million; eligibility mismatches **0**.
- **551,244 funding settlement events**, **0 off-clock**; minute coverage correctly reported **UNKNOWN**, not a fabricated zero.

## Unchanged J5 verifier — PASS/PROCEED

- Finished verifier exit: **0**, verdict **PROCEED**, empty reasons.
- Expected bars inside each observed contract span: **4,358,147**.
- Missing hours: **148** (**0.00339594%**, below original **0.1%** J5 gate); missing concentrated in ICPUSDT (122h), BNXUSDT (14h), TLMUSDT (12h). No off-hour rows.
- Eligible funding `NA`: **35,165 / 3,922,559 = 0.896481%**, below unchanged **5%** J5 gate.
- Verified SHA, row counts and eligible counts match finished file/audit. Minute-level source completeness is **not** certified by this hourly panel.

## Independent bench-v40.9 audit — PASS

- Audit process exit **0**, 1h bar size correctly recognized: 3,600,000 ms.
- All 35,064 aggregate hours have some market data; **0 fully empty hours**.
- **265** symbols, **4,357,999** rows and **3,922,559** eligible rows.
- Independent 30-day as-of eligibility recomputation: **0 mismatched rows; 0 mismatched symbol-days**.
- No settlements missing for every symbol (symbols without any settlement: empty list).
- **No OI data** in this Binance source panel; do not invent it or allow OI-dependent strategies without explicit data requirement checks.

## Execution integrity and next step

- Exactly **one** approved, versioned J6 rebuild; completed **2026-11-02 12:00:39 UTC**. Build, source-aware J5 verifier, and bench audit all exited **0**.
- Peak build RSS **267,915,264 bytes**, below 1 GiB. Source panel kept private; **do not upload full market data to public GitHub**.
- Approved next handoff: **Claude independently reviews this report, panel SHA and J5/bench audit** before GPT proceeds to daily aggregation and the **J4 pooled OKX+Binance round-2 SEARCH**. The Binance segment 2021–2023 is search-only and **not** a valid independent exchange holdout. Exact search-only CSV/config SHAs must be locked before any population fitness evaluation. J3 null-calibration remains **19 identical-budget shuffled searches**, and OKX validation/holdout chronology unchanged.
- No live trading, PAPER, Trader, Docker, paid provider access, or holdout run was started.
