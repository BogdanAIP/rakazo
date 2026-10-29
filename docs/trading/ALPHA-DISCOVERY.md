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

## v1 - validated OKX 15m snapshots and one-use holdout (2026-10-29)

Files: `scripts/trading/okx_dataset.py`,
`scripts/trading/run_alpha_audited.py`,
`scripts/trading/test_okx_dataset.py`.

Only public, read-only `GET https://www.okx.com/api/v5/market/history-candles`
with `instId=...-USDT-SWAP&bar=15m&limit=100` and bounded backwards
`after=<oldest timestamp>` paging. Official docs:
https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history

No private keys, account connection, order submission, process scheduling or
interaction with the active Rakazo Trader. This research importer is separate
from the existing production 1H read-only adapter, not a replacement.

### Download CLOSED 15m history (only when the public network is available)

```powershell
python scripts/trading/okx_dataset.py --symbol BTC-USDT-SWAP --pages 8 --limit 100 --out C:/data/btc_15m_01.csv
python scripts/trading/run_alpha_audited.py --csv C:/data/btc_15m_01.csv --manifest C:/data/btc_15m_01.manifest.json --registry C:/data/alpha-holdout-registry --out C:/data/btc_15m_result_01.json --protocol v1
```

The first command requires at least 480 contiguous, confirmed bars and
refuses gaps, overlaps, backwards paging violations, non-UTC/candle-alignment
violations, malformed OHLCV and future-confirmed data. It creates an immutable
CSV and adjacent `*.manifest.json` with source, page SHA-256, data SHA-256,
capture time and temporal bounds. Byte identity is not proof of exchange
authenticity. These snapshots use opening time for each completed candle.

The second command independently checks SHA-256, full coverage, UTC close,
symbol identity, and claims the data hash in a *persistent* registry using
exclusive file creation **before** any holdout evaluation. A repeated run of
the same dataset is rejected, even with a new output filename. Never
reset/relocate the registry as a way to rerun unsuccessful test datasets.
Only a genuinely new chronological out-of-sample window may be used later.
The default search remains bounded, one-shot, and offline.

### Offline format checks (not real trading results)

```powershell
python -m unittest discover -s scripts/trading -p "test_*.py" -v
```

The importer can also accept `--offline-fixture path.json` to test pagination
without Internet. A research run over such data requires `--allow-fixture`,
and its report remains explicitly marked as synthetic. Never present such
results as OKX historical performance.

### Current limitations / review gates

- Read-only public OKX network access was unavailable from the Windows Host
  during the v1 implementation. Do not claim a real BTC/SOL dataset was fetched
  or any positive historical edge found.
- No funding rate, liquidation/maintenance margin, real futures contract-size,
  spread/order-book depth, queue/fill probabilities, exchange outages, or
  mark/index simulation. The 7 bps each side is a hypothetical cost assumption.
- A one-use registry prevents simple repeat tests of identical CSV contents,
  not scientific overfitting over many overlapping datasets. Next: purged
  walk-forward, embargo, model-selection correction, independent forward PAPER.
- Implemented candidate search and trailing-window switching are adaptive
  heuristics, **not** online neural-network retraining or a newly discovered
  algorithm. No returns or scientific novelty are claimed.
- Do not merge or deploy to PAPER or start any trading session without separate
  explicit operator instruction.

## v2 - rolling discovery with purged temporal splits (2026-10-29)

The research-only v2 code is in `scripts/trading/alpha_walkforward.py`.
The sole supported executable entrypoint is the snapshot auditor
`run_alpha_audited.py`. The walk-forward library rejects direct CLI execution
to prevent accidental bypass of the one-use holdout ledger.

### Workflow

1. Load at least **2880 consecutive closed 15-minute bars** for one instrument
   (30 days). Larger time spans and more market regimes are strongly preferable.
2. Reserve the final 20% as a single-use holdout. All searches in the preceding
   80% use rolling 960-bar training windows (10 days), a 4-bar embargo
   (1 hour), and nonoverlapping 192-bar scored intervals (2 days).
3. Within each training window, evaluate a deterministic initial population
   of bounded trend/reversal rules, mutate leading rules, and rank by the
   predeclared return-minus-drawdown score.
4. If no rule has enough previous trades and positive net return, take
   `NO_TRADE` for the next interval. At the following interval, start a fresh
   search using the newly closed training window; do not assume an edge.
5. Compare results across development folds with a fixed rule baseline.
   A minimum of four folds, 25 development trades, positive return,
   max 3% modelled drawdown, at least half of the folds profitable and
   better return than the fixed comparator are REQUIRED.
6. **Only if the development gate passes** evaluate the reserved holdout
   once, on the same precommitted rolling-search policy. Holdout results do
   not authorize PAPER or live orders.

This design does not secretly tune a strategy on future holdout data.
It permits chronological retraining as new candles close. It does NOT
prove a discovery is stable outside the examined history. Fold windows are
correlated and these thresholds are heuristic, not statistical significance.

### Run with a verified snapshot

