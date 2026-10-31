# v22 archive feasibility amendment — explicit no-prices-observed technical benchmark

**2026-10-31; AFTER examining official OKX archive CATALOGUE sizes only; BEFORE downloading or reading any archived price, book row, or computed outcome.**

The original v22 protocol freezes a technical historical example `BTC-USDT-SWAP`, **2026-09-02 UTC 12:00:00 to 12:05:00**, 400-level L2, 250 MiB hard cap, without any forecasts or alpha claims. The live official **public historical-data catalogue**, not the blocked market/books current quote endpoint, returned the real 400-level BTC file size **342.84 MB**, greater than the 250MiB cap; **BTC IS NOT DOWNLOADED OR SCORED**. The v22 BTC result is unambiguously `ARCHIVE_SIZE_OVER_CAP`.

The same official catalogue for the same date, same module=4, and predefined resource-feasibility group showed 400-level L2 file sizes DOGE 118.48 MB, XRP 136.51 MB, ETH 445.12 MB, SOL 178.94 MB, and NEAR 30.18 MB. We will perform a **separate supplementary technical-parser demonstration** on the smallest published file, **`NEAR-USDT-SWAP` 2026-09-02 400-level L2**. This selection was based **exclusively on download size and host hardware constraints, not observed historical prices or returns**. It is NOT a substitution of a winning market, not a new hypothesis, not confirmation of the original BTC benchmark and NEVER part of prospective alpha validation.

The supplementary fixed UTC pair remains **2026-09-02T12:00:00.000Z** and **2026-09-02T12:05:00.000Z**. BOTH hypothetical long and short outcomes must be reported with 5bps/side and 7bps/side stress, or both marked UNSCORABLE. Never select whichever is positive. Genuine original OKX 400lv archive link from catalogue:

`https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/20260902/NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.tar.gz`

Original file metadata returned directly by the public OKX historical catalogue (module4 instType SWAP instFamilyList NEAR-USDT dateAggrType daily, begin/end 1788307200000): filename `NEAR-USDT-SWAP-L2orderbook-400lv-2026-09-02.tar.gz`, 30.18 MB.

No price values were obtained through the catalogue. Download only this exact official HTTPS archive, cap 250MiB, one attempt, no API credentials, one immutable file + metadata hashes; do not retry incomplete download to chase a score. Note quote archive can contain a source format different from v16's guessed tar.gz NDJSON schema; inspect actual layout and fail closed rather than silently coercing. Any result purely an **historical ingestion and arithmetic benchmark**, not a forward forecast or validated trading PnL.

Active Trader, PAPER/live, main, credentials, schedules and immutable November v12 protocol remain unchanged.
