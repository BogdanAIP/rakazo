# Algorithm Discovery v7 — auditable microstructure source cohort and locked forward hypothesis

**Timestamp: 2026-10-29 UTC / 2026-10-30 Moscow time.** No trading, no automated collection, no accounts or API keys.

## Motivation and official source semantics

The previous v6 candidate `CO_MOVEMENT(OI change, funding forecast change)` lost **−0.143426%** of modeled initial equity net of 7bps per side in its first prospectively price-locked 60-minute hour. We preserved that negative result without reranking or sign flipping.

v7 makes a **different informational observation**, not a retuned v6 strategy: recent trades with a taker-perspective `side` and five visible bid/ask levels of the regular (non-RPI) book. According to [OKX public trades API](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-trades), the reported trade `side` is the **taker's** direction and derivatives trade `sz` is measured in contracts. The [OKX public book API](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book) describes bid/ask depth also in contracts for derivatives, a generation timestamp and sequence ID.

These data **do not identify a buyer/seller, hidden intent, institutional trader, net long positioning, complete book evolution or true replenishment**. The last 100 trades are a variable-duration truncated sample, not uniform time-bucket order flow. Thus v7 is an exploratory observable-depth/taker-pressure antagonism representation, not proven scientific novelty, a causal market explanation or a profit-making algorithm.

## Physical manual source acquisition

At the Windows Rakazo host, in the isolated research worktree, collected **all 50/50 frozen USDT-SWAP candidates** using ten bounded, manually invoked five-symbol batches, with:

- 50 five-level ordinary order-book snapshots `GET /api/v5/market/books?instId=...&sz=5`;
- 50 per-market batches of the **last 100** taker-direction trades `GET /api/v5/market/trades?instId=...&limit=100`, totaling 5,000 reported trades;
- 20 `GET /api/v5/public/time` control replies;
- **120** original bounded raw JSON responses, their actual request-start/full-receipt timestamps and SHA-256, instrument IDs, volume/price checks, books with ordered bids and asks, and unique trade IDs with nonincreasing timestamps.

Capture UTC **2026-10-29 22:02:58.173–22:07:12.294** (254.121 seconds). All ten batch manifests reverified directly from original raw responses. All 50 snapshots satisfied source quality rules. No historical/backfilled book/trades snapshots were invented.

The custom trade-data validator initially incorrectly assumed exchange `tradeId` had to descend inside the same millisecond; it failed on DOGE in a **real** response: two distinct IDs with an identical timestamp were out of ID order. The change now checks **unique trade IDs** and monotonic nonincreasing **timestamps**, but does NOT require sorted IDs within one millisecond. Regression test added and passed. Initial failed requests did not create approved research evidence.

## Descriptive first cohort

| Quality/result | Verified count |
| --- | ---: |
| Frozen instruments | 50 |
| Non-stale ordinary books | 50 |
| Non-stale last-100 trade samples | 50 |
| Source-paired descriptive observations | 50 |
| Book imbalance sign agrees with taker-flow sign | 24 |
| Book imbalance sign opposes taker-flow sign | **26** |
| Zero/unknown sign | 0 |
| Public API responses | **120** |

For each symbol, the pair becomes available **only after both** the book and the trade response have been fully received, and is rejected if book/trades quality or near-simultaneity fails. This is NOT an atomic server-side paired snapshot.

Measured last-100-trade **sample-duration** distribution: **min 766 ms, median 8,616 ms, max 113,373 ms**. This means market A's 100 trades can describe ~0.8 seconds while market B's cover almost two minutes. Raw contract quantities across different markets also have different contract multipliers. Do not compare magnitude as a normalized fixed-interval cross-market signal. We only use **the sign of within-market normalized quantities** for this first pilot and explicitly record the duration limitations.

## Source evidence integrity

