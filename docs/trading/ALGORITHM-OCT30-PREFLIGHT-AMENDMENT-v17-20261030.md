# Algorithm Discovery v17 — source-clock tolerance amendment after BTC source acquisition

**UTC 2026-10-30, AFTER original BTC 01 source but BEFORE ANY future quote/outcome, and before SOL 01 source.** Original BTC source manifest SHA-256 `06b81b5caaa9b3fce3a59331736ff115a20be1e9aeea8681e2f671c420065d6d`, 131 original logical messages, raw window `1793363760238–1793363768247` UTC milliseconds (duration 8009ms).

The v17 pilot code erroneously asserted an EXACT `end-start==8000` milliseconds for the existing source tool's approximately 8-second operation. The source logger actually records independently sampled local receipt timestamps with small scheduling differences. The rule was corrected to accept `7500 <= end-start <= 8500` milliseconds while still requiring both start and end belong to 2026-10-30 UTC and demanding unchanged SHA+sequence-verifiable raw WS source. **This is a POST-CAPTURE instrumentation amendment**, so strict fully immutable pipeline must NOT be claimed. The two registered v14/v15 AI hypothesis definitions, source-second features, signs and market prices were NOT altered, nor was any future quote/result inspected. Keep BTC attempt visible, do not replace/rerun it for a favorable score.

All resulting v17 outcomes remain source-only unlabelled exploratory observations; no trading, no PAPER or comparison to independent forward profitability.
