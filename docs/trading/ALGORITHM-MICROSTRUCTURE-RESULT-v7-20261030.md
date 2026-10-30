# Algorithm Discovery v7 — first prospective microstructure outcome (NEGATIVE)

**Checkpoint:** 2026-10-30 01:39 UTC (30 October 04:39 Moscow). This is an immutable **one-block research outcome**, not executable financial advice, PAPER execution or independent alpha verification.

## Hypothesis and preregistration (frozen BEFORE future price outcomes)

The research protocol **was committed before prospective market outcome retrieval**:

- [Protocol](ALGORITHM-MICROSTRUCTURE-PROTOCOL-v7-20261030.md)
- [Frozen source/candidate lock](ALGORITHM-MICROSTRUCTURE-LOCK-v7-20261030.md)
- Frozen 50-market cohort SHA-256: `89d5d24f2045f1223df47f862fd3aea8c22245846839ba4e389761294f7118b7`
- Freeze created **2026-10-29 22:12:17.834 UTC** from 50 independently verified book/last-100-taker source pairs, not from any future prices.
- Eligibility: **26** instruments where `sign(top5 book depth imbalance) != sign(last100 taker trade imbalance)`. Their **hypothetical** forward price direction was fixed to the sign of the **book** imbalance. Other **24** instruments were abstentions; all 50 still had prices audited.
- Virtual 15-minute candle entry **2026-10-29 22:30 UTC**, 60-minute primary virtual exit **23:30 UTC**, optional 15-minute diagnostic virtual exit **22:45 UTC**.
- Minimum permitted retrieval of future candle evidence was **2026-10-29 23:45 UTC**, after completion of the primary exit candle.
- Initial-equity total nominal budget: **50%**, equally distributed across 26 hypothetical positions (`Decimal("0.5")/26`). This is **not** leveraged trading exposure or cash actually invested.
- Assumed two-way costs: **7 basis points per side** baseline, **14 basis points per side** stress; no real fills or orders.

## Actual verified source acquisition

Manual, read-only public OKX candle data captured **2026-10-30 01:37:37.704–01:39:13.794 UTC**, fully **after** the locked earliest permitted source receipt.

Ten batches of 5 ranked markets each: **50 public 15-minute OHLC response payloads + 20 public clock replies = 70 original source JSONs**, in immutable local folders `micro-v7-prices-20261030-batch01` to `batch10`.

Each batch was SHA-verified against the source manifest: exact symbol, URL, received-at times, chronology, five 15-minute market bars, complete `confirm=1` state of **22:30 entry / 22:45 diagnostic / 23:30 primary exit**, OHLC coherence, raw JSON integrity and lock file SHA. No missing member, no stale surrogate, no future-data leakage.

**All 50 markets produced source-valid outcomes.** The 24 abstainers were preserved in the full scored file; they did not contribute to hypothetical basket returns.

## Pre-registered 60-minute result

The primary hypothesis **FAILED in this cohort**.

| Quantity | Percentage of initial total equity |
| --- | ---: |
| Portfolio gross signed open/open return before modeled costs | **−0.2783080283%** |
| Portfolio modeled two-sided execution drag at 7bps per side | **0.0698214921%** |
| **Portfolio net proxy, 7bps per side** | **−0.3481295203%** |
| Portfolio modeled two-sided execution drag at 14bps per side | **0.1396429841%** |
| **Portfolio net proxy, 14bps per side** | **−0.4179510124%** |
| Prespecified 15-minute diagnostic net proxy, 7bps per side | **−0.0851995217%** |

At the baseline 60-minute horizon **6/26** hypotheses had positive net returns and **20/26** were negative. Zero-position cash control = 0% with no execution cost.

Some contributors (these are *post-outcome descriptions*, not newly selected winners or recommendations):

| Instrument | Net % of initial total equity at baseline |
| --- | ---: |
| PEPE | +0.068942% |
| WLD | +0.032708% |
| CAP | +0.009861% |
| LIT | −0.061335% |
| AAVE | −0.059697% |
| LINK | −0.049607% |

No optimization, rebalancing, reversal of signs, selecting winners, dropping losers or substituting the diagnostic horizon is allowed on this already exposed cohort.

## Independent arithmetic replay and immutable hashes

I independently recomputed **each of the 26** signed returns using `decimal.Decimal` from its original public candle JSON, the pre-frozen source sign, and the pre-frozen `0.5/26` weight **without calling the v7 evaluator or reusing its calculated outputs**.

The independent sums agreed **to every digit** with the formal research evaluator:

```text
base_net_fraction   -0.003481295203468812877464279412
stress_net_fraction -0.004179510124045529362447219807
gross_fraction      -0.002783080282892096392481339018
15m_base_fraction   -0.0008519952173197098235390131621
```

Local research root:
`C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/`

| File | Exact byte SHA-256 |
| --- | --- |
| `micro-v7-audit-50-20261030.json` (original 50-market book/trades panel) | `194f446b317b13c09573d5a0214c1c36a74ed9f74d3bdf5219e847ee0484f8d9` |
| `micro-v7-forward-lock-20261030.json` (pre-outcome hypotheses and directions) | `89d5d24f2045f1223df47f862fd3aea8c22245846839ba4e389761294f7118b7` |
| `micro-v7-forward-outcome-20261030.json` (complete scored 50-market panel) | `5a2f13ff53a41cfc2e55dcf6843b3d60567f4645b49e64d2b193819661400641` |

The scored result contains all 10 price-batch manifest hashes, 50 candle entry/exit source rows, 26 preregistered hypothesis signs, 24 abstention cases, fee scenarios and `decision=INSUFFICIENT_INDEPENDENT_EVIDENCE`; `can_trade=false`, `can_start_paper=false`, `inferential_p_value=null`.

## Scientific interpretation and required change to the research PROGRAM

The **hypothetical depth-vs-taker antagonism rule fails for this one prospectively locked price-outcome hour.** Importantly, its negative result persists even before fees; merely lowering fee assumptions will not make the basket profitable in this sample.

**This does not disprove every absorption/replenishment hypothesis**. A five-level *single* book snapshot cannot measure **resting-limit order replenishment, canceled quotes, spoofing, or persistent passive absorption**. The last 100 trades is a truncated **variable-duration** sample (766–113,373 ms across symbols) rather than a continuous fixed-length, timestamp-gap-checked taker flow. In addition, the first cohort represents **one market-time block** with correlated returns; 26 positions do not constitute 26 independent tests.

For a *genuinely new informational experiment*, v8 should collect synchronized exchange-sequence-checked **incremental** order book messages together with timestamped continuous trade stream over a **fixed interval**, then build novel features from replenishment, depletion, adverse selection, and the actual lifecycle of aggressive trade flow. Any v8 hypothesis must be registered **before observing v8 forward prices** and compare against predeclared null and price-only/flow-only/market-beta baselines.

A future success claim still needs independent time blocks (at minimum 30 nonoverlapping blocks across 10 UTC days, 100 eligible observations covering 20 markets), causal historical source availability, dependence-/multiple-testing-aware uncertainty and a contract/funding/fill/mark/margin-aware execution model. Thresholds alone cannot prove edge.

**No accounts, PAPER or live orders, background monitoring, paid services, main merges or policy changes occurred. Do not activate v7 for trading.**
