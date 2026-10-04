# P10 — Scoped transactional paper ledger storage (NOT an executor)

Status: stacked **DRAFT** after P9 / PR #10. Adds Prisma models and a migration to the repository; migration has **not** been applied to the user's local PostgreSQL. No trading exchange connection, broker API key, paper-order runner, wallet, RPC/MCP/Plugin R route, active outbox consumer, Windows Host action, scheduler or deploy.

## Persistence model

- `TradingPaperLedger`: one Rakazo `spaceId` and `ownerUserId` (both FK with cascade), exact initial virtual cash, single quote currency, monotonic revision, derived book-value projection + digest and head hash. Creation checks active space membership **in the same serializable transaction**. No real-money balance or exchange account reference.
- `TradingPaperLedgerEvent`: composite primary key `(ledgerId,sequence)`, extra unique `(ledgerId,eventId)`, normalized Zod-validated JSON payload, its SHA-256, previous chain hash and chain hash, timestamp. Append-only via db-only service API (no mutation/delete method); any external DB admin still has power to change/delete rows, so hashes are integrity checks, **not signature/proof against a privileged attacker**.
- `TradingPaperLedgerOutbox`: composite `(ledgerId,sequence)` FK to journal entry, `pending` by default. Created atomically with the journal and its updated book projection. No dispatcher/consumer and **not an order queue**. Later notification-delivery marking needs a separate reviewed capability.

## Write algorithm and isolation

`createTradingPaperLedger`, `readVerifiedTradingPaperLedger`, `appendTradingPaperLedgerEvent` are **db-only, trusted-service primitives**. They assume the calling Rakazo application has authenticated the actor (model text is NEVER an actor). There is no user-visible call path in this PR. Every read/write checks space membership and strictly filters by ledger, space and owner.

1. In one **serializable transaction**, fetch all up to 10,000 events in ascending sequence; verify count/revision, Zod normalized content, recorded time, SHA-256 of each canonical payload, previous/head chain, reconstruct via P9 BigInt ledger and compare entire saved projection plus digest. If ANY mismatch, halt before changing money.
2. For an already seen `eventId`, accept only **bit-for-bit equal normalized typed content**, returning `duplicate` without event/outbox/projection changes. A different payload with the same ID is a hard conflict.
3. For a new event, require `sequence=revision+1` and successful P9 full replay including every risk-independent accounting check, then `updateMany` compare-and-swap against id/space/owner/revision/head hash. Require exactly one updated row; insert the event and inert outbox entry in **the same transaction**. Rollback on any failure. Existing Rakazo `withTransactionRetry` retries only recognized serializable/deadlock conflicts.
4. The DB unique indexes are a second line of defense. Conflicting racing writers do not silently create two spends; concurrent calls must retry/reload or report conflict. Historical `createdAt` is server-produced; caller `recordedAt` is currently a synthetic journal timestamp and **not attested wall-clock time**.

## Explicit safety and deployment gates

- P9 journal models only exact full fills, active SPOT, no short/futures/leverage/partial fills, one quote currency, eight-digit fixed decimal and synthetic fill inputs. P10 does not magically grant fill-source authenticity, market liquidity or order-execution authorization.
- P6 inert paper risk preview is **not an authorization token**. A future authenticated **Rakazo Paper Worker** (the existing Rakazo runtime, no separate control plane) must own server-issued event ID, independent risk envelope/kill switch, trusted virtual snapshot, persistent idempotency key, concurrency and fill policy. The storage helper must not be exposed directly to AI/RPC.
- Migration must be applied only after review, backup and an explicit local-environment action. Draft branch CI integration tests may use an isolated disposable DB; this does not imply a local user migration.
- Before first recurring paper simulation: validate genuine PostgreSQL parallel-writer races and restart reconciliation in an isolated integration suite, define an authorized outbox delivery policy, quote freshness, order TTL and stop handling. Before any real trading: entirely separate instrument/margin/venue/legal/risk permissions and affirmative approval.
- To fix the inherited repo-wide red CI, isolate the unrelated original Windows Host/adapter Biome errors and mobile Expo patch mismatch into a separate small maintenance PR, independent of all Trading data and execution logic.

## Tests

New in-memory transactional harness exercises owner/membership, accepted event+projection+outbox atomicity, no-op identical retries, conflict/revision refusal, chain/projection tamper halt, recovery and rollback on outbox failure. The CI Postgres journeys applies migrations to a disposable environment, but these mocks alone are **not proof of true PostgreSQL concurrent-writer safety**; that must be tested directly before enabling a Worker.
