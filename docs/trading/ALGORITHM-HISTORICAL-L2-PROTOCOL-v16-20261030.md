# Algorithm Discovery v16 — precommitted independent historical L2 follow-up

**Research-only; authored 2026-10-30 BEFORE any November v12 source or archived future price has been observed.**

## Why change source workflow

Earlier v11 attempted a real-time public REST quote and the remote tool prevented the operation. We will NOT reissue it through another route. Instead the official OKX Historical Market Data page advertises downloadable high-resolution L2 order books and historical trades (https://www.okx.com/en-us/historical-data). Such files can be downloaded **later by the user**, when published, without keeping a laptop on for the entire five-minute forecast horizon. Actual daily/hourly archive availability, file layout, exchange coverage and authenticity must be established on a real sample BEFORE claiming successful validation. No automatic data fetch, unauthorised alternative endpoint, private account, API key or paid service is part of v16.

## Crucial distinction: retrospective observed quotes vs future prediction

Prediction is determined using only a fixed 8-second **new source** with a candidate rule committed BEFORE source capture; a v14/v15 source-only SIGNAL record must be written BEFORE the proposed outcome becomes known. A historical archive downloaded afterward can be used to LOOK UP the later outcome, without changing the earlier selection rules. This is legitimate *prospective testing followed by retrospective data retrieval*, not creating a forecast after seeing historical prices.

An external file + its SHA-256 DOES NOT establish that the bytes were truly provided by OKX. A URL string or human-entered retrieval time likewise provides no cryptographic attestation. Every new v16 outcome must stay **PROVISIONAL_UNVERIFIED_ARCHIVE_ORIGIN** unless there is a separately audited, independently trusted retrieval provenance. Numeric outputs are hypothetical **marketable quote-crossing proxies**, NEVER realized trading PnL and NEVER a confirmed alpha claim.

## Locked rule and lag

Both precommitted ChatGPT hypotheses have a 300,000ms (5-minute) future horizon. For every precommitted source-only *eligible* signal, target exchange time is **`capture_end_utc_ms+300000`**. Original signal file must have been created before that future time and at most 15 seconds after the source window's end (avoid post-outcome signal selection). Signal file is SHA-anchored separately and original WS text must re-audit successfully. The bid/ask entry quote must come from the final source book quote and must be <=500ms old at capture end.

From a user-supplied later independent L2 archive, reconstruct the top of book using a full `snapshot` followed by every chronological `update` from that snapshot through the target; apply qty=0 deletions. Pick latest state with `event_ts <= target`, **never the first event after target**. The chosen book timestamp must be within 5 seconds of the target (config fixed), valid positive best bid < best ask and positive best sizes. If available, require continuous seqId/prevSeqId; when absent record `sequence_continuity_certified=false` and make no false claim that all archive updates are complete. An archival snapshot may be a complete sequence of snapshot rows and require a separate adapter; do not silently assume all L2 formats match.

To avoid cherry-picking, each candidate/symbol/day must be evaluated at most once in immutable file output. Missing or unsupported archives produce `UNSCORABLE`, not 0 return; do not substitute candle OHLC midprices for executable bid/ask crossing. No posthoc fee/horizon/slippage/quality threshold tuning.

## Predeclared exploratory arithmetic, not actual fills

Direction `d=+1/-1`, source entry best bid/ask `bid0/ask0`, later archived bid/ask `bid1/ask1`.

- Long: entry ask0, hypothetical exit bid1; gross bps `10000*(bid1/ask0 - 1)`.
- Short: entry bid0, hypothetical exit ask1; gross bps `10000*(1 - ask1/bid0)`.
- Fee scenario 5bps EACH side based on respective entry+exit notional; sensitivity scenario 7bps EACH side. Show exact decimal arithmetic, paired cash 0bps, and original spread. Slippage, position size, contract ctVal/ctValCcy/lotSz/minSz, funding and mark/index margin are NOT included. Even a positive proxy is NOT real executable PnL.
- User-supplied archive authenticity level is **unverified** regardless of its claimed filename/URL; report provisional scores only and exclude from official validated return totals.

## Publication/file safety

- Offline only; no network calls.
- One tar.gz file with newline-delimited JSON action snapshots/updates is supported initially. This is a **provisional parser based on a published third-party format description**, NOT a guarantee of exact OKX 2026 native files. Validate with an actual user-provided official archive before production.
- Reject truncated/malformed JSON, nonchronological event timestamps, crossed/zero quotes, no preceding snapshot, stale book, impossible seq gaps, oversized records, suspicious tar paths/links or multiple archive members. Streaming parser avoids loading full day into memory.
- Report original binary archive SHA-256; never overwrite a source or a prior outcome. Raw archive retained; no record can alter the immutable v12 study calendar, v14/v15 hypothesis definitions, active Trader/PAPER, scheduled jobs or main branch.

## Model selection/independence

v12's original November calendar has at most 60 distinct market/day slots, 30/15/15 across dev/validation/holdout, insufficient for the earlier >=100 eligible-source threshold. Two candidate predictions on one source are NOT independent. No model is separately sealed before November 7. The provisional v16 adapter must not quietly authorize validation/holdout scoring or enable PAPER or live trading. This work only makes future outcomes *technically analyzable after independent provenance is established*.

**Success in v16 phase one = offline replay, source binding, timestamp and fee arithmetic fully tested with synthetic data, not any newly demonstrated profitable algorithm.**
