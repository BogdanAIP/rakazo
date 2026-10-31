# Algorithm Discovery v22 — genuine official OKX L2 archive bench, fixed non-predictive historical example

**Created 2026-10-31. Research only, without trading/PAPER or modifying the Nov1–12 frozen study.**

## Fixed historical example, prior to observing prices

This is a **parser / quote-crossing ARITHMETIC BENCHMARK**, **NOT** a new trading hypothesis or prospective prediction, and its result must NEVER be included among v12 validation, v14/v15 alpha claims, or market forecasts.

Benchmark: `BTC-USDT-SWAP`, archive UTC day **2026-09-02**, start/exercise exchange-clock time `2026-09-02T12:00:00.000Z`, exit `2026-09-02T12:05:00.000Z` (exact 300,000 ms). Both LONG and SHORT hypothetical directions are evaluated on the SAME fixed quotes to show the quote-crossing arithmetic, explicitly NOT to select whichever one was profitable. Preliminary fee scenarios: 5 basis points per side and stress 7 bps per side, marked *illustrative*, not user/account actual fees. No leverage or funding/slippage/fills assumed.

Primary source: official OKX Historical Market Data / L2 orderbook **400-level daily (module 4)**, via the official public historical-data page or documented **historical archive catalogue**. DO NOT use a real-time REST `/api/v5/market/books` query (previous v11 blocked), an alternate live-quote provider, synthetic or cached futures quotes masquerading as history. File download ONLY when an explicit official published archive URL is returned; never infer URL from filename. The official GET historical archive catalogue is separate from blocked live quote and it returns file metadata, not live market prices. This is read-only, public; no API key, accounts, orders or paid data.

Budget: inspect catalogue metadata first. Hard **250 MiB** local download cap, **30-second** transfer timeout and no automatic retries; if file exceeds cap, is unavailable or inaccessible, stop **UNAVAILABLE_ARCHIVE** and honestly report. Do NOT silently substitute another market/date. Preserve archive original file bytes, SHA-256 and exact published URL/response metadata once; never overwrite. Do not upload source files publicly if terms/privacy issue.

## Parser rules

- Inspect the true member filename, archive format, original 1–3 records and timestamps by streaming only; do not assume the existing v16 `.tar.gz` single-NDJSON adapter matches real file.
- If a complete book snapshot and chronological updates exist, replay deterministically from the **most recent full snapshot** through *both* fixed 12:00 and 12:05 targets; no source event AFTER either target may be used for its as-of quote. Handle qty-zero level deletion, an intervening full snapshot, and book seq gap as fail-closed. Price positive, bid<ask; quote age <=5000ms; target coverage bracket if possible. If archive stores independent full snapshots only, each one must be clearly labeled snapshot; DO NOT treat rows of per-price snapshots as deltas.
- If unsupported record layout, no full initial snapshot, unsorted data, overlapping books, missing exchange time, incomplete replay, or no provenance, **UNSCORABLE**. Do not invent data.
- Never use the existing official candle/funding ZIP files as bid/ask proxies. Never fabricate historical rows, a file checksum or quote value.
- For each fixed time, save best bid/ask and original event exchange timestamp plus source sha. Compute for BOTH directions the hypothetical price-crossing bps with real spread and illustrative entry+exit commissions 5/7bps per side. These are NOT actual fills, account PnL or proof of alpha.
- Original archive SHA and official catalogue/download evidence document *source provenance*, but absent OKX cryptographic content attestation one must still disclose provenance limitations.

## Engineering output

New v22 standalone offline quote benchmark with fixture tests that validate no look-ahead, book replay and fee arithmetic. A real archive file is **required** before reporting real prices. If real download is blocked/unavailable, finalize a working *offline import capability* plus an explicit missing-source report and precise manual download steps; never substitute simulated data for a real benchmark. All source outputs immutable/checksummed in separate `alpha-research/official-l2-v22` folder and code in separate research GitHub branch. User prefers manual on-demand R commands, no always-on laptop.

No changes to real Trader, PAPER/live accounts, scheduled tasks, main, v12 future source plan or existing v14/v15 frozen candidate definitions.
