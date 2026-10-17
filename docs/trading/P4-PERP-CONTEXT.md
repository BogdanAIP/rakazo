# P4 — Public perpetual market context (no execution)

Status: draft implementation, dependent on P3. Read-only market research, not a strategy, leverage recommendation or promise of access to a particular exchange.

## Purpose

Perpetual futures need market-specific evidence beyond spot candles. Query **one catalog-confirmed active OKX SWAP**, via three sequential, public GETs on a fixed origin:

- `GET /api/v5/public/funding-rate?instId=<validated-swap-id>`
- `GET /api/v5/public/open-interest?instType=SWAP&instId=<validated-swap-id>`
- `GET /api/v5/public/mark-price?instType=SWAP&instId=<validated-swap-id>`

Official spec: https://www.okx.com/docs-v5/en/ (Public Data; funding rate, open interest and mark price). No API keys, balance reads, margin controls, orders, wallets, scheduler or background LLM use.

## Units and provenance

- `fundingRate`: signed **per-settlement** fraction, not an annual rate or guaranteed cash outcome. Timing can vary by instrument; use the source's `fundingTime`, not a hardcoded eight-hour interval.
- `nextFundingRate`: indicative, nullable; missing/blank next rate or time stays **null**, not zero. Check strict chronological ordering when present.
- `oi`: number of contracts.
- `oiCcy`: quantity denominated in the base asset.
- `oiUsd`: USD-denominated open interest estimate.
- `markPx`: derivative mark price; not a user's entry price or guaranteed execution price.
- Mark and OI carry their separate source timestamps. Stale (more than 90 seconds), future or wrong-instrument records fail closed. A settlement time more than one minute old also fails closed.

## Intended future Plugin R read

```json
{"procedure":"trading/perpContext","input":{"symbol":"SOL-USDT-SWAP"}}
```

The API first discovers public OKX instruments, verifies an **active perpetual** with exact symbol, then calls the keyless telemetry adapter. It never attempts to authenticate as a trader.

## Boundaries before a futures sweep / paper trading

This context must later join confirmed candle history, funding **history** (not just one instantaneous rate), mark/index basis, fee model, precise contract face value `ctVal` and settlement currency, margin/leverage/liquidation rules, liquidity and slippage. No autonomous execution or instrument recommendation is allowed from a single telemetry snapshot.

Technical reachability is not country-, residency-, KYC- or product-level authorization. Independent verification is required before any actual brokerage/exchange account is connected.

The implementation is covered by synthetic offline tests for signing boundaries, different OI units, negative funding, optional next-period fields, and rejection of stale/mismatched responses. Exact-head CI must be examined before acceptance.
