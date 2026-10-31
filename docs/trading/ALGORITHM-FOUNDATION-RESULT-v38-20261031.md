# Algorithm Discovery v38: first original July training batch

**Independent effectiveness remains unconfirmed.** v38 completed a new original-source batch, reconstructed NEAR/SOL liquidity and ran the frozen six-program development pipeline. Both active rank controls were negative after hypothetical quoted costs and missed all three retrospective price-path episodes. The three memory policies correctly remained in cold start; their economic hypothesis has not yet been tested with sufficient training days.

Read the [protocol frozen before payload access](ALGORITHM-FOUNDATION-PLAN-v38-20261031.md), [exact source cohort](ALGORITHM-FOUNDATION-COHORT-v38.json), [aggregate evidence](ALGORITHM-FOUNDATION-EVIDENCE-v38.json), [selective news context](ALGORITHM-NEWS-CONTEXT-v38-20261031.md) and [continuation checkpoint](ALGORITHM-NEXT-v39.md). Parent: [v37](ALGORITHM-MEMORY-RESULT-v37-20261031.md); none of v29-v36's negative findings is overturned.

## Actual execution and lineage

The complete acquisition, reconstruction, learning and diagnostic code was published at **`1d4eb395dc7c3f9971d2ecaf5e3644e18c0bf162`** before downloading new price payloads. Exact six [typed v37 definitions](ALGORITHM-MEMORY-PROPOSALS-v37.json), SHA `19237a0f9f465b71d3963e42c5558d198c2602f8b54656ae7d41b8ec6361b892`, were retained. There were zero fitted variants or threshold/fee searches. The old v30/v34 source allowlists retain their defaults; a reviewed adapter supplies the new explicitly registered cohort.

The first finite batch used **July 1 only**, the first of the twenty registered July archive-day labels. All eight original anonymous official OKX files were acquired and checked: two executed-trade ZIPs, two 400-level L2 TAR.GZ files, and four NEAR/SOL/BTC/ETH candle ZIPs. Compressed originals total **215,484,395 bytes**. Member validation, decompression/CRC where applicable, source identity and SHA receipts are retained. These are original public archives, not a simulation or venue-signed receipt of historical trader access.

The batch completed normally in about seven minutes within its 3,600-second outer bound; acquisition, unpack, extraction, evaluation and both retirement stages have terminal checkpoints. Replayed messages: **1,051,624 NEAR + 2,410,378 SOL = 3,462,002**. No owned worker remains after completion. The 92 frozen dependency tests passed in eight isolated processes, including 11 new source/economic-pipeline tests. No code changed during the frozen run.

First evaluation SHA: **`5e4801ca5deba8e63c9b7f15c56fd30f3604e2339c8a9e9d07b8ddab2c064c7a`**. Acquisition SHA: `59332a0755d005c3f6474792835bb66a61c6af6290e1ffebbe0a87cfed207f81`. All eight original source hashes, per-case feature/L2 identities and completed-stage hashes are in the aggregate evidence. Private first outputs and receipts are preserved.

## Coverage is materially different across instruments

| July 1 decision minutes | NEAR | SOL | Total |
|---|---:|---:|---:|
| Registered | 467 | 467 | 934 |
| Available common features | 171 | 410 | 581 |
| Past trade-span/freshness unavailable | 238 | 0 | 238 |
| Already crossed absolute price band | 27 | 26 | 53 |
| Reset/quote exclusion | 31 | 31 | 62 |
| Coverage | 36.6% | 87.8% | 62.2% |

The 238 NEAR exclusions come from the unchanged causal trade-span rule, including its five-second past-print freshness requirement; they do not prove corrupt archives or absence of trading. This is a coverage limitation of the representation. It must not be hidden by analyzing only successfully reconstructed signals. Twenty calendar files may still leave individual memory states below twenty observed prior-day blocks.

Both original feeds lack sequence identifiers in the replayed rows. Sequence continuity and actual network receipt latency are therefore not certified. Snapshots are handled as source resets rather than repaired into uninterrupted flow.

## All six programs: economic and event diagnostics

| Program | Alarms | Mean historical quote proxy after hypothetical 20 bp fee | Early detected / retrospective episodes | Missing quote paths |
|---|---:|---:|---:|---:|
| Liquidity payoff memory | 0 | Not estimated | 0 / 3 | 0 |
| No-incremental memory ablation | 0 | Not estimated | 0 / 3 | 0 |
| Price payoff memory | 0 | Not estimated | 0 / 3 | 0 |
| Rank liquidity | 26 | **-29.9189 bp** | 0 / 3 | 0 |
| Rank flow | 28 | **-19.6359 bp** | 0 / 3 | 0 |
| Cash | 0 | No exposure | 0 / 3 | 0 |

The two rank programs' episodes can overlap; 54 alarms are not 54 independent statistical trials. All three retrospective episodes were defined before liquidity exclusions, one on NEAR and two on SOL. There were no qualifying early detections, so warning time is undefined rather than zero. All 26/28 rank alarms were unmatched to that early-warning definition. Unmatched does not automatically mean an economically losing quote scenario.

| Instrument / control | Alarms | Mean quote proxy, bp | Additive quote-proxy drawdown, bp |
|---|---:|---:|---:|
| NEAR rank liquidity | 10 | -17.6647 | 315.0330 |
| SOL rank liquidity | 16 | -37.5778 | 614.8714 |
| NEAR rank flow | 9 | -23.1571 | 275.8460 |
| SOL rank flow | 19 | -17.9680 | 430.5495 |

