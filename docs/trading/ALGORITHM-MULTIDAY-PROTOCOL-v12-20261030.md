# Algorithm Discovery v12 — multiday, provenance-first research protocol

**Preregistered 2026-10-30 UTC. This protocol and evaluator must be committed and tested before any NEW v12 source observations.** Research branch only. No authenticated exchange calls, paid data, PAPER/live orders, autonomous monitor, scheduling, or merging to main.

## Why the program is being reorganized

Registered v6 OI/funding, v7 book/taker and v9/v10 dynamic microstructure probes produced *negative one-time pilots*. v11 recorded four valid public-source captures but no eligible primary signal, and the forward-quote source was **blocked**, so v11 is INCOMPLETE, not a negative economic backtest. Retuning those data would be data mining. Short 8-second same-day samples are not enough to decide whether a mechanism generalizes. This new version establishes a verifiable multi-day data collection, honest group holdout, and validated outcome-input gate BEFORE proposing profit claims.

## Immutable calendar split and frozen universe

All dates are UTC, not browser locale. A **12-calendar-day manual cohort, 2026-11-01 through 2026-11-12**, with fixed parts:

- **Development 2026-11-01…11-06 (six days):** inspect hypotheses and data issues; all results exploratory.
- **Validation 2026-11-07…11-09 (three days):** compare one frozen candidate and baselines. No refitting after seeing validation.
- **Locked holdout 2026-11-10…11-12 (three days):** analysis authorized only after a distinct deterministic model-freeze file is committed before Nov10. No lookahead/hindsight extraction of extra symbols or dates. If model lock missing at that date, HOLDOUT UNUSABLE.
 
Initial candidate universe is exactly the 50 dated members from source file `universe-50-20261029.json` (not historically survivorship-certified), SHA-256 **3193fcab0a38e6a881d5b26e28efb1db59e60a0e051a8084112a19f53274a9d3**. The roster is not a guaranteed live instruments list; unavailable candidates are recorded as missing, not replaced. On day index i=0..11, exactly **five ranked symbols** are assigned with indices `(5*i+j) mod 50`, j=0..4; therefore the first ten days cover all 50 once, and days 11–12 revisit the first ten. The plan is locked against schedule changes. Failure, API changes and blocked observation streams count as explicit missing attempts.

Each authorized observation is an explicitly user-invoked bounded 8s pair of public OKX WS source streams, with `books` sequence integrity + `trades-all` per-fill messages, existing v8 SHA-verified raw capture and audit, and receipt timestamp. Observed 8s event must lie within assigned UTC day. The current trade feed still does NOT certify lossless/gapless trade sequence or total order with the book. No claimed maker identification, fill-to-quote matching, or smart-money identity. The ordinary book is not complete RPI depth.

## Provenance and chronological entry gate

For every assigned day+symbol register **only one** original source capture (or an explicit failure). The registration process **independently** verifies `build_buckets` from raw source files and replays book updates, and records exact source `manifest.json` and `messages.jsonl` SHA-256. It cannot overwrite a prior entry. The append-only local journal uses hash-chained individual entries (SHA of previous entry + canonical entry payload) and atomic exclusive file creation; a run refusing malformed/missing evidence must not mutate the journal. The audit verifies each existing source SHA against current local source bytes; missing originals are not silently accepted.

**Observation is not an outcome.** Exact future labels must come from a separately authorized, read-only, source-verifiable **external evidence file**, provided later with original bytes, complete request/receipt timestamps, exchange-time quote timestamps, symbol, and explicit evidence that this is a post-observation source. Do NOT use the blocked v11 forward-quote operation, substitute historical candles, fabricate a midprice, or use unverified third-party screenshots. If appropriate authorized outcome source remains unavailable, status stays `UNLABELED/UNSCORABLE`. An external file name and declaration alone do not establish an authentic exchange receipt; such evidence is labeled unverified until the source's integrity can be checked. No automatically collected future price source is authorized by this protocol.

A registered source may not enter a future score until (1) original source integrity verified; (2) an independently retained exit receipt exists whose exchange generation and local full receipt times are strictly later than the frozen observation end and later than a future horizon registered in a **model-specific** protocol; (3) no outcome file is used in signal selection or thresholds; and (4) the forward-input is attributed to its actual source and immutable hash. Authentic provenance is crucial; cryptographic hashes alone only detect local mutation and do not certify who generated an external price.

## Model freeze, baselines and economic relevance

**NO MODEL OR PROFITABLE SIGNAL IS APPROVED BY v12 PHASE 1.** Development-stage exploratory feature families may include within-market persistent taker flow, quote depletion/readdition and controls. Before validation and holdout, one explicit deterministic feature/eligibility code and exact horizon MUST be frozen by a source-committed model lock, including source code commit, inclusion rule, null baselines, and allowed quote source. No after-the-fact choice of the best direction, minute vs second, favorable symbols, dates, spreads, or fee stress. Baselines will include always-cash, taker-only, price-only and market beta where authentic contemporaneous data permit.

**If** independently sourced executable bid/ask quote snapshots are available, conservative scenario metrics will use buy at observable ask, exit at observable bid (or short at bid, cover at ask), accounting for spread; 5bps taker fee per leg (documented OKX typical example; NOT the user's verified fee), stress 7bps per leg, plus slippage sensitivity. Exact fee treatment uses entry and exit notional; don't claim that these snapshots are fills. A genuine feasibility gate also requires venue instrument spec at time: `ctVal`, `ctValCcy`, `lotSz`, `minSz`, `tickSz`, fee tier, funding, mark/index and leverage. Without them, scores are **proxy only**, not realized futures PnL, liquidation safety, or executable strategy.

## Decision gates (necessary, not sufficient)

- Minimum before *generalization* discussion: >=30 independently separated market-time blocks over >=10 UTC days, >=100 qualifying source events from >=20 different markets, preserved negative/zero/unlabeled observations; block-clustered, multiple-test-aware uncertainty and truly out-of-sample holdout.
- Compare costs, confidence and controls; not mean alone. A positive outcome from three holdout days would still be preliminary.
- Enforce correct split by **day**, not random event-level train/test mixing. No overlapping windows; report clustering by date/market and optional exchange regime labels if independently timestamped.
- Market universe PIT membership is NOT authenticated, so no claim of survivorship-free backtest.
- If the future quote source is blocked or not trusted, label the study **SOURCE_ONLY**. Do not automatically switch endpoints to bypass tool safety or shift measurement horizon.
- Paid services, unattended watchers, auto-trading, PAPER account actions, credentials, main merge and automated scheduling are EXCLUDED. Each short capture remains manually authorized in the chat. A multi-day plan is NOT a background task.

## Output of this phase

Implement and locally test an immutable twelve-day calendar, exact five-per-day fixed symbol plan, complete source audit/registration with hash-chained registry, per-day data completeness and holdout seal readiness reports, and clear placeholders for missing outcomes. Existing v6/v7/v9/v10 negatives and v11 incomplete remain archived as **PRIOR_EXPLORATORY** and MUST NOT enter the v12 November validation/holdout evidence.

No claim of newly discovered profitable algorithm before credible independent post-observation labels and multiple-day validation.
