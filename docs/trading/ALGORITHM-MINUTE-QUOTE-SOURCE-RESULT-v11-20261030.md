# Algorithm Discovery v11 — minute-scale source-lock pilot; NO ELIGIBLE SIGNALS, outcomes unavailable

**2026-10-30 UTC. Research-only. No live orders, PAPER, main branch changes, credential access, paid data or scheduled monitoring.**

## What was frozen before observing data

The complete experiment specification was committed before four fresh WebSocket source recordings:
- Protocol: docs/trading/ALGORITHM-MINUTE-QUOTE-PROTOCOL-v11-20261030.md, Git commit 0061942b7b36b10a83e0b00014ca3659665ef8df.
- Evaluator: scripts/trading/algorithm_minute_quote_v11.py, with pre-source synthetic tests, plus source-lock reconstruction verification in 1c4b9e3b02141ed34e8486ec6eb4d17e5163ece1.

Primary hypothesis is a same-sign imbalance of buy-vs-sell taker contract quantity in the first and second four-second halves of a new eight-second observation. Predeclared completeness includes >=6/8 one-second book+trade bins, >=5 fills per half and fresh final quote. If all qualify, hypothetical direction follows that sign. Marketable bid/ask opening and a single new public book snapshot 60–90 seconds later would support an indicative economic outcome with base 5bps taker fee per side, stressed 7bps per side; NO real fills, contract lots, funding settlement, margin or account-specific fee verified. Controls: flow-only, price-only and cash.

The source uses two public OKX websocket channels with sequence-verified incremental ordinary books and per-fill taker trades. Trade-channel lossless sequence is NOT certified; book RPI liquidity is not necessarily represented. Long-horizon quote acquisition depends on a narrow UTC timing gate; later cached/historical prices cannot substitute.

## Actual four NEW source captures and immutable source feature freezes

All four source recordings were manually captured exactly once, in the preregistered order, with original logical WS messages and SHA-256, and all passed the existing offline WS source/sequence audit. No future quote outcomes were read for this cohort.

| Predeclared capture | Source UTC end | Raw manifest SHA-256 | Source lock SHA-256 | Source quality | Primary H1 |
| --- | --- | --- | --- | --- | --- |
| BTC run01 | 07:55:14.948 | 5fcab7238870d9ac3ecd1b44be57c3ae9a6a6aa9a3c941239d4dd146ff827506 | 2ccc3b91ec00c00b043bce453194b7b37c56d71d0655792bd3ea334c3fd1d225 | PASS 7/8 bins | ABSTAIN: opposite early/late signs |
| SOL run01 | 07:55:36.858 | 1bd8f70f0e928699d79996c9ac588f51f18c8fbde66b167e0fc9669baf90c219 | 67194beb7ea3580166ddf9204c20e2da8d4982f2fb808ef6685964eb8f29baf7 | FAIL feature gate 5/8 bins | ABSTAIN |
| BTC run02 | 07:56:11.037 | bec4775711c5021c4c973863b55e6988973eabd7ee314d7226fe0056b9099677 | 85eeba8182975a268c6eb21b60f827db1b7c088e7d07a28c4416c8c18e1d3efa | PASS 6/8 bins | ABSTAIN: opposite early/late signs |
| SOL run02 | 07:57:04.757 | 8f81d0636ad5e5e767d824823047079b1d1a15e6ea8d9bec503cdc709c5df652 | 130a69a4fc4a9f0631fa9c70501d4a6b4aaa4586e0d509a43691de498e7410fc | FAIL feature gate 5/8 bins | ABSTAIN |

BTC01 taker early buy-minus-sell +97.30 contracts, late −249.86 contracts. BTC02 early +5.65 contracts, late −1209.62 contracts. Both therefore correctly abstain, despite valid source integrity. SOL source quality only 5/8 complete bins, below fixed >=6. All four original source folders and the four frozen source-lock JSONs remain unchanged.

Locally saved research root:
C:/Users/eahra/RakazoRuntime/trading-live-data-20261011/alpha-research/pit-captures/

Folder naming: ws-v11-{btc|sol}-20261030-runNN, and corresponding ws-v11-{btc|sol}-20261030-runNN-freeze.json.

## Forward-price collection and correct experiment verdict

A manually invoked future REST book snapshot operation was blocked by the execution system. **Do not bypass that restriction, use an alternate/private endpoint or substitute ex-post candles**. No original future quote JSON or audited 60–90s outcome exists. The later UTC deadline has passed; a stale snapshot would violate the protocol.

Consequently:
- Valid raw WS source captures: **4/4**.
- Primary H1 candidates: **0/4**, predetermined by source-only data.
- Future exit quotes: **0/4**.
- Observed/estimated H1 profitability: **undefined**, NOT zero, negative or positive.
- Flow-only control: BTC has source-sign candidates but no valid future exit quotes; control return unavailable.
- Scientific verdict: **INCOMPLETE_VALIDATION**, not a negative profitability verdict and not evidence of successful prediction.

The original output file ws-v11-20261030-incomplete-validation.json is retained with exact bytes SHA-256:
47c90b030c814265ddb53a7f217a258718d3a64e483c6ec0bec152ba300799a0.

Do not change sign-persistence, quality thresholds or direction after learning that no signals qualified. Do not rerun an expired source window to "make" it pass. Future samples on different days must be separately registered and honestly reported including failures.

## Practical research lesson

The previous v6, v7, v9 and v10 pilots were negative, whereas v11 yielded NO economic testable event. The sequence-valid source and frozen hypothesis machinery works, but short source windows have substantial eligibility attrition and real-time public outcome gates can fail. A stronger research program needs predeclared larger observation cohorts over different days, a reliable allowed future-source capture workflow, real fee tiers/contract multipliers/lot rounding, funding/slippage/latency and independent block-aware evaluation before any trading deployment.

**Zero orders, zero PAPER changes, zero claims of newly found alpha.**
