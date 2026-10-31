# Algorithm Discovery v36 — fixed-price-band accounting development protocol

Status: **DEVELOPMENT on already opened data**, not an independent validation or a new mathematical invention. The [v35 result](ALGORITHM-PATH-RESULT-v35-20261031.md) rejected the event-order candidate on all four panels. The next representation follows [the v36 proposal](ALGORITHM-NEXT-v36.md). Freeze the complete executable code, eight AST scores and this protocol before new band extraction. Preserve first outputs, failures and hashes.

## Question and antecedents

Can directional evidence that remains valid across an interval of possible displayed executions select economically meaningful future moves better than assuming all public executions were displayed, or than observing depth changes alone?

Queue-state models with market orders, limit orders and cancellations are established: [Cont, Stoikov and Talreja](https://www.sashastoikov.com/finance/2015/3/9/a-stochastic-model-for-order-book-dynamics). Deeper-book net-flow representations also exist: [Xu, Gould and Howison, Multi-Level Order-Flow Imbalance](https://arxiv.org/abs/1907.06230). Their contemporaneous equity price-impact evidence does not establish profitable future crypto forecasts. Our absolute-price-band accounting and conditional visible-execution interval are a specific falsifiable construction, not proof of scientific novelty. A bounded internal audit of prior v1/v31/v32/v35 definitions found related flow, restoration and price-response ideas; absence of this exact AST from that small catalog is not novelty.

## Frozen source cohort and geometry

Reuse only the four original October 1/8 NEAR/SOL panels from v34/v35. Original OKX archive day labels have UTC+8 file boundaries; unchanged UTC decision windows are 02:00–09:00 inclusive and 14:00–14:45 inclusive, 467 moments per panel. Source and prior-cache SHA chains are pinned to v34 result `1fedb2058c5612c5bee5e82d60ce31f7d1eb61fdc899e5890f340bda5c697272` and v35 result `c2fd98fc7d153b27faa5c77510f8b56d396509bb4810b3ffd6fee8bf361366f8`. No new download or reserved-period access.

At each scheduled strictly-prior quote T−1ms, copy the best 400 displayed levels. At minute decision T, anchor a band to the midpoint M of the **previous** minute quote. Half-width in log basis points is `w = 20 + 10000*log(previous_ask/previous_bid)`. Band boundaries are `M*exp(−w/10000)` and `M*exp(w/10000)`. Both endpoint observations use these same absolute prices; the band never recenters on the new midpoint. The width references the fixed hypothetical fee plus the observed prior spread; it does not certify the future entry/exit cost or a future price move.

Both endpoint books must span the band using the current best 400 levels, and their best bid/ask must remain inside it. Insufficient depth, an already crossed band, unavailable quotes and snapshot/reset minutes are explicit abstentions, not zero quantities. Preserve exact parity with every inherited v34 quote, restoration bucket and inspected-row count.

Retain original trade prices and contract quantities. Sum buys and sells whose original trade prices lie inclusively in the anchored band and timestamps are in `[T−60s,T)`. Require a strictly earlier print within five seconds of each interval endpoint; future prints and their absence cannot affect this gate. This is a past-observation freshness test, not certification that no historical print was missing. Original archives and trade IDs do not certify receipt latency or complete sequence coverage.

## Conditional accounting features and eight scores

Let `db = Qbid_new−Qbid_old`, `da = Qask_new−Qask_old`, and B/S be observed buy/sell contract quantities in the band. If synchronized total executions upper-bound displayed executions, passive displayed change lies conditionally in `[db,db+S]` for bids and `[da,da+B]` for asks. Feed omissions, incompatible clocks and attribution can invalidate this assumption, so these are **conditional accounting proxies**, never independently certified cancellation/addition identities.

Normalize each endpoint x by `x/(Qold+abs(x))`, preserving endpoint order and sign without a fitted scale. Let f be `(B−S)/(B+S)`, zero if inactive. Buy/sell capacity features are `B/(Qask_new+B)` and `S/(Qbid_new+S)`, comparing completed flow to depth inside the cost-sized band. No forward depletion rate is assumed.

The [eight typed ASTs](ALGORITHM-BAND-PROPOSALS-v36.json) fix one candidate and seven comparators:

| ID | Definition / purpose |
| --- | --- |
| interval-accounting | Long requires negative ask upper bound, positive bid lower bound and positive f, multiplied by buy capacity; symmetric short; subtract short from long |
| all-visible-point | Replace positive-side lower bound with upper bound, assuming every observed execution was displayed |
| depth-delta-only | Use both lower endpoints, ignoring executed volume when interpreting a depth decrease |
| band-capacity-state | Current bid/ask depth imbalance in the same fixed band, without temporal accounting |
| canonical-ofi | Unchanged verified v35 canonical OFI feature |
| flow-baseline | Unchanged full-minute executed taker-flow imbalance |
| depth-baseline | Unchanged top-five depth imbalance |
| return-baseline | Completed-minute return normalized by earlier volatility |

Only reviewed bounded primitives interpret JSON. All states are zero; no dynamic code execution. The AST raw threshold field is retained for schema compatibility; admission uses the unchanged v33 past-only absolute rank: prior 120 available scores, at least 60, midrank at least 0.90, no zero-score direction, no current score in calibration. No sign, threshold, fee, width or horizon optimization.

## Evaluation, exclusions and evidence standard

Every new score shares the same geometry/source availability mask. Report each reason among all 1,868 prespecified decisions, alongside the prior unrestricted v35 OFI/flow/depth/return results. Coverage restrictions must not silently improve a baseline. Candidate-induced abstentions and missed independent price-path episodes remain visible.

Retain one-minute delayed entry, fifteen-minute maximum hold, volatility-scaled first-boundary outcome, crossed bid/ask, fixed hypothetical twenty-basis-point round-trip fee and sixteen-minute cooldown. Boundaries remain `max(20bp,3*sqrt(15)*prior60min_RMS_return_bp)`. Report every program's alarms, adverse/favorable/censored outcomes, missed episodes, warning lead time, quote availability and mean after assumed fee. These are historical quote scenarios, not portfolio PnL. Funding, extra slippage, size, actual account fees and receipt delay remain unknown. Two date blocks cannot support precise uncertainty or transferability claims.

The candidate screen requires at least four alarms per panel, complete quote paths, a positive net quoted mean and superiority over every powered comparator on each of the four panels. Distinguish `INSUFFICIENT_ALARMS`, unavailable paths, nonpositive mean, unpowered controls and no incremental mean. Do not lower thresholds when a conservative condition is rare. Passing would justify a separate newly frozen independent experiment, never establish efficacy. A future rare-opportunity strategy needs a predeclared longer calendar-time protocol; inactive panels are not positive trading results.

The selective [v34 news register](ALGORITHM-NEWS-CONTEXT-v34-20261031.md) remains incomplete. Annotate each alarm with preceding-120-minute scheduled context from the unchanged v34 calendar and mark actual news coverage UNKNOWN. This is a context join, never a predictor or claim about actual news receipt. Historical liquidation/OI/funding coverage and external initiators remain UNKNOWN. No news exclusions or causal explanations are fitted.

## Finite execution and integrity

Run four bounded re-extractions (300 seconds each) and one evaluation (180 seconds), wrapped by an explicit 1,500-second timeout. Require the exact frozen clean git head before launch. Each output uses exclusive create. Preserve failed stages instead of silently rerunning changed code. Sources and full raw outputs stay outside public GitHub. No local services or monitoring, orders, Trader/PAPER/risk/account changes, paid sources, provider changes, main merge or deployment. Reserved September 5 and November 1–12 studies stay closed.
