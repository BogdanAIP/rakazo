# P1: OKX public-market adapter — read-only scope

Status: in PR #3; awaiting exact-head CI. Added 2026-10-03.

## Purpose

Extend the BingX spot shortlist with a **second venue (OKX)** and discover dated/perpetual derivative metadata without accounts, API keys, wallet signing, futures orders or invented cross-product liquidity measures.

Sources to recheck at deployment:
- https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
- https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-tickers
- https://www.okx.com/docs-v5/log_en/ — premarket X-Perp may have instType FUTURES; reject ruleType != normal as an ordinary dated future.

## Plugin R procedures (after integration and deployment)

- trading/list: venue defaults to bingx; venue=okx selects OKX spot, applies the **same read-only** freshness/volume/spread prefilter. No model inference; output is an unranked-by-alpha shortlist, not a buy/sell recommendation.
- trading/catalog: three **fixed GET** requests to OKX public instruments endpoints SPOT, SWAP and FUTURES; returns markets plus explicit exclusions for incomplete/pre-market/expired contracts.

The extra OKX spot ticker GET uses volCcy24h for **spot only**, where OKX documents the unit as quote currency. For futures and swaps that field is **base currency**, not quote; derivatives therefore remain metadata-only until a separate unit-correct, quality-checked market-data and funding/open-interest design is approved.

## Safeguards / gaps

- No API keys, account reads, deposits, balances, orders, margin settings, signatures or scheduled polling.
- Bad JSON, HTTP or API response fails closed. Incomplete contract metadata and X-Perp/special contracts get explicit exclusion reasons. A future must have unexpired absolute expTime. No guessing based on symbol suffix for expiry.
- Instrument metadata is not enough for sizing futures orders: contract face value, settlement, margin and other venue-specific rules still require separate typed metadata before live execution.
- Instrument discovery is not confirmation of product availability for a given account/region/KYC.
- All adapter tests use mocked transport and synthetic fixtures; no assertion of current exchange uptime, actual account accessibility or genuine alpha.
- Do not promote to paper/live until current exact SHA checks pass and the existing risk/execution design receives a dedicated review. Review unrelated base-branch CI debt in its own integration PR.