```powershell
python scripts/trading/okx_dataset.py --symbol BTC-USDT-SWAP --pages 30 --limit 100 --out C:/data/btc_15m_v2.csv
python scripts/trading/run_alpha_audited.py --protocol v2 --csv C:/data/btc_15m_v2.csv --manifest C:/data/btc_15m_v2.manifest.json --registry C:/data/alpha-holdout-registry --out C:/data/btc_v2_01.json --seed 42 --rounds 2
python -m unittest discover -s scripts/trading -p "test_*.py" -v
```

Use a **new CSV snapshot and a new report filename** for a genuinely new
future testing interval. Keep the same registry, never reset it to recycle
already observed holdout data. The defaults are bounded at four rounds;
the collector at 30 pages x 100 rows, read-only. It does not start a schedule.

### What remains to establish a tradable edge

- Real source data: the Windows Host attempt at the OKX public API failed
  (network error). No authentic historical BTC/SOL report was obtained here.
- Model historical funding, contract lot sizes, leverage, liquidations,
  trade size-dependent spread/slippage and interruptions before PAPER.
- Test the research policy across many assets and regimes without treating
  50+ correlated assets as independent evidence. Adjust for multiple testing,
  transaction fees and survivorship/delisting bias.
- Use independent time-forward PAPER with identical risk and a measured
  baseline of the installed Rakazo Trader. The fixed v2 baseline is NOT
  the actual installed Trader.
- Do not configure real exchange keys, real-money trading, background
  sessions, or automatic Start/Resume. Risk controls remain external to
  this research project.

V2 adaptation means **periodic reselection and mutation of rules using
past observations**, not autonomous invention of an arbitrary new mathematical
model or an online neural network. It is not yet an AI model, a commercial
product, or evidence of positive investment returns.

## v3 - real multi-asset research enrollment and stress gate (2026-10-29)

The previous BTC/SOL use was a smoke test, NOT a two-asset strategy limit.
`okx_universe.mjs` independently obtains official public OKX perpetual
instruments and current public tickers. It selects crypto-category USDT-linear
swaps (excludes tokenized stocks/metals), with live status, >=90 days since
listing, an estimated >=2 million USDT of current 24h turnover, <=30 bps
current quoted bid/ask spread, positive and consistent contract metadata.
It records capture time, response checksums, ranking, filters, and up to
80 candidate crypto markets in an immutable JSON outside the git repository.
Current liquidity is not proof of historical liquidity.

First observed 2026-10-29 06:14Z: 125 eligible candidates after filters,
80 selected for research. The 80-asset selection is a *candidate universe*,
NOT 80 complete research datasets. Never confuse these counts.

### One-shot manual entrypoints

```powershell
node scripts/trading/okx_universe.mjs C:/data/okx_crypto_universe.json 80
python scripts/trading/okx_dataset.py --symbol ETH-USDT-SWAP --pages 90 --limit 100 --out C:/data/ETH-USDT-SWAP.csv
python scripts/trading/alpha_multi_market.py --universe C:/data/okx_crypto_universe.json --data-dir C:/data --registry C:/data/holdout-registry --reports-dir C:/data/reports --check-only
python scripts/trading/alpha_multi_market.py --universe C:/data/okx_crypto_universe.json --data-dir C:/data --registry C:/data/holdout-registry --reports-dir C:/data/reports --offset 0 --count 5
```

Complete and separately audit at least 50 instruments' >=8640 continuous
CLOSED 15m candles BEFORE permitting any multi-asset holdout evaluation.
The batch engine uses the same v3 single-use holdout registry and is bounded
to <=5 instruments per manually initiated run. It fails CLOSED with status
`INSUFFICIENT_HISTORY_NO_RESEARCH` when fewer than 50 credible histories
are ready. No automatic retry, unattended work, recurring tasks, execution,
PAPER Start/Resume, or real order access is added.

The Python history collector now defaults to the same exact pinned official
read-only OKX endpoint through Node's native fetch and refuses redirects;
Windows Python urllib received 403 while Node returned 200. Repeated
history paging then encountered OKX HTTP 429: stop immediately and honor
the provider's rate limits. The collector returns a failed request without
inventing bars or successful results. A scalable rate-limited resumable
bulk-history collection process remains a separate necessary milestone.

### Stress and scope

`alpha_robust.py` requires >=8640 bars (>=90 days), training 960 closed
bars, 4-bar embargo and 192-bar test folds. Evaluate development first.
Only if development tests pass is the reserved single-use holdout evaluated.
Initial modelled one-way costs: 5 bps taker +2 bps slippage; stress:
5 bps taker +10 bps slippage PLUS a **hypothetical** 2 bps per trade
adverse funding allowance. This is NOT measured exchange funding. The
futures contract's real funding times, mark/index basis, orderbook depth,
price impact, liquidation risk, historical listings, and maintenance
margin are NOT yet modeled. The v3 comparator is a predeclared momentum
rule, NOT the existing Rakazo Trader.

Local results: 22 deterministic unit tests passed, including 5 new
stress/lookahead/no-edge checks; positive synthetic price examples are
not empirical returns. Actual 90-day complete histories loaded into v3:
ZERO at this checkpoint. 80 candidate instruments therefore do NOT qualify
for multi-market evaluation yet. Do not claim profit, discovery, reliability,
or real PAPER admission. Keep existing Trader, positions and protections
untouched. Never retry quickly to evade HTTP 429.
