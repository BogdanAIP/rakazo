# P11 — Trusted Paper Worker and independent Risk Manager: implementation gate

Status: **P11A and P11B-0/1/2/3 deny-only prerequisites are in a stacked DRAFT**, while actual transactional reserve and P11C remain acceptance contracts. PR #11 / P10 genuine isolated-PostgreSQL race suite passed on exact head `ae49879289dc823e6f2ebf86c381e8adcfcd9ff6`. This document does not install, schedule, activate or authorize any worker. Neither live nor simulated exchange-order execution exists.

## Ownership and trust boundaries

- Reuse **one Rakazo**: its existing authenticated user/space model, PostgreSQL + Prisma, existing Rakazo Worker, job recovery, audit, and configured public market-data adapters. No second trading server, CAP/OpenResearch, extra tunnel, unowned background service, direct LLM -> database mutation, exchange keys, wallet signing or broker/RPC order endpoint.
- P6 `evaluateTradingPaperRisk()` is a **research preview**: it accepts caller-provided portfolio and uses bounded JavaScript number math. Its `paper_preview` output is never an approval, an order intent or authority to reserve virtual funds. P9 is synthetic full-fill spot accounting; P10 is a trusted-service DB primitive, not a public AI tool.
- The Paper Worker must be invoked only by an authenticated Rakazo runtime action with owner/space scope, durable idempotency key and a *separately user-authorized, disabled-by-default* paper capability. AI outputs remain untrusted signal proposals, including NO_TRADE.
- Only deterministic server code assigns event ID, sequence, event timestamp, simulation IDs and the source observation reference. A model cannot supply actor identity, policy, privileged idempotency keys or its own approval.

## P11A — Persist owner-scoped paper policy, default DENY (first code slice)

Implemented schema, migration artifact and DB-only create/read service in `packages/db/src/trading-paper-risk-policy.ts`. There is deliberately no policy enable/update endpoint. Store a policy in existing Prisma schema scoped to one ledger, space and owner. Initialize `enabled=false` and `killSwitch=true` with a monotonically increasing revision and audit record; no implicit enable or migration of the user's working database. Enforce membership and policy ownership on every read/change.

Required bounded fields include paper-only mode, allowed active spot venues/instruments and one quote currency, max total exposure, risk/idea, cumulative day-loss, open stop-risk, positions, per-order cash, quote age, spread, trigger deviation, conservative fee/slippage assumptions, and time-limited signal/reservation eligibility. A policy change is an authenticated user action: neither LLM, backtest, market feed nor paper strategy can raise or disable caps. A kill-switch changes revision and blocks every subsequent reservation; existing outstanding reservations need a separately audited release/reconciliation path.

Persist rejection/audit records with candidate/signal ID, ledger and policy revisions, source observation and human-readable reason. Do not persist raw external credentials or private client data.

## P11B-1 — conservative exact sizing and offline quote evidence

Implemented `estimateExactPaperSpotCapacity` in core: eight-decimal BigInt arithmetic, conservative adverse rounding of both sides' fees/slippage, quantization down to instrument lot size, and independent available-cash/exposure/per-idea/daily/open-risk caps. Its `inert_estimate` is a display/research calculation, **not** an authorization, and cannot reserve anything. Market evidence is stored in the existing PostgreSQL via a separate repository-only migration and internal `trading-paper-quote-evidence.ts`. The initial source is strictly `offline_fixture`, enforced by SQL CHECK: origin is *not attested*, there is no network ingestion, no public tool access and P11B preflight continues to deny `trusted_market_snapshot_unavailable`. Record/read validate owner scope, bounded timestamp freshness at ingestion, eight-decimal bid/ask and SHA-256. Integrity hashes are not security against privileged DB edits. Genuine connector provenance, stale checks **at decision time**, matching exact instrument metadata and explicit user paper approval remain blocking requirements for transaction-bound reserve.

## P11B-2 — source-labeled public observation, without execution authority

The same inert PostgreSQL evidence table additionally supports `public_adapter_observation` with a separately stored normalized market, tick/lot/min-notional metadata and normalized ticker. A SQL CHECK preserves a strict split: `offline_fixture` requires null market metadata, public observations require market metadata. The SHA-256 binds source, market, bid/ask and timestamps; membership, owner and quote-currency match are checked in the DB service. **This is an application-level record of a public API response, not a cryptographic attestation from an exchange.** A DB user with privileged write access can still forge the evidence. No stored quote is an approval or authorization and `preflightTradingPaperReservation` remains deny-only. Market freshness and spread will need re-validation in the eventual transaction-bound decision, using a trusted server clock.

## P11B-3 — exact market revalidation inside the deny-only transaction

