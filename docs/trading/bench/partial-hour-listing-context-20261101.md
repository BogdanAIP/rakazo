# Partial-hour boundary context (data quality only)

Measured geometry: [partial-hours-20261101.json](partial-hours-20261101.json), code commit `95267779d184ee734e7de44cf5dfc809c429a22f`, result commit `829a0967c19851bc99d6f7c365c3db70d32fdfbf`.

All 479 missing minutes in ten observed incomplete hours are leading segments; none are internal or trailing. The previous hour is absent from the same archive and the next hour is present in all ten cases. This does not establish the cause or certify coverage.

## Selected official announcement comparisons

| Contract | First archived minute UTC | Announced perpetual enablement UTC | Archive precedes announcement time |
|---|---|---|---:|
| WSM-USDT-SWAP | 2023-10-06 03:56 | 2023-10-06 04:00 | 4 min |
| BIGTIME-USDT-SWAP | 2023-10-12 12:55 | 2023-10-12 13:00 | 5 min |
| TIA-USDT-SWAP | 2023-10-31 18:25 | 2023-10-31 18:30 | 5 min |

Primary sources, inspected 2026-10-31 UTC:

- [OKX-issued WSM announcement, October 5, 2023](https://www.globenewswire.com/news-release/2023/10/05/2755490/0/en/Flash-News-OKX-to-List-Wall-Street-Memes-WSM-Perpetual-Swap.html): perpetual scheduled for October 6 at 04:00 UTC; the wire displays October 5, 09:25 ET.
- [OKX BIGTIME announcement](https://www.okx.com/en-us/help/okx-to-list-perpetual-for-bigtime-and-enable-margin-trading-and-simple-earn): page displays October 12, 2023; perpetual and margin enabled together at 13:00 UTC October 12.
- [OKX TIA announcement](https://www.okx.com/en-us/help/okx-to-list-perpetual-for-tia-and-enable-margin-trading-and-simple-earn): page displays October 31, 2023, while the footer says November 1; perpetual scheduled for October 31 at 18:30 UTC. Margin activation is separate.

These are retrospective source observations. Page labels and a wire timestamp do not prove the earliest public availability or exclude later revisions. Scheduled enablement is not certified actual first execution. An archived candle timestamp alone does not prove an executed trade, preopening activity or an archive error. All ten partial-hour causes remain UNKNOWN. No prices were replaced, no minutes filled, no listing gate changed and no first-trade time inferred.

Before panel freeze, reconcile raw candle semantics and traded-volume provenance with actual listing/delisting and funding schedules. Keep announcement time, archive first observation and actual market availability as separate fields. No real hypothesis evaluation, holdout access or efficacy claim occurred; the 31 registered rules remain unchanged.
