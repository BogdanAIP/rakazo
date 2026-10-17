# P2 — Confirmed candles and reproducible research baseline

Status: experimental / research-only in draft PR #3, 2026-10-03. **No real orders, no trading key, no account connection.**

## Official data and unit contract

- OKX historical candles: https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history
- Only `GET /api/v5/market/history-candles?instId=<validated>&bar=1H&limit=100`; fixed OKX origin, GET, explicit redirect denial and bounded response; one selected, catalog-confirmed market per request.
- OKX returns `[ts,open,high,low,close,vol,volCcy,volCcyQuote,confirm]`. Use only `confirm=1` bars whose hour has fully elapsed; reject malformed rows, duplicate confirmed timestamps, out-of-order/gapped analysis windows, impossible OHLC, stale history or identity mismatch. Latest unconfirmed bar is **never** used as evidence.
- `volCcyQuote` is **quote-denominated for both spot and derivatives**, unlike `volCcy24h` in tickers (spot quote; derivatives base). Do not conflate the two fields.
- Public metadata alone does not authorize product availability for a particular country, residence, KYC status or account.

## Current experimental research interface

**`trading/analyze`** through the existing authenticated `rakazo_read` procedure (only after PR review, merge and an explicitly approved deployment):

```json
{"procedure":"trading/analyze","input":{"symbol":"DOGE-USDT-SWAP","kind":"perpetual"}}
```

Both fields are user-provided; the symbol must match one actively discovered OKX market. API performs three public catalog GETs and at most one single-market historical-candle GET. No recurring scan is registered.

Algorithm `breakout_20_1h_v1` is **only a deterministic baseline for future walk-forward testing**, not a validated profitable strategy:
1. Obtain at least 21 fully closed consecutive hourly bars, from exactly the selected instrument.
2. Use only the preceding 20 bars to establish the threshold, mean quote-volume and mean range. The latest bar cannot set its own threshold (avoids immediate look-ahead leakage).
3. Consider an **illustrative conditional long** (spot buy or perpetual long) only after latest close breaks above prior maximum high by more than one tick and latest quote-volume is at least 1.5x the prior mean. The symmetric downside event can produce perpetual short, **not spot short**.
4. Otherwise return `NO_TRADE` with explicit reason; return NO_TRADE on stale data, inactivity, gaps, unknown tick precision, low volume or unsupported dated futures.
5. For a scenario, output an entry trigger, illustrative stop and 2:1 nominal target, fixed 30-minute maximum signal lifetime, version, evidence IDs and explanation. **Risk budget and executable slippage remain null** until independently authorized portfolio/depth inputs exist. No order is created or sent. Always recheck quote and order book before any future execution.

The strategy has **not** been backtested, optimized, evaluated with funding, liquidation, fees or slippage, or promoted for real money. Price outputs are research estimates using JS numerical arithmetic; a later actual order subsystem must use decimal-safe exchange-compliant sizing and an independent approval/risk boundary.

## Work remaining before claims about tradable signals

- Reproducible versioned historic dataset, exchange timestamps and provenance.
- Walk-forward experiment runner with fees, funding, delisted-market histories, realistic order-book costs and baselines (including no-trade).
- Public funding, mark/index price and open-interest collection with source-time checks for perpetual research; dated futures need verified contract-face-value, settlement, margin and expiration rules.
- Separate paper execution and journal/reconciliation/kill switch before any consideration of private keys or real account access.
- Real exchange/API responses, KYC, regional/product restrictions and infrastructure resource usage must be confirmed in the actually deployed environment. Fixture tests alone do not prove market accessibility or a profitable edge.
