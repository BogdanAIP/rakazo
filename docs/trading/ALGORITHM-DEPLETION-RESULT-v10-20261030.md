# Algorithm Discovery v10 — depletion/flow continuation, indicative bid–ask execution: NEGATIVE pilot

**Date: 2026-10-30 UTC. Research only. Zero real/PAPER orders, no account or private API usage.**

## Preregistration and immutable source evidence

The **new** research protocol `docs/trading/ALGORITHM-DEPLETION-PROTOCOL-v10-20261030.md` was committed **before** any new source acquisition, Git commit `14f65793c2f0e32b8135a979e4235ba0a6525d15`. The scoring code `scripts/trading/algorithm_depletion_score_v10.py` and its initial synthetic tests were also committed before collection, with no subsequent change to the H1 feature, direction, horizon, fee or comparators.

**Predeclared 8 separate public OKX eight-second WebSocket recordings** in order BTC run01, SOL run01, BTC02, SOL02, BTC03, SOL03, BTC04, SOL04; all eight captured once, no price-target-based retries. Time span of those captures **2026-10-30 06:14:24.107–06:16:57.606 UTC**. Combined **2,897 original logical WebSocket messages**, with full local receive time, per-source ordinal, raw message SHA256 and complete `books` incremental `prevSeqId→seqId` verified replay, and `trades-all` single-fill records. No API credentials and no private account/trading endpoints.

### Raw public evidence on the Windows research host

Research root: `C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`.

| Predeclared recording | Original logical messages | Original `manifest.json` SHA-256 | H1 events |
| --- | ---: | --- | ---: |
| `ws-v10-btc-20261030-run01` | 259 | `6cf1b4572eb6e2bfb2a662144f56f980edcba40b52b13f7976947bb447247b92` | 0 |
| `ws-v10-sol-20261030-run01` | 124 | `704f56a42af1a7e51f5ff5f2b166cfca166f30181b0122dd8ce25f31ed769a1b` | 0 |
| `ws-v10-btc-20261030-run02` | 238 | `ef90f9ed685db887512e9cf164b7c6e6ccefe5d327e3e05e8739e8d6766a99b7` | 1 |
| `ws-v10-sol-20261030-run02` | 174 | `32f5775b4a2c19d1d9a45c9f6393d9465f29774a0c9b0aa2c7ad0d1d38684a1d` | 1 |
| `ws-v10-btc-20261030-run03` | 1372 | `bd30855aa68a29cdd0cbf91f61e55093bfeab107cd091b810f7093910ff931a9` | 0 |
| `ws-v10-sol-20261030-run03` | 207 | `5551568505024fcdfb63f76ea55481ed1e1ce03ae38e72fbbcc87943b8a0e556` | 1 |
| `ws-v10-btc-20261030-run04` | 374 | `da6b1a5dfc0be9d5f8f84dc8b767dcc3dbb36634a86109f556505c19d45f374d` | 1 |
| `ws-v10-sol-20261030-run04` | 149 | `e3812950e15ce0d94680ae0ca56f8ae0da60152ceaef80badd5d61d0d9d55895` | 0 |

There were **40 possible source-second decision points** (five per eight-second run); only **four** satisfied the fixed quality + visible opposing-side depletion + taker imbalance requirements. **Eight source windows** were retained, including the four with zero primary candidates.

## Fixed feature, direction and conservative price proxy

At a complete source-second t=1..5, for nonzero buy-dominant `trades-all` flow together with `ask_reduced_contracts_t > ask_added_contracts_t` **and** `top5_ask_depth_t < top5_ask_depth_(t-1)`, hypothesize direction LONG. For sell-dominant with symmetrical bid-side reductions/depth decrease, hypothesize SHORT. This is a **displayed liquidity change**, not an executed passive fill: reductions can represent cancels, modifications or matching.

Feature time is end of t, two-second future evaluation time is end of t+2. All valid sources must have previously verified book sequence and complete bid/ask. Long price proxy: buy at the observed **best ask_t**, exit at **best bid_(t+2)**; short price proxy: sell at **best bid_t**, cover at **best ask_(t+2)**. Spread crossing is therefore accounted for, but these are STILL **not actual guaranteed fills**, especially because those quotes could change before a real order reaches the exchange. Subtract fixed 7bp per side / 14bp round trip for indicative net; no paid source, no actual fills, account fee tier, funding, queue, contract lot/currency/margin or liquidation model.

Predeclared controls: opposite-direction quote crossing on exactly the same four primary rows; taker-sign continuation on all flow-valid rows (a **different larger sample**); and previous-midprice-sign continuation on quality-valid rows with nonzero previous mid change (also a different subset). Comparators must not be declared superior by looking at raw means without paired inference.

## Main result — no viable economic continuation in this pilot

| Descriptive score | Result |
| --- | ---: |
| H1 eligible source-second events | **4** |
| H1 mean optimistic bid/ask crossing gross, before fixed fees | **−0.7744311197 bps/event** |
| **H1 mean net quote-crossing with 7bps per side** | **−14.7744311197 bps/event** |
| H1 mean signed two-second MIDPRICE move (non-tradable context) | **−0.2575790147 bps/event** |
| H1 positive net / nonpositive net | **0 / 4** |
| Opposite direction on same four events, net quote-crossing | −14.2592209836 bps/event |
| Taker-only flow-sign, different sample (n=17), net quote crossing | −14.5857640148 bps/event |
| Prior midpoint sign, different sample (n=5), net quote crossing | −14.6537077006 bps/event |
| Cash/no-position benchmark | 0bps, no execution costs |