Drawdowns are chronological additive fixed-notional historical quote diagnostics, **not account-equity drawdowns or actual trading losses**. Minute-close barrier labels and quoted execution diagnostics are stored separately. In the price-only barrier labels, rank liquidity had one adverse and 25 censored alarms; rank flow had 28 censored alarms. Censored does not mean safe, profitable or an unknown quote path.

Liquidity memory and its ablation each collected **15 matured labels** (5 NEAR, 10 SOL); these are the same labels, not independent samples. Price memory collected **31** (7 NEAR, 24 SOL). No scheduled labels were missing. At every queried decision there were **zero earlier UTC day blocks**, because the current day cannot train its own action. Candidate nonzero proposals: 310, all COLD_START; 271 zero proposals. Price memory: 521 COLD_START and 60 zero proposals. No floor was relaxed to manufacture trades.

The memory hypothesis is therefore **unpowered, not economically rejected or validated**. Only **1/20** source days is complete. The frozen uncertainty routine returned `UNPOWERED_FEWER_THAN_20_DAYS`; no confidence or positive-expectation claim is made. Even twenty days do not guarantee adequate state support or stationarity. The deletion-of-two-best-days rule remains an empirical development statistic, not a confidence bound.

## Counterexample, market background and news

The worst rank-liquidity quote scenario was a **SOL short at July 1, 14:02 UTC**, with **-205.7963 bp** after the hypothetical 20 bp fee. It is a concrete failure example, not a hidden excluded trade. A separate explicitly **POSTHOC** context calculation reused the unmodified v30 helper on all 54 rank alarms, with all original candle hashes pinned. Its output SHA is `2b42e1cfa1881564f8210d10ced690e3cd03aca4762d5d28fe723a243c4f78fd`.

In that helper's fifteen-minute close-to-close context, SOL rose **146.6121 bp**, while the equal-weight BTC/ETH reference rose **115.0884 bp**; SOL's excess was **31.5237 bp**. This shows a substantial common-market component in the adverse short episode. These context returns begin at the helper's original T-origin close and differ from the delayed, path-dependent quote evaluator. They cannot replace its result or establish executable hedged alpha.

Across all alarms, mean signed fifteen-minute excess over that same BTC/ETH reference was NEAR rank liquidity **+1.8805 bp**, SOL rank liquidity **-7.2389 bp**, NEAR rank flow **-3.7450 bp**, SOL rank flow **+0.4405 bp**, before any claim of executable costs. No positive context fragment rescues the negative quoted-control results.

The [news register](ALGORITHM-NEWS-CONTEXT-v38-20261031.md) verifies issuer-wire publication clocks for ADP at **12:15 UTC** and ISM at **14:00 UTC**. The adverse SOL signal occurred two minutes after ISM's timestamp. BLS also scheduled a release at 14:00, but actual first access is UNKNOWN. A Solana Foundation article is dated July 1 without a verified publication hour, so it is excluded from timed matching. NEAR-specific and complete synchronized news coverage remain UNKNOWN.

This is temporal context, **not a causal attribution to ISM, an exhaustive news history or a retrofitted predictor**. The context was assembled after the strategy/source freeze and did not alter any first result. Wire publication clocks do not certify the globally earliest information arrival or trader receipt. Historical OI, liquidations, funding, full news availability and additional slippage remain UNKNOWN where provenance is absent.

## Source-admission audit and retained limitations

v37's rejected August proposal was not fetched. The new audit found no claim-like metadata files in the **35 registered research worktrees plus research archive**, including case-insensitive hidden/ignored filename searches. All five protected original-price manifests remain pinned. July raw-file spans for the relevant known BTC/ETH/SOL manifests lie wholly inside their first-60% training regions, and old report metadata records development-only access where explicit flags exist.

This justified **project-scoped DEVELOPMENT source admission**, superseding the provisional July acquisition block in v37. It does **not** prove global registry completeness, absence of an outside claim registry or an unseen NEAR dataset. It grants no independent-data certification. Both the known old price research and the current source limits forbid relabeling these cases as independent validation. A future independent test still needs an audited persistent one-use claim and known closed boundaries.

September 5, November 1-12, known protected tails and adjacent UTC+8 archive overlaps remained closed. No protected outcomes were opened to perform this metadata audit. No scientific novelty is established for the known delayed-feedback, liquidity-accounting or block-resampling primitives.

## Storage and exact continuation

After successful evaluation, the two new derived spools totaling **1,345,543,019 bytes** were retired under the frozen policy only after checking original, spool, index and evaluated-feature hashes and preserving exclusive retirement decisions/receipts. Original compressed bytes, source receipts, indexes, feature caches and first evaluation remain available. No older experiment or unrelated files were deleted. About 39.94 GiB remained free after this batch.

Next: the unchanged chronological pipeline's **July 2 batch**, then the remaining registered days. Reuse July 1's verified caches for learning; do not reconstruct retired old spools or overwrite any first output. Check live state and jobs first, use a separate research worktree, verify exact code/proposal/spec identities and earlier COMPLETE checkpoints, then launch only one finite next batch. The [v39 checkpoint](ALGORITHM-NEXT-v39.md) gives the precise command and limitations.

Two evaluated markets and one training day cannot establish portability. At least fifty point-in-time verified markets, time separation, survivorship safeguards, a newly closed independent test and independent forward observation without orders remain required. Historical quote crossing and a hypothetical fee do not establish actual applicable fees, receipt latency, tradable size, funding, slippage or executable expectation. No orders, Trader/PAPER sessions, risk/accounts/keys/provider changes, paid data, new automations/services, other projects, main edits, PR merges or deployments occurred. The lease is released after checkpoint publication.
