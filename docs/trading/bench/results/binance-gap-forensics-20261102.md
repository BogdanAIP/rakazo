# Binance v40 historical gap forensics — 2 November 2026

**Research only; J6 source-repair decision pending Claude's agreement. No trading, freeze, search or holdout operation.**

## Immutable source and first build

- Historical Binance USD-M monthly 1h klines and funding: Jan 2020–Dec 2023.
- 12,171/12,171 listed original ZIPs independently passed official filename + SHA-256 and ZIP CRC checks; no missing/extra originals, 193,259,346 ZIP bytes.
- First built hourly panel (private, unchanged): 265 historical contracts, 4,350,367 rows; SHA-256 `4baa9326a588b0778d31770b700bd56c781be585c37d76b55ce8911ded68cdd9`.
- Source-aware J5 verifier correctly returned **STOP**, not PROCEED: 7,780 missing contract-hours / 4,358,147 expected within first–last spans = **0.178516%**, exceeding the preregistered **0.1%** gate.
- Eligible funding unknown: 35,048 / 3,915,997 = **0.894996%**, below the 5% gate. Input SHA and panel row counts matched.

## Root cause and independent recovery audit

The missing hours form 103 contract-specific gaps. Two large shared gaps are present across many monthly files:

- 2022-02-26 to 2022-02-28 inclusive: 48 contracts × 72 hours = **3,456 hours**.
- 2022-04-01 to 2022-04-02 inclusive: 49 contracts × 48 hours = **2,352 hours**.

Additional long contract-specific gaps include TLMUSDT (708 hours), ICPUSDT (626 hours), and BNXUSDT (638 hours).

A private exact gap inventory derived only from the original frozen-receipt hourly file requests **326** Binance official DAILY 1h ZIPs for 52 contracts. SHA-256 of the private request list: `7501d399f89c673d261e122d156f5c5b7057a9fd39772c00010a11f939634f81`.

Source acquisition results:

- **321/326** Binance daily ZIPs independently verified against provider `.CHECKSUM` and CRC; **318 complete 24-hour days and 3 partial days**.
- The remaining **5** source ZIPs return genuine HTTP 404, all for ICPUSDT. They must not be invented.
- 7,676 valid original daily hourly rows reviewed. Exactly **7,632** correspond to hours absent from the monthly panel.
- **44** observations overlap the monthly panel: all five numeric OHLC + USDT quote-volume fields matched exactly; **zero conflicting overlaps** and **zero extra observations outside the existing first–last contract spans**.
- **148 original hours remain unavailable**. The projected gap share after genuine source repair is 148/4,358,147 = **0.003396%**, well below the unchanged 0.1% J5 limit.
- Private reconciliation report SHA-256: `b1a03fc10b899402d2c6c7972faf90325e8ada927f1b580a2821c9f623353a37`.

## J6 proposal to Claude

Add an **optional, audited** Binance official DAILY 1h ZIP fallback solely for objectively missing MONTHLY 1h hours. Preserve monthly originals and precedence; require official SHA-256 + CRC, exact UTC hourly timestamps, strict numeric equality on every monthly/daily overlap, and reject any disagreement. Use a fixed, immutable manifest of the 321 verified daily source files. Do **not** interpolate, convert missing volume to zero, modify frozen OKX artifacts, weaken J5, or use the first panel that failed.

Only **after both agents approve J6**, add offline fixtures for exact-fill, conflict rejection, missing-file rejection, and no source outside existing contract span. Build a new versioned panel, then re-run the exact J5 source-aware verifier and independent bench hourly eligibility audit. The projected 0.003396% is **not** yet a certified new-panel PASS.

Full raw ZIPs, manifests and market data remain exclusively on the authorized Windows Rakazo computer, outside public GitHub.
