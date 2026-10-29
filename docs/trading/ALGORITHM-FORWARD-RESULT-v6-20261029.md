# Algorithm Discovery v6 — sealed first forward-cohort outcome (NEGATIVE)

**Executed 2026-10-29 UTC; completed first 50-market retrospective price-outcome check. NO PAPER / real orders. DO NOT PROMOTE THIS MODEL.**

## Provenance and time-lock

The complete research protocol and frozen cohort were committed to this separate GitHub research branch **before** any forward OHLC outcome was read:

- Protocol: `docs/trading/ALGORITHM-FORWARD-PROTOCOL-v6-20261029.md`.
- Cohort lock: `docs/trading/ALGORITHM-FORWARD-LOCK-v6-20261029.md`.
- Exact source freeze: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/forward-v6-frozen-cohort-20261029.json`.
- Immutable source SHA-256: `befd9fb6b45c1bda00419f4742f98daa27571b43138e11e2a0fb149d4a36b1a2`.
- Frozen UTC: **18:44:03.046**; entry candle open **19:00**, 15-minute diagnostic exit **19:15**, primary 60-minute exit **20:00**, earliest permitted outcome source acquisition **20:15**.
- Actual official OKX read-only candle-source acquisition: **20:22:23.389–20:24:09.696 UTC**, fully after the locked earliest permitted retrieval.
- Source: `GET /api/v5/market/candles?instId=<frozen symbol>&bar=15m&limit=30`, original public response JSON. Ten manual batches of 5 instruments, five candle replies and two exchange-time controls per batch (**70 responses**). Every batch was accepted and all entry, diagnostic and exit candles required `confirm=1` with exact UTC 15-minute alignment. Rank, symbol, source URI, HTTP complete receipt, SHA-256 and OHLC invariants were checked. These files are kept locally in `pit-captures/forward-v6-prices-20261029-batch01` ... `batch10`.

The model only considers already observed v5 events. All 50 freeze members are represented in the output. **Five** events were predesignated primary hypothetical positions and **45** remained abstain controls. The time-lock prevents lookahead for this particular price-outcome period. It does not validate the data source's historical universe or general market prediction power.

## Primary test: unfavorable result

Model uses notional **10% of initial equity per candidate** (five simultaneous => 50% initial equity total, not leverage or account capital invested). Simple next-open to next-open retrospective OHLC price return and 7 basis points of costs **per side**. Stress uses 14 bps per side.

| Market | Frozen hypothesis sign | Entry open (19:00 UTC) | Exit open (20:00 UTC) | Base net / initial equity | Stress net / initial equity |
| --- | ---: | ---: | ---: | ---: | ---: |
| INIT-USDT-SWAP | +1 | 0.21974 | 0.21888 | **−0.053110%** | −0.067082% |
| BCH-USDT-SWAP | −1 | 288.08 | 286.74 | **+0.032547%** | +0.018580% |
| AAVE-USDT-SWAP | −1 | 133.31 | 133.41 | **−0.021507%** | −0.035512% |
| OKB-USDT-SWAP | −1 | 113.32 | 113.55 | **−0.034311%** | −0.048325% |
| GRASS-USDT-SWAP | −1 | 0.6414 | 0.6448 | **−0.067046%** | −0.081083% |
| **Total (50% allocated notional)** | | | | **−0.143426%** | **−0.213422%** |

Of five directional hypotheses, **one** was positive under both cost levels; four were negative. The full basket gross price movement proxy, before execution costs, was **−0.073429%** of initial equity. Base modeled round-trip drag was **0.069997%**, resulting in **−0.143426%** net; stress drag **0.139993%**, resulting in **−0.213422%** net. Cash non-trading benchmark is 0%.

The preregistered **15-minute diagnostic** was also negative at base costs: **−0.045844%** of initial equity summed across the five primary positions. It is not a new main strategy or alternative parameter.

**Reproducibility check:** Independently recalculated signed open/open returns with `decimal.Decimal` from the saved raw OKX candle JSONs without using the scoring module. Exact numeric agreement with the formal scorer:

- base fractional initial-equity return: `-0.001434257744257896669093407960`;
- stress fractional initial-equity return: `-0.002134223828150742902496143319`.

## Local immutable evidence and hashes

Research source base path:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`.

- Input freeze `forward-v6-frozen-cohort-20261029.json`, SHA-256 `befd9fb6b45c1bda00419f4742f98daa27571b43138e11e2a0fb149d4a36b1a2`.
- Frozen price-response receipts `forward-v6-prices-20261029-batch01` through `...batch10`: each contains `manifest.json` and 7 original OKX public response files. All 10 batches were independently re-verified by `algorithm_forward_score_v6.py`; all accepted.
- Full scored report `forward-v6-20261029-outcome.json`, SHA-256 `7492866cb57754228aff7fca10c072cb2387da35fa11cb86039d9db5d7d54b71`. It contains **all 50** market rows, frozen directions or no-trade status, primary and diagnostic prices, and net scores; flags `decision=INSUFFICIENT_INDEPENDENT_EVIDENCE`, `inferential_p_value=null`, `can_submit_orders=false`, `can_start_paper=false`.

## Falsification vs statistical limitations

The **first prospective time-block did not support the primary hypothesis**. It must be reported as a negative result, not retroactively tuned by reversing signs, picking only BCH, switching 60 to 15 minutes, discarding four losers, or adjusting fees/exposure until positive.

- Five positions in one simultaneous market hour are correlated; this is **one time block**, not five independent tests or fifty observations with returns. Statistical significance, Sharpe, future alpha or liquidation avoidance cannot be inferred.
- The hypothesis grammar and five-event selection representation were designed after already exploring data; even though future price candles were locked out at freeze time, **there is no genuinely independent, historically blinded selection of the strategy family**.
- Price proxy assumes fills at 19:00 and 20:00 OHLC trade **opens**, which are only retrospectively verifiable as completed candles. No actual orders were placed and no guaranteed ability to execute those prices is implied.
- Funding inputs are forecasts, not settled funding cashflows. Net proxy excludes realized funding, exchange account trading fees, dynamic spread, market impact, queue fills, actual contract value/rounding, mark/index, liquidation and margin. Base and stress costs are scenario assumptions.
- The 50-market set is frozen from a previously saved current-date screen without retained original raw ticker/instruments responses; historical membership and survivorship-free universe are unverified.
- The appropriate scientific conclusion is a **negative pilot result** plus evidence that a causal, auditable forward-outcome workflow is feasible. Continue only through **new, independent, preregistered** windows and richer independent information (point-in-time price, OI, funding forecasts/settlements, trade aggressor/orderbook with actual timestamp capture), not development-slice mining.

## Reproduce the already captured outcome without new web requests

In the isolated branch `research/algorithm-discovery-forward-v6-2026-10-29`:

```sh
python -m unittest discover -s scripts/trading -p 'test_*.py'

python scripts/trading/algorithm_forward_score_v6.py \
  --freeze /data/pit-captures/forward-v6-frozen-cohort-20261029.json \
  --expected-freeze-sha256 befd9fb6b45c1bda00419f4742f98daa27571b43138e11e2a0fb149d4a36b1a2 \
  --prices-root /data/pit-captures \
  --out /data/pit-captures/another-unique-scored-output.json
```

**Policy:** research worktree only; main branch, automated Trader, PAPER/real accounts, orders, schedules and paid API services were not modified.

**Final decision: NEGATIVE EXPERIMENT / INSUFFICIENT INDEPENDENT EVIDENCE / DO NOT ENABLE TRADING.**