The preflight takes an **explicit lookup-only** market-evidence ID (never inferred from an AI signal's evidence IDs), and verifies the public row, owner, source label, integrity SHA and exact market metadata within the SAME serializable P10 replay + policy snapshot. It rejects missing or offline evidence, instrument mismatch, quote staleness (using `Date.now()` at decision time), signal expiry, excessive spread and trigger deviation. Spread/deviation comparisons use bounded BigInt decimal units and conservatively reject unsupported fractional-bps inputs. Even when every check passes the result is always `risk_state_unavailable` (deny): no durable mark-to-market stop-risk, daily-loss reconciliation, authenticated enabling or reserve authorization exists yet. A source label or checksum is not a cryptographic attestation from an exchange. Neither preflight nor evidence reads write an event, reservation or outbox entry.

## P11B — One serializable **evaluate + reserve** transaction


**P11B-0 implemented:** `preflightTradingPaperReservation` is an inert deny-only prerequisite. It full-replays the P10 ledger and digest-verifies the P11A policy within a **single serializable transaction**, enforces the scoped owner, and returns revision-tagged denial without balance, event, outbox or order mutations. It refuses disabled policies, kill-switch, invalid/NO_TRADE or unsupported signals, unreconciled positions and reservations, and missing trusted market provenance. Both internal verified readers are deliberately not exported via the DB package index. P11B-0 is **not** evaluate+reserve: there is no enabling operation or trusted quote store yet. The following acceptance steps still gate any actual reservation.

An ordinary sequence of `readVerifiedTradingPaperLedger()` followed by `appendTradingPaperLedgerEvent()` is **not safe**: two workers could both assess stale funds or a policy could be disabled between them. Add a separate internal DB service so the following steps happen in ONE PostgreSQL serializable transaction:

1. Resolve authenticated actor, active membership, disabled/enabled paper capability and the owner-scoped policy from trusted database state. If unavailable, reject without money mutation.
2. Load the P10 row and replay/verify *all* events/hash/projection **within that transaction**, never trust cached balance or signal claims of available cash.
3. Validate normalized research-only signal, its expiry, supported active spot market and vetted public bid/ask provenance. Use server clock and bounded freshness; reject missing/stale market data, future times, NO_TRADE, quote/venue/policy mismatch, market halt and any unsupported precision.
4. Build risk inputs from verified persistent state, not a caller-supplied P6 portfolio. P9 stores book-cost but **not an attested per-position stop or daily risk snapshot**; until stop and loss-reconciliation data are genuinely persisted, fail closed whenever the ledger has existing positions or reservations. Do not assume zero exposure or invent stop-risk fields.
5. Independently cap risk; use exact-decimal/BigInt for executable virtual amount, quantity increment, fees and worst-case held amount. P6 floating-point previews may inform display but cannot authorize or size the DB reservation. Deny if any required risk input is unrepresentable.
6. Recheck the policy revision/kill-switch and P10 ledger revision/head with CAS. Insert an inert `reserve` synthetic event, its rebuilt projection, decision audit and paper-notification outbox atomically. Identical durable idempotency keys return the existing result; conflicting reuse fails closed.
7. On serialization failure, retry the whole verification/decision transaction up to a bounded limit. Never retry just the write using a previously approved result. A failed/rejected attempt may generate an audit-only record but must not modify virtual money.

The outbox is a notification, **not** an exchange order queue. No RPC/MCP/plugin endpoint may expose raw `appendTradingPaperLedgerEvent` or accept AI prose as approval. No silent paper-job enablement.

## P11C — Bounded synthetic lifecycle, separate gate

Start with reservation and explicit expiry/release under a trusted clock. Synthetic fills must be reviewed separately: quote observation time, conservative spread/slippage/fee model, full-lot-only behavior, tick/lot precision, no backdated or expired fill, no asserted fills from research output, no retries after uncertain outcomes, and restart reconciliation. An indicative stop is not an exchange stop; real-time market equity/daily loss requires a defensible persisted mark/stop model. Perpetual/dated futures, leverage, shorts, DEX, DeFi, actual paper exchange accounts and any **live** orders are out of scope.

## Acceptance before enabled paper scheduling

- P10 exact-head genuine isolated-Postgres races and restart reconstruction pass. Tests distinguish independent DB sessions from two separate OS processes; add a process-level stress gate if required by deployment topology.
- Two independently connected workers race the same candidate: at most one reserved hold and one outbox; same idempotency key replays without mutation. Distinct candidates racing the last virtual cash cannot both spend it.
- Revoked owner/space, stale quote, expired signal, unsupported market/precision, changed policy, disabled capability, kill-switch, tampered hash/projection, missing persisted risk and outbox failure cause no partial money mutation.
- Restart/recovery rebuilds the identical virtual ledger, audits and outstanding reservation set; outbox delivery cannot place any order.
- All changes have unit, disposable PostgreSQL integration and rollback tests, named ownership and traceable denial reasons. Application code and SQL migration require review, backup and explicit local action. No merge/deploy, exchange secret collection or runtime activation is authorized by this design.

## Follow-on sequence

1. P11A policy schema, migration and authenticated write restrictions (default deny).
2. P11B transaction-scoped risk decision + synthetic reservation, CAS/idempotency and concurrency tests.
3. P11C expiry/release, kill-switch reconciliation and restart consistency.
4. Explicitly reviewed fill simulator and user-opt-in paper scheduling — **only after** the preceding stages pass. A separately approved live execution project must have independent instrument/venue/legal/financial safety gates.
