# P9 — Deterministic paper spot ledger: events, reservations and recovery

Status: separate stacked **DRAFT** after P8 / PR #9. Pure synthetic, offline code only. No real or simulated broker service starts, no trading keys, live/paper orders, database migrations, RPC route, Worker schedules or host changes.

## Implemented event contract

`TradingPaperLedgerInputSchema` contains one explicitly identified paper-only journal, immutable starting quote balance, quote currency, opened-at timestamp and an append-only ordered event stream. Four event types are supported:

| Kind | Intended virtual effect |
| --- | --- |
| `reserve` | Holds a positive quote ceiling for one unique signal/reservation and one exact active SPOT instrument, quote currency, lot precision and expiry. Does not place an order. |
| `release` | Returns unused reservation money to available balance exactly once. |
| `fill_buy` | Consumes exactly **one full lot** and the matching open reservation before expiry; checks tick, cost plus explicit quote fee within held ceiling, returns unused quote and creates a virtual position. |
| `fill_sell` | Fully closes exactly one matching position, credits sale proceeds less explicit quote fee, records realized cash PnL net of **both** entry and exit fees. |

There is **no partial-fill, short, borrowing, leverage, futures, DeFi, currency conversion, external API, broker/DEX adapter or execution permission** in this slice. No records are fabricated from incomplete or untrusted exchange responses; fills are synthetic journal input requiring future trusted supervision.

## Exact accounting and idempotency

- Decimals: bounded canonical decimal strings with up to eight places. The reducer uses fixed-scale `BigInt` (1e8 quote/base) for all quantity, price and cash arithmetic, **rounding buy costs up** and sell proceeds down to the smallest modeled quote unit. It does not accumulate IEEE-754 monetary errors. Inputs with unsupported precision fail validation; this is **not** a universal exchange order sizing library.
- `eventId` is unique within a journal. A retry with the **identical normalized event** including sequence is a no-op even after later events. Reusing an existing ID with any different payload fails closed.
- Every *newly accepted* event requires the exact next contiguous sequence and nondecreasing source timestamps; wrong ledger, replay fork, duplicate reservation/signal identity, use-after-release, sell-twice and expired buy are all rejected. A signal cannot consume a second reserve even if the original was released.
- Required conservation invariant after **every accepted event**: `availableQuote + reservedQuote + openCostBasisQuote = initialBalanceQuote + realizedPnlQuote`. An open position is tracked at *historical acquisition cost including entry fee*, not at market price. `bookEquityQuote` is a book-value figure, **not** mark-to-market equity, realized profit projection, collateral or a risk-control decision.
- Replay from the same normalized event stream reconstructs the same result, without a mutable singleton or hidden external dependency. The output counts accepted events and no-op retries separately.

## PostgreSQL/Worker gates (NOT implemented by this PR)

The future trusted Rakazo paper Worker must be the **sole** append authority, never a model-provided array. It should use a journal table with a unique `(ledger_id,event_id)`, unique `(ledger_id,sequence)`, immutable normalized payload and checksum, server-issued timestamps, and a transactional append / balance reservation with a locking or compare-and-swap protocol. A transaction must atomically persist event + reserved money + position state + outbox notification and reject version conflicts. Retries must compare identical payload fingerprints, not silently treat conflicting IDs as successful. On restart, read ordered events, independently reconstruct via `replayTradingPaperLedger`, reconcile stored projection/available+reserved+positions and halt on mismatch before any further paper operation.

The **P6 risk preview is not a permission token**. Only a future authorization/approval and trusted snapshot in Rakazo may permit the Worker to append a `reserve` event; the pure reducer has no way to authenticate an event producer. With 10,000-event bounded replays, a larger history needs verified archival/snapshot policies, hash chaining and periodic independently checked checkpoints; the current reducer has no long-term persistence/replay optimization.

## Acceptance

Synthetic offline tests cover reserve, buy/refund, close/net fees, conservation, identical retries, collision refusal, replay recovery, time/sequence consistency, signal reuse, double sell, cash overspend, expired fill, quote/mode mismatch, lot/tick and conservative sub-cent rounding. Require exact-head unit tests, TypeScript checks and Biome before promotion; any remaining inherited base-branch CI failures must be reported separately.

Source-code integrity tests are **not** exchange KYC or region eligibility, paper execution profitability, guaranteed risk limits, operational readiness or live-trading authorization. No application installation or real balance was changed.
