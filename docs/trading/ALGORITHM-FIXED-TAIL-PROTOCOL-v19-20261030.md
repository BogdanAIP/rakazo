# Algorithm Discovery v19 — fixed trailing-eight-second hypotheses after 12-second public source capture

**Research preregistration 2026-10-30 UTC — COMMIT BEFORE NEW v19 sources.** Manual/finite source-only pilot, NEVER trading, PAPER, automated collector, paid data or authenticated exchange APIs. v12 November days/holdout and earlier v17/v18 raw sources stay unchanged.

## Why this is distinct from v18

In the separately registered v18 12s *diagnostic* BTC and SOL captures, most one-second bins had book and trade feeds, but no predictions were formed and overlapping 8-second windows were reported only descriptively. **NO v18 historical source may be re-scored as a v19 prospective forecast.**

On a *fresh new source* of exactly 12s, choose a SINGLE eight-second decision window by formula **`[start_ms+4000,start_ms+12000)`**. The first four seconds are quote-state warm-up. The fixed window is seconds **4..11**, never selected for higher completeness, volume, signal magnitude, or favorable future returns. Its final local receipt decision time is the original 12s capture end, not a hypothetical earlier time. Reconstruct visible orderbook state continuously from the original initial full snapshot and all updates before/in the last 8s, including 4s warmup, while restricting *counts, taker flow and price-response features* to the last eight 1s bins. Trade time must be within original synchronized capture and the selected window, local complete-receipt ms strictly after the selected start, respecting exchange timestamp as in earlier audited parser. Preserve whole raw source SHA and preexisting 12s source audit, not fake eight-second original raw files.

## Exact two prospective source attempts

Order: one BTC-USDT-SWAP source 12s, then one SOL-USDT-SWAP source 12s, using `algorithm_capture_12s_v18.py` and public original WS `books` and `trades-all`. Distinct local source directories `ws-v19-oct30-btc-01` and `ws-v19-oct30-sol-01`, one capture per market and **no opportunistic repeats**. Do not change the 6/8 complete-bin threshold and >=5 individual fills per each 4s half in original registered rules.

Read-only raw full 12s data must independently pass `algorithm_ws_12s_coverage_v18.analyze`, including exact manifest/original raw SHA, source ordinals, ACKs, full snapshot, book incremental `prevSeqId→seqId`, source UTC/monotonic timestamps and tradeId integrity. A v19 tail projection independently replays the full source to reconstruct book midquotes and taker flow in EXACT tail eight 1s bins; it does NOT infer missing trades or certify gapless public taker trade feed; v19 tests MUST verify no accidental contamination from earlier 4s.

## Exact previously frozen hypotheses only

1. `flow-memory-flip-20261030`: first vs second half of tail 8s taker flow signs must oppose, but midpoint continues earlier direction; hypothetical future sign `-sign(E)`.
2. `impact-efficiency-decay-20261030`: same-sign half flows and positive then reduced signed midpoint response per net received taker contract; hypothetical future sign `-sign(E)`.

These exact JSON proposals were committed and locally registered before 30 October's sources, so they predate new v19 captures. Use unchanged code `algorithm_ai_research_v14.source_only_signal` with the existing pure `algorithm_impact_decay_v15.impact_decay_signal` dispatcher. No derived new rule, no selection on results, no changes to quote quality or future horizon. Raw source accepted does NOT mean signal qualifies. Results may all ABSTAIN.

## What is *not* established by this test

No verified 5-minute future price source, no execution/funding/fee tier evidence, no performance or alpha, no certification of novelty. Preserve all attempts/failed quality, source-only signals and control samples. No outcome retrieval over blocked REST API, no bypass, no retroactive use of v18 windows or v12 November holdout. A five-minute target relative to original 12s source end remains an *unscored hypothesis*, not a live order. Future L2 archive may be provisionally checked via v16 only after independently establishing true origin/format and a separately preregistered v19 outcome adapter; **do not force a v19 12s origin through v12's eight-second importer.**

A single WS source tested against two hypotheses remains ONE independent market-time source. Manual foreground only. No changes to `main`, active Trader/PAPER/live, automations or credentials.
