# Algorithm Discovery v30 — historical public news and source-time register

**Research-only register prepared 2026-10-31. Incomplete corpus. No causality claims, no use of post-signal headlines as past-only features, no realtime news-arrival certification.** The v30 trading event timestamps and outcomes were selected using original OKX data and the previously frozen source-time protocol, never this register.

## Official timestamps

| Event | Public-source clock (UTC) | Primary source | Interpretation |
| --- | --- | --- | --- |
| US August PPI official release | **2026-09-10 12:30** | [BLS original release](https://www.bls.gov/news.release/archives/ppi_09102026.htm): explicit embargo until Sep10 08:30 ET | In fixed preceding-120min window only for **SOL-USDT-SWAP Sep10 14:30 UTC** selected onset (exact 120min boundary); that signal's +/−1% first passage was CENSORED; temporal co-occurrence not proof of cause |
| US FOMC decision | **2026-09-16 18:00** | [Federal Reserve original announcement](https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm): for release Sep16 14:00 EDT, target range increased by 25bp | Genuine potential context for market regime Sep17 but **more than 120min before all Sep17 02–09 UTC signals**; NOT a matching immediate presignal headline |
| NEAR confidential TVL + milestone snapshot press release | **2026-09-17 14:00** | [NEAR-supplied PRNewswire press release](https://www.prnewswire.com/news-releases/nearcoms-confidential-tvl-reaches-70-million-triggering-the-near3-33-snapshot-amid-industry-wide-privacy-wave-302881903.html) dated 10:00 ET | **AFTER all 10 observed NEAR/SOL Sept17 selected onsets** (latest SOL 08:41 UTC); cannot be used as a cause known before those onsets |
| US Initial Jobless Claims, Philadelphia Fed survey, Housing Starts | **2026-09-17 12:30** schedule | [New York Fed economic indicator calendar](https://www.newyorkfed.org/research/calendars/i-sep26.html): Sep17 08:30 ET scheduled publications | AFTER the Sept17 02–09 UTC observed onsets, none selected in 14:00–14:45 window. Calendar verifies scheduled timing, NOT independently timestamp-verified release payload or actual-live arrival. Do not label these as event data known before selected onsets |
| Solana developer changelog (V1 transaction activation delayed to Epoch 1035) | **2026-09-10, exact time UNKNOWN** | [Solana Foundation's dated changelog](https://solana.com/news/solana-changelog-september-10-2026) | Relevant same-day network news, but without historical minute of first public posting it MUST NOT be joined as known-at any 02:00–14:45 UTC onset |
| Solana institutional tokenized funds / Project Harmonia item | **2026-09-16, exact time UNKNOWN** | [Solana Foundation official news index](https://solana.com/news) lists Sep16 | Potential prior-day background only; no proof the publication was available before the Sep17 test signal. Exclude as timed causal feature |

## Frozen v30 120-minute joins for all 21 authentic onset timestamps

- **Exactly ONE selected onset in this 3-event exactly-timed original-release subset** has a release inside the frozen 120 minute past-only window: SOL-USDT-SWAP **2026-09-10 14:30 UTC**, matched to BLS PPI 12:30 UTC, 120min gap. That onset was in the L2 **aligned** group, but remained **CENSORED_60**. No claim it moved in response to PPI, nor proof that no other reports were in the window.
- All selected Sept17 NEAR (02:08, 03:13, 05:11, 07:05, 08:17 UTC) and SOL (03:09, 04:47, 05:54, 07:40, 08:41 UTC) predated the 12:30 UTC macro schedule and 14:00 UTC NEAR PR. The 16 Sep 18:00 UTC Fed release is an older possible regime influence, not a 120min pre-event match.
- The scheduled Sep10 PPI event occurs **during market-source coverage** and would have been available before 14:30 UTC by its release time. **Historical release-time proof does not certify latency of historical news ingestion by any bot.**
- Exact-time incomplete news sample, unknown historical availability for same-day announcements and unspecified wider events mean **NEWS_COVERAGE_UNKNOWN for each onset even if no recorded release matches**. “No indexed headline” must never become “no news” or a positive predictor.
- No original minute-aligned historical liquidations/open-interest/forced order identity/verified social-media discovery has been established, so no manipulation or news-initiator claim.

## Scientific status

This research is a **selective evidence register**, NOT a full tick-timestamped newsfeed, backfilled historical surprise data or confirmed explanations of historical price fluctuations. This register was built AFTER market outcomes; it must not be used to tune the v30 detector, choose which v30 observations count or create an already-validated news alpha.

The real v30 outcome registry, including all selected and abstained minutes, is preserved as SHA-bound private original files; report link is in the parallel v30 final result.
