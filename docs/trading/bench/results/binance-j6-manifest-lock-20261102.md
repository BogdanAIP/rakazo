# Binance J6 production source lock — before the one authorized rebuild

Created 2026-11-02 11:45:51 UTC, on the authorized private Windows Rakazo host, **before launching any J6 production rebuild**. This is a source commitment, not a successful panel audit or a trading claim.

- Original fixed request list SHA-256: `7501d399f89c673d261e122d156f5c5b7057a9fd39772c00010a11f939634f81` (326 symbol-day requests).
- **Private canonical manifest SHA-256:** `f247e96ffa14edbf8b94276c13dad36145ff418f368ef777b691996aeb6e63c0`.
- Private filename: `runs/binance-j6-manifest-20261102/binance-daily-J6-20261102.json`.
- Exactly **321 available** official DAILY source ZIPs, re-verified against their matching official filename, SHA-256 and ZIP CRC during manifest construction; **5 absent404**, all **ICPUSDT**, on **2022-09-22 through 2022-09-26**.
- The 321 archived ZIPs rechecked total **362,907 bytes**, held privately; the manifest contains source identifiers/digests only, not market data.
- Predetermined builder audit invariants: `daily_source_files=321`, `daily_filled_rows=7632`, `daily_overlap_identical=44`, and `daily_absent404=5`.
- The unchanged Binance J5 verifier gates remain internal-span missing hours ≤0.1%, eligible funding unknown ≤5%, plus SHA/row and bench checks.
- Only the single approved J6 production rebuild may use this exact manifest digest. A STOP is final pending a fresh joint decision; **no retry** and no gate relaxation.
- Baseline first panel SHA-256 `4baa9326a588b0778d31770b700bd56c781be585c37d76b55ce8911ded68cdd9` remains immutable and was J5 STOP. All original monthly ZIPs remain untouched.
- **No new J6 panel had been built when this source lock was published.** No trading, PAPER, orders, Docker, providers, or holdout.
