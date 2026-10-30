# Algorithm Discovery v18 — pre-registered 12-second WS data-quality study

**2026-10-30 UTC, BEFORE v18 data capture. Research-only, manual finite session.** This experiment deliberately diagnoses observed data-quality attrition in v17: both BTC and SOL had only 4/8 one-second bins with *both* a book update and a received taker fill. No candidate prediction or future outcome is being evaluated.

## Frozen acquisition and eligibility

Acquire exactly TWO **NEW** public OKX WebSocket captures in fixed order: BTC-USDT-SWAP, then SOL-USDT-SWAP, each synchronized for 12 seconds after book+trade subscription ACKs and full book snapshot. Raw evidence is saved exactly once with unmodified original logical websocket text, sha256, UTC and monotonic receipt timestamps in `ws-v18-oct30-btc-01` and `ws-v18-oct30-sol-01`. No retries to chase a better score; if failed preserve failure status. Do not modify prior v17/v12 data or original v8 collector.

Exact source pair: `books` incremental depth at `wss://ws.okx.com:8443/ws/v5/public`, `trades-all` individual fills at `wss://ws.okx.com:8443/ws/v5/business`; public read-only, no keys, orders or background service. Fixed limit source frames <=12000, bytes <=12MB, 12s observation, full data starts after ACK/snapshot. `trades-all` has no certified lossless global sequence; separate stream ordering not exchange-certified.

Use the already proven v8 parser and collector with a separately declared 12s observation constant in this research-only wrapper. Original v8 source and v12 manual calendar stay untouched. The v8 independent verifier requires fixed 8s; v18 must independently replay raw source sha/sequence/ordinal/ack and quote state, not pretend v8 8s audit covers 12s.

## Primary diagnostic (descriptive, no alpha)

For each of the 12 consecutive source seconds `[start+i*1000, start+(i+1)*1000)`, count:
- `book_updates`: incremental book messages timestamped by **local complete receipt**, after subscription ACK, with valid `prevSeqId -> seqId`;
- `taker_fills`: per-fill trade messages with both local complete receipt inside the bin and exchange trade timestamp within synchronized [start,end), after subscribe ACK;
- `both` if both counts >0. Count all frames and explicit missing/only-book/only-trade/none bins. Treat start boundary same-millisecond as ambiguous and exclude, keeping initial snapshot for state.
- Primary coverage 12s: `n_both / 12`. A 12s record is NOT a substitute for the v14/v15 frozen 8s source.
- For diagnosis only, report the *five predetermined overlapping 8-second windows* (0..7,1..8,2..9,3..10,4..11): their counts of joint seconds, but do not select maximum as an unbiased score and do not create signals or treat the overlapping windows as independent.
- Report observed total book updates and fills, first/last activity gaps, and the number of trailing/leading 1-sec bins with only book/trades/no messages.

**No threshold relaxation**: existing v14/v15 rules require >=6/8 dual-stream seconds on the ORIGINAL eight-second pre-registered source. v18 12s data only diagnose why that may be rare; they do not alter either existing selection rule, market-time horizon or outcomes. More data duration cannot retroactively turn v17 abstentions into successes.

## Fail-closed provenance

Each original source must pass: exact stored manifest+messages SHA, source ordinal counts, per-frame SHA, global monotonically increasing receive monotonic timestamps, parse accepted channel/symbol, both subscription ACK and book snapshot, sequential book `prevSeqId` without gaps, non-crossed best book, no duplicate trade ID, valid exchange timestamps, and duration between 11,900–12,200ms inclusive. Missing or failed source is NOT an inferred zero or positive diagnostic.

No real trades, PAPER, API credentials, automated schedules, main branch edits, downloading future REST prices, fee/PnL estimations or any attempt to bypass blocked v11 endpoint. Source-only observation results remain separate from v12 November validation/holdout.

**Scientific outcome of v18:** measured feed coverage and data-engineering options, not a profitable trading strategy.
