# AUCTION funding clock context (unresolved provenance)

The [60-date audit](candle-audit-20261101T0652-result.json) preserves original event clocks. Of 26,605 consecutive per-symbol funding gaps, nearest-hour diagnostics show 26,604 at 8 h and one at 16 h. The legacy raw counter gives 8,881 gaps above eight hours; most are second-scale timestamp jitter, not evidence of missing settlements.

The 16 h case is AUCTION-USDT-SWAP: an archived record at **2023-11-30 16:00:14 UTC**, followed by **2023-12-01 08:00:17 UTC**. Cause remains UNKNOWN.

[Official OKX AUCTION perpetual listing announcement](https://www.okx.com/en-gb/help/okx-to-list-perpetual-for-auction-and-enable-margin-trading-and-simple-earn), retrieved November 1, 2026, displays December 1, 2023 and schedules perpetual enablement at **08:00 UTC December 1**. Thus the earlier archive record precedes the announced enablement. This is retrospective primary-source context, not proof of actual first execution, billing or the page's earliest availability/revision history.

Do not infer a missing midnight funding payment or treat the earlier record as a verified paid settlement. Initialization, source semantics and historical listing/billing provenance still need reconciliation. No row was dropped, timestamp rewritten, rate replaced or historical schedule backfilled. No strategy evaluation, freeze, holdout or efficacy claim.
