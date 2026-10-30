# Algorithm Discovery v20 — independent apparent exchange/receipt timestamp study

**Date: Friday 2026-10-30, UTC. Completed as a manually initiated research-only session on Rakazo.** No continuous monitoring, no orders or PAPER operations, no account/API credentials, no automated jobs. Research branch `research/algorithm-discovery-event-latency-v20-2026-10-30`.

## Prospective method

The original exact experiment was committed in `docs/trading/ALGORITHM-EVENT-LATENCY-PROTOCOL-v20-20261030.md` on GitHub in commit `c05629d5f02f5151bb8f9c225aa64d1252d71adf`, **before BTC or SOL v20 sources**.

Exactly one NEW 12-second public `books`+`trades-all` WebSocket source, first BTC-USDT-SWAP then SOL-USDT-SWAP, collected by the original bounded 12s collector. Both original source SHA and per-frame hashes, subscribed ACK, initial depth snapshot, full `prevSeqId→seqId` book chain, individual trade IDs and source-clock plausibility were independently checked using `algorithm_ws_12s_coverage_v18.analyze`. No repeated selection of more favorable time windows. This v20 program does **not** run v14/v15 trading hypotheses and never requests future prices.

For every book and individual taker-trade data message **received during the original 12-second window**, calculated apparent clock difference:

`apparent_delta_ms = local_complete_receipt_utc_ms - exchange_message_ts_ms`.

This is **NOT network-only transport latency** and cannot separate unknown Windows-vs-exchange clock offset, exchange message generation delays, network transit and client processing. All results are descriptive, exact integer-ms. Quantiles are deterministic nearest-rank; never clamp negative values. Whole-second bins use local receipt. A strict fixed tail filter (source seconds 4..11) separately excludes trades received there whose actual exchange timestamp is before second 4.

## Actual NEW source artifacts and provenance

Local immutable research root: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`.

| Evidence | BTC-USDT-SWAP | SOL-USDT-SWAP |
|---|---|---|
| Source raw folder | `ws-v20-oct30-btc-01` | `ws-v20-oct30-sol-01` |
| Raw UTC times | 14:34:32.000–14:34:44.001 | 14:35:26.151–14:35:38.162 |
| Duration | 12.001 seconds | 12.011 seconds |
| Original complete logical WebSocket messages | **933** | **347** |
| Original manifest SHA256 | `176d2322b8582fecf3e206499094ef4ea7d54e76e2403f33466aae553bdc9d04` | `978c88a33aca1952ccacae87166d13848e94007f942528ae33977b3b6b5b336a` |
| Original `messages.jsonl` SHA256 | `f371056a3c5aa7af919cff09c3f19a144882a4165be60fddc10269496a136e51` | `4abc926768ee8531d3ad8e3cf8d010d29137fa772225093b23a3275c0628eb38` |
| Immutable latency output file | `ws-v20-oct30-btc-01-latency.json` | `ws-v20-oct30-sol-01-latency.json` |
| Output SHA256 | `21c1790646c44267e31ec596cd985189a4ef424d9f2c4583568914c2c33851c5` | `961c92274f46ad903f643985c386e76e8b5f556c7026f1c736eb50d3e08f2e70` |

Both complete raw source captures were actually obtained, independently verified and persist locally. Remote exec timed out while collecting (~12s plus protocol overhead), but original unique capture folders with original manifests and frames existed afterward; **sources were not re-captured or overwritten**. The separate offline v20 verifier was then run to completion on these exact raw files.

## Source timestamp measurements — millis, NOT independently established network delays

| Measure | BTC | SOL |
|---|---:|---:|
| Book message source observations included | 120 | 120 |
| Book apparent delay min / p50 / p90 / max (ms) | 1656 / **1659** / 1692 / 1711 | 1663 / **1666** / 1703 / 1765 |
| Individual taker trades included | **806** | **221** |
| Trade apparent delay min / p50 / p90 / max (ms) | 1667 / **1763** / 2226 / 2340 | 1659 / **1688** / 1891 / 1892 |
| Trade deltas 1001–2000ms | 603 | 221 |
| Trade deltas 2001–5000ms | 203 | 0 |
| Trades received in fixed last 8s but with EXCHANGE execution before tail start | **72** | **19** |
| Last 8s receipt-only joint book + taker seconds | **8/8** | **8/8** |
| Last 8s strict exchange-time-filtered joint seconds | **6/8** | **6/8** |
| Difference in joint second count from event-time gating | 2 | 2 |

The similar ~1.66-second apparent differences for both book and trades in these two sessions **could arise from host/exchange clock offsets or any common timestamp generation/processing mechanism**; one must NOT claim network latency of 1.66 seconds. The spread of these differences and delayed older trade receipts still matters for deterministic event-time processing. No NTP-trusted clock offset or synchronization between separate WS feeds has been demonstrated.

In particular, the original v18 apparent coverage metric and strict v19 tail metric differ in a scientifically material way: `receipt_utc` inside the trailing window is NOT enough to establish a fresh source execution inside the same window. In the two new v20 market-time observations, 72 BTC and 19 SOL older-execution trade messages would contaminate trailing-window flow features unless explicitly excluded. We kept them out; both full sources pass raw provenance/sequence re-audit.

These are **two real source captures**, not 2 x 2 independent strategies. Source-only strict completeness reached 6/8 in both, but v20 **did not run or lock hypothetical directions**; it has neither independently verified subsequent 5-minute bid/ask prices nor actual fills nor PnL. No alpha conclusion, no performance guarantee and no permission to trade.

## Code / tests

- New deterministic, offline (no network) `scripts/trading/algorithm_event_latency_v20.py`.
- New `scripts/trading/test_algorithm_event_latency_v20.py`, **5 synthetic tests passed** before acquisition, including an injected delayed pre-tail trade.
- **220/220** trading algorithm-family tests passed on v20 research checkout after source captures, plus **26/26** non-algorithm tests = **246/246 executed, all passed** (disjoint matching groups `test_algorithm*.py` and `test_[!a]*.py`). The separate `test_alpha*.py` group that earlier was blocked by tool safety was not retried and is **not** claimed as tested in v20.
- Original v12 study `multiday-v12-20261030/plan.json` (SHA256 `6ca065c2aea7ba3faf4c35e4d0d2ca5a145b4b1734da44abaf79e2a7140ec6bf`) and v14/v15 two ChatGPT hypothesis specs remain unchanged, and neither v20 source belongs to the Nov1–12 control calendar.
- Active Trader, PAPER/live, main, secrets, paid providers and all schedules unchanged.

## Scientific next step (NOT automatically launched)

An independent **v21** prospectively specified test could compare separately captured, well-defined exchange/book timestamps with an **independently established local clock offset**, and evaluate a fixed rule to wait for a predeclared settling/watermark duration (where any wait extends the ACTUAL decision time). Such an event-time filtering procedure must be specified BEFORE collecting *new* raw WS sources, not fitted after v20, must never use trades arriving after the actual decision, and needs independent multi-day validation and authorized later bid/ask archived outcomes for PnL. No NTP/clock-offset service has been configured as part of v20.

**Verdict: measurable ~1.65s common apparent timestamp offset and source-dependent delayed trade arrivals identified, not corrected or claimed as proven network latency. Next correct challenge is CLOCK PROVENANCE and a causal synchronized decision boundary, not retuning crypto trading indicators.**