Individual preregistered H1 source-seconds, hypothetical signed future 2sec marketable-crossing score:

| Instrument/run/t | Direction | Gross bps | After 14bps modeled round-trip |
| --- | --- | ---: | ---: |
| BTC 02, second 4 | BUY | −1.043246 | −15.043246 |
| SOL 02, second 3 | SELL | −3.062787 | −17.062787 |
| SOL 03, second 5 | SELL | +1.021033 | −12.978967 |
| BTC 04, second 4 | BUY | −0.012724 | −14.012724 |

One positive gross marketable crossing does not overcome costs. **All four** net outcomes negative; primary signed gross mean is itself negative. This is NOT account-level percentage return, Sharpe ratio, daily yield, or measured realized trading PnL.

### Exact independent arithmetic verification

A separate Python `decimal.Decimal` replay rebuilt the one-second features directly from the SHA/sequence-verified original raw source captures, without calling the v10 scorer, and independently recalculated bid/ask ratios, 14bp cost, next-two-second midquote moves, and all source/event filters. Independent primary means matched the v10 scorer **to all digits**:

```text
H1 gross mean fraction in basis points: -0.774431119690910473856757250
H1 net mean in basis points:             -14.77443111969091047385675725
H1 midpoint context signed bps:         -0.257579014668029335927304250
```

Complete scored report, including **all eight** original source SHA-256s, every evaluated opportunity, four primary events and all control cohorts:
`ws-v10-depletion-20261030-outcome-v2.json`,
SHA-256 **`c5b42cda5fbf6d33455b94b863f505f8242e041e3d9c8966515e9a287a2f75a8`**.

### IMPORTANT instrumentation correction AFTER initial data capture

This is a technical caveat, not a missing provenance. The FIRST scored artifact `ws-v10-depletion-20261030-outcome.json` was **superseded** (original SHA-256 `2fc49d5bcdc3967d91b5259ba7fdaca1f0b1b5bf64d422368826d26660fb9047`): it marked BTC run02 invalid (`UNACKNOWLEDGED_SOURCE`), because two individually delivered trades were recorded **before the trade subscription ACK**, yet both shared the exact local millisecond timestamp of the capture window start. **Per-source ordinal in the original SHA-verified frames proves they precede the ACK**.

Fixed only the input boundary/quality handling **after seeing source diagnostics**:
- The offline verifier now excludes pre-ACK source events timestamped **at or before** the synchronized start (previously used strictly earlier than start).
- The one-second extractor explicitly tracks each stream's ACK and excludes these pre-ACK events and all ambiguous exact-start-boundary messages from measured features; it still uses the full book snapshot to restore book state.
- Added a regression test constructing pre-ACK and ACK frames at one UTC millisecond with distinct source ordinals. It verifies source acceptance and exclusion of the pre-ACK fill from counts.
- The eight original source files, their recorded raw timestamps, and the frozen **H1 feature/direction/horizon/cost specification** were **not changed**. Re-analysis was saved to a NEW `-v2.json` file rather than overwriting the first report.
- BTC run02 is valid after the specific correction. The result changes from **3 primary observations across 7 source-qualified captures** with `INCOMPLETE_OR_REJECTED_SOURCE_COHORT` to **4 observations across all 8**; the new verdict is `NEGATIVE_PILOT_NOT_VALIDATED`.

Because of this **post-source instrumentation correction**, the complete analysis pipeline was **not literally unchanged between source receipt and final scoring**. The predictive rule was frozen, but any claim of fully blinded immutable analysis is inappropriate. The correction was motivated by source ordering, **not a favorable price result**; both first and corrected estimates were negative. Preserve both artifacts for traceability.

## Limitations and next scientific step

This is only eight short sequential BTC/SOL windows on one UTC day, with four H1 events. There is no independent statistical replication and no p-value or proof of universal impossibility/profitability. Even the marketable quote price is optimistic because it assumes instantaneous fills at a displayed best bid/ask; in reality venue fees, latency, impact and queue position can make execution strictly worse.

Important practical finding: with a frozen two-second horizon, a fixed 14bp modeled two-sided fee assumption strongly dominates the few-basis-point price movement; before attempting any implementation it is necessary to identify a real executable mechanism with sufficient expected edge to cover spread/fees, including min contract size. Lowering fees **after viewing losses** must not be used to make this sample profitable.

Next *separately preregistered* program could test quote-consistent trading outcomes over longer fixed horizons on new source days, include actual OKX contract multipliers and fee-tier documentation, and compare independent exit execution estimates with stricter adverse-selection/latency stress scenarios. This must use NEW data and robust day-block uncertainty; no ex-post horizon tuning of v10 is permitted.

**Final decision:** Negative single-day pilot. No statistically validated trading strategy; no modifications to active Trader, PAPER, real accounts, main, schedules, paid sources or API credentials.
