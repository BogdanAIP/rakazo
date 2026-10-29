# Algorithm Discovery v6 — immutable first forward cohort lock

**Frozen BEFORE retrieving any post-entry price outcomes. 2026-10-29 18:44:03.046 UTC. No real or PAPER trading.**

This record pins the first prospective *hypothetical* evaluation cohort from the **already inspected** v5 OI/funding observations. Note that event representation and five candidate identities were known to the researchers before this lock; hence the frozen results will **not** count as proof of an independently discovered edge.

## Cryptographic record

Exact Windows-source bytes of the cohort freeze:

- file: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/forward-v6-frozen-cohort-20261029.json`
- **SHA-256:** `befd9fb6b45c1bda00419f4742f98daa27571b43138e11e2a0fb149d4a36b1a2`
- only original source files backed by verified v5 HTTP raw bytes, and the superseding **verified** (not the buggy former) event-label file, are accepted.
- freeze file must be passed verbatim with `--expected-freeze-sha256` to any future price capture or scoring command. Never edit or overwrite this file. A separate filename denotes a different experiment.

Frozen timing (UTC):

| Field | Value |
| --- | --- |
| Freeze recorded | **2026-10-29 18:44:03.046** |
| Guard after freeze | 5 minutes |
| First permissible hypothetical entry bar open | **2026-10-29 19:00:00** |
| Diagnostic 15-minute exit open | **2026-10-29 19:15:00** |
| Primary 60-minute exit open | **2026-10-29 20:00:00** |
| First permissible price evidence retrieval | **2026-10-29 20:15:00** (exit candle confirmed) |

Note the distinction: future exit is measured at **20:00 candle open**, but the complete price record cannot be treated as verified until after **20:15**. The source fetcher explicitly rejects calls before that time. One intentionally premature local invocation was rejected with `Do not acquire forward outcome before frozen earliest time`; it did not make an HTTP candle request or write output.

The 50 ranked instruments are retained, with five primary research directions:

| Frozen instrument | Hypothetical direction (never an order) |
| --- | --- |
| INIT-USDT-SWAP | +1 |
| BCH-USDT-SWAP | -1 |
| AAVE-USDT-SWAP | -1 |
| OKB-USDT-SWAP | -1 |
| GRASS-USDT-SWAP | -1 |

Other 45 instruments remain explicit no-trade/abstain controls. This direction mapping is **not** derived from proof that OI buyers or sellers dominate. It is just the prespecified signed funding change for the `CO_MOVEMENT` event group.

## Cost, outcomes, rigor

One-year trading profitability is *not* implied. Primary fixed-notional proxy uses 10% initial equity notional per selected symbol (max total 50% across five markets), 60-minute open-to-open return, 7bps per side and 14bps stress. Secondary 15-minute proxy is diagnostics only. Report all 50, including 45 abstentions. The single time block cannot support a p-value. No result from this cohort may be called validated profit, significant alpha, or grounds to enable PAPER. This proxy lacks realized funding cashflows, true order fills, mark/index, contract lot rounding, margin and liquidation.

Full preregistered rules:
`docs/trading/ALGORITHM-FORWARD-PROTOCOL-v6-20261029.md` in the same branch. Required for any claims about independent predictive benefit: at least 30 nonoverlapping future time blocks spanning >=10 separate UTC days, at least 100 eligible events across >=20 unique instruments, PIT source/membership verification, robust futures execution/carry accounting and predeclared dependence-/multiplicity-aware inference. Even meeting count thresholds is not automatic proof.

## Source and reproducibility

- `scripts/trading/algorithm_forward_freeze_v6.py` performs locked causal cohort creation and SHA-256 inputs
- `scripts/trading/algorithm_forward_prices_v6.py` is a **manual-only** five-instrument public-candle collection with expected hash check, mandatory timestamp gate, source SHA-256 receipts and completed `confirm=1` bars
- `scripts/trading/algorithm_forward_score_v6.py` reads **all ten** verified five-instrument candle batches before any outcome computation, preserves abstentions, and outputs the descriptive one-block fixed-notional equity proxy with `INSUFFICIENT_INDEPENDENT_EVIDENCE` regardless of the sign
- three associated unit test modules perform no-lookahead, tamper, cost, and abstention checks

To acquire *after* 20:15 UTC, invoke `algorithm_forward_prices_v6.py` manually once per rank-ordered batch number 1..10, with `--freeze`, `--expected-freeze-sha256`, and a **new**, previously unused `--out-dir` such as `.../forward-v6-prices-20261029-batch01`. Do not run a scheduler or polling loop. Each batch is bounded to five symbols and writes public read-only evidence. Once ten verified batches exist, `algorithm_forward_score_v6.py` accepts `--prices-root`, `--freeze`, `--expected-freeze-sha256`, and a new `--out` report path. Never submit any order or connect to the Trader agent on the basis of this study.

This lock is saved to the research Git branch only; **no main merge or active trading mutation**.