Local research root:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`.

- Ten folders `micro-v7-20261030-batch01` through `micro-v7-20261030-batch10`, each contains one manifest and 12 raw OKX API response files.
- Full audited 50-market panel `micro-v7-audit-50-20261030.json`, exact SHA-256 **`194f446b317b13c09573d5a0214c1c36a74ed9f74d3bdf5219e847ee0484f8d9`**, 80,743 raw bytes.
- Source market universe is inherited from v5: `universe-50-20261029.json` SHA-256 `3193fcab0a38e6a881d5b26e28efb1db59e60a0e051a8084112a19f53274a9d3`. Its ORIGINAL ticker/instrument selection responses and historical survivorship-free membership have NOT been certified.
- `scripts/trading/algorithm_microstructure_capture_v7.py` for bounded capture, receipt verification, quality/status and no-lookahead.
- `scripts/trading/algorithm_microstructure_audit_v7.py` for all-ten-batch replay and 50-row descriptive source panel; raw data are retained locally, not committed to Git.

## Prospective price-outcome hypothesis preregistration — LOCKED

The protocol `docs/trading/ALGORITHM-MICROSTRUCTURE-PROTOCOL-v7-20261030.md` was committed **before any future price-outcome read**. The source-audited cohort was frozen with `scripts/trading/algorithm_microstructure_freeze_v7.py` at **2026-10-29 22:12:17.834 UTC**.

**Immutable exact freeze file:**
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/micro-v7-forward-lock-20261030.json`
SHA-256 **`89d5d24f2045f1223df47f862fd3aea8c22245846839ba4e389761294f7118b7`**.

Frozen primary: in all 26 opposing-sign observations, test the 60-minute return **in the direction of the deeper displayed book side**, as an exploratory hypothesis about absorption against prevailing recent taker side; the 24 aligned cases stay abstentions. The observed event grammar was designed and inspected before price locking, so this is **not blind independent discovery**.

| Field | Locked UTC |
| --- | --- |
| Raw source latest receipt | Oct 29 **22:07:12.294** |
| Frozen hypothesis file created | Oct 29 **22:12:17.834** |
| Virtual candle-entry OPEN | Oct 29 **22:30:00** |
| Diagnostic 15-minute virtual exit OPEN | Oct 29 **22:45:00** |
| Primary 60-minute virtual exit OPEN | Oct 29 **23:30:00** |
| **Earliest allowed outcome retrieval** | Oct 29 **23:45:00** |

Primary hypothetical notional allocation: **50% of INITIAL equity across 26 equal virtual positions**; each nominal share `Decimal('0.5')/26`. Base symmetric 7bps per side, stress 14bps per side. No position under the 24 controls. Do not select a market-specific winner, alter directions/thresholds, remove losing contracts, or switch to diagnostics based on price results.

The file's SHA-256 is embedded in all allowed future source captures. The manual-only forward capture and scorer is `scripts/trading/algorithm_microstructure_forward_v7.py`, invoking hardened v6 confirmed-15-minute public candle primitives. Before **23:45 UTC** an intentional test invocation was blocked locally with `PROHIBITED: future price read before frozen time`, without any price request or output file.

Once 23:45 UTC has genuinely arrived, manual capture is permitted in ten new, never-overwritten folders `micro-v7-prices-20261030-batch01` ... `batch10` with:

```sh
python scripts/trading/algorithm_microstructure_forward_v7.py \
  --freeze /data/pit-captures/micro-v7-forward-lock-20261030.json \
  --expected-freeze-sha256 89d5d24f2045f1223df47f862fd3aea8c22245846839ba4e389761294f7118b7 \
  --root /data/pit-captures \
  --batch 1 \
  --out /data/pit-captures/micro-v7-prices-20261030-batch01
```

Repeat **only manually** for 2 through 10 (unique folders); then score all 50, including 24 abstentions, by **omitting** `--batch` and choosing a new `--out /data/pit-captures/micro-v7-forward-outcome-20261030.json`. The read-only scorer will always report `INSUFFICIENT_INDEPENDENT_EVIDENCE` for this one-block pilot; any return remains a *hypothetical, retrospective* candle-open proxy, not real fills, margin model or liquidation safety.

All v7 feature, audit, freeze and forward evaluator source and tests reside in the isolated research Git branch. **No price-outcome score was produced at this checkpoint**, because entry and exit had not yet occurred. Do not claim alpha.

## Next methodological requirement

A true microstructure causal claim needs **incremental/sequence-verified orderbook history**, actual complete time-bucket taker flow with gap detection, realistic contract-level bid/ask executions and funding, plus independent nonoverlapping future samples and controls for same-time market dependence. One time block of 50 simultaneous instruments is not 50 independent replications.

**Main branch, active Trader, PAPER/live accounts, orders, paid sources, schedulers and automations remained untouched.**
