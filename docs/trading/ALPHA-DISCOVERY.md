# Alpha Discovery v0 (offline research)

Status: isolated experimental Python research module. Not connected to PAPER order
execution, Market Resolver, trading wallet, private endpoints, or schedulers.

## Intended behavior

- Search for new rule candidates (momentum trend/reversal, lookback, threshold,
  stop/target) with deterministic mutations. Repeat bounded search rounds even
  when the previous generation did not find a candidate.
- Evaluate candidates on chronological 60% training data ONLY.
- Evaluate the 12 train-ranked finalists on separate 20% validation data.
- Admit a provisional candidate only if both train and validation pass
  predefined minimum trades, net return and drawdown checks.
- Evaluate a frozen finalist ONCE on the last 20% holdout. A second rolling
  selector can switch among the previously validated top three based only on
  preceding completed trades; it may choose NO_TRADE.
- Produce a JSON research report. Do not create proposals, paper orders,
  actual exchange orders or background schedules.
- A negative result is a reason to explore a genuinely new data window or
  hypothesis family, not to reuse an already observed holdout repeatedly.

## Run

Requires Python >=3.10, standard library only.

Input: UTF-8 CSV with columns:

```
timestamp,open,high,low,close,volume,symbol
2026-01-01T00:00:00+00:00,100,101,99,100.5,12345,BTC-USDT-SWAP
```

Provide at least 480 consecutive 15-minute UTC *closed* candles for one
instrument. Real source data and dataset provenance must be separately verified.
The script rejects duplicates, gaps, malformed candles and mixed symbols.

Run from repository root:

```powershell
python scripts/trading/alpha_discovery.py --csv C:/data/closed15m.csv --out C:/results/run001.json --seed 42 --rounds 3
python -m unittest discover -s scripts/trading -p test_alpha_discovery.py -v
```

Output path must be new. No market data is fetched automatically.

## Fixed modeling assumptions and exclusions

- Direction: LONG or SHORT. No leverage, no real margin, no funding, no
  liquidations, no spread order-book replay, no fill probability.
- One-bar trade entered at the next candle's open. Both stop and take reached
  in the same candle means STOP first. Otherwise exit on that candle's close.
- Taker fee = 5 bps per side and adverse slippage = 2 bps per side, placeholders
  for research only; do not treat a fixed assumption as true observed costs.
- Fraction of virtual equity committed per synthetic trade: 10%.
- An entry opening gap greater than 1.5% is skipped. No overlapping positions.
- Historical results do not authorize either paper or live execution.
- Results from repeatedly inspecting the same holdout are NOT independent.
  Record evaluated datasets and reserve new, unseen forward data for new tests.
- A positive backtest does not demonstrate predictive ability on real futures.

## Next gates (not implemented)

1. Build authenticated read-only provenance-preserving OKX public data ingestion
   via existing Market Resolver; support >=50 eligible markets with point-in-time
   universe membership, delistings and missing data recorded. Never use private keys.
2. Extend offline simulation to real perpetual contract rules, historical
   funding, spread, slippage by size, orderbook/fill and liquidation stress.
3. Add formal repeated-testing controls (strategy-family ledger, holdout registry,
   multiple testing corrections), rolling multi-regime multi-market walk-forward.
4. Assess against deterministic baseline and existing PAPER Trader on identical
   data, fees, stop policies and risk (not by increasing leverage).
5. Owner-reviewed PAPER-only adapter + risk admission + kill switch. Separate
   explicit approval required. No auto Start/Resume or automatic risk loosening.

The search method and rolling selector combine existing known techniques.
No novelty or positive trading edge is claimed.
