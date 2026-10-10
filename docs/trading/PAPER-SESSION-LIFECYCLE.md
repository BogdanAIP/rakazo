# On-demand PAPER sessions — graceful lifecycle specification

Status: **design/acceptance contract only — not implemented or enabled**.
User request: manually start automatic trading when desired; never leave the
research/entry bot trading around the clock; do not terminate a session at an
unsafe point with outstanding reservations, work in progress or open positions.

## One hard rule

**Session expiry = end of permission to initiate NEW exposure, not a forced
liquidation timestamp and not proof that existing activity is settled.**

Do not show "Session completed" simply because its timer expired. Show a
distinct drain/protection phase until the current transactional state has
been re-verified, including already-queued actions.

## Session states

- `idle`: no user-started entry lease; no research/entry wakes are authorized.
- `active`: finite owner-approved lease authorizes bounded new PAPER entry
  attempts (subject to all existing D2/G1/G3/risk/kill-switch checks).
- `pausing`: atomic fence disallows new entry research, reserve and fill,
  invalidates stale queued entry wakes and successor scheduling.
- `settling`: reconcile in-flight synthetic operations and reservations
  against the authoritative transaction/event log. This is **not** a
  successful stop if state is unknown.
- `protection_only`: no new entries, but authorized, bounded protective
  monitoring/close for already-open PAPER positions may continue under a
  SEPARATE protection authority; never reuse an entry lease.
- `finished`: no outstanding in-flight entry operations or reservations;
  all positions flat OR their ongoing protection/ownership is explicitly
  transferred to the separately visible protection-only process.
- `attention_required`: reconciliation, stop attachment or protective
  oversight failed; surface a prominent status and safe user actions.
  Never silently report success or assume zero position exposure.

The expiry timer triggers `pausing -> settling`. It cannot skip them.
The user may choose to end the *entry session* while protection-only
supervision remains visibly active and explicitly approved. Thus the main
trading bot does not need to run 24/7, while risk protection of remaining
positions is not silently abandoned.

## Ledger-aware drain protocol

At Start, create a durable owner-scoped, versioned bounded session lease.
Start requires owner action; no auto-resume after reboot or previous expiry.
Bound by start/expiry timestamp, trade count, exposure and market/strategy
scope. Store an immutable audit of Start/Pause/End/reason.

At Pause/End/Expiry:
1. Commit a monotonic entry-session revision/revocation (the fencing point)
   before announcing the stop. No more NEW signals, reserves, fresh synthetic
   buys or external orders after the fence. Every money-changing transaction
   rechecks the revision in the same serializable transaction; UI-only and
   preflight-only checks are insufficient.
2. Handle an entry transaction already in progress: if committed *before*
   the fence, replay its outcome exactly once; if it commits afterward it
   must fail the session gate. Never roll back an already committed fill
   by pretending it did not happen.
3. Reconcile PAPER Ledger `reserve`, `release`, `fill_buy`, `fill_sell`
   event history, current `reservations[]` and `positions[]`,
   transaction outbox, duplicate/idempotency keys, timeouts and queued
   wakes. Release unfilled reservations under authorized audited
   idempotent transaction paths, not by deleting rows. A reserved amount is
   NOT an exchange order and is not automatically an open position.
4. Do not produce an extra successor for an expired entry session. A queued
   wake with an old session revision remains harmless and denied.
5. If open PAPER positions remain, require a visible choice:
   - stop NEW entries; keep limited `protection_only` monitoring under a
     distinct, time-bounded scope until flat or later manual decision; or
   - request separately approved virtual closes (where risk rules allow);
     confirm resulting fills and PnL from the ledger before finishing.
   Do not auto-sell simply because 2h elapsed.
6. Show exact final status, number of reservations, open positions,
   protected positions, unverified items, next risk check and any blocked
   action. Timeout of settling moves to `attention_required`, NOT
   `finished`.

A `Pause immediately` means immediately forbid NEW exposure, not kill an
atomic transaction or automatically cancel an already-filled position.
A distinct `Emergency risk halt` would require its own explicitly approved
close/cancel policy; it must not be conflated with normal Pause.

## Real trading, if ever separately authorized

This phase is **not implemented**. Future real venue orders have a more
complex lifecycle than the current synthetic PAPER full-fill ledger:
`submitted`, `accepted`, `working`, `partially_filled`,
`cancel_requested`, `cancel_confirmed`, `filled`, `rejected`
or `unknown`. On a stop, cancel the unfilled remainder when appropriate,
re-query the venue authoritatively, account for fills racing cancellation,
and place/verify venue-native reduce-only protective orders as applicable.
Unknown order state cannot count as stopped. Computer/browser/LLM exit
alone is never proof of exchange-side cancellation. Never permit live
access or migrate PAPER approval to live authority implicitly.

## Required implementation tests

- expiry between proposal, reserve evidence, reserve, fill evidence and
  fill; pause during database transaction and queued successor;
- committed fill vs simultaneous revocation and retry;
- stale/duplicated wake/restart from an older session lease;
- active reservation at expiry, partially drained outbox, missing quote;
- open position with/without verified protective stop;
- multiple owners and ledgers; no cross-owner control;
- kill switch, unavailable public data, database disconnect,
  expired protection-only authority and unverified journal state.

Reuse existing worker approval, D11/D12 recurrence, G1/G3 Market Skill/RCCL
approval, B7/G4 synthetic reserve/fill, F4/G5 protection and PostgreSQL PAPER
Ledger. **Do not create another ledger or independent trading engine.**

This document does not activate a worker, place an order, merge a branch,
deploy a service, change the user's Windows machine or install the
deferred desktop journal PR #44.

## H0 — first executable drain decision (2026-10-08)

The shared `@rakazo/core` function `assessTradingPaperSessionDrain`
now contains a **pure read-only fail-closed classifier** over the existing
`TradingPaperLedgerState`. Tests cover:

- verified, fenced, completely flat ledger -> `finished`;
- in-flight work, **unreconciled** (not merely undelivered/inert) PAPER outbox
  data, or reservations -> `settling`;
- open positions with exact independently verified protective-stop IDs
  **and** a separate approved protective supervisor -> `protection_only`;
- missing entry fence, unverified ledger/lifecycle, unknown order states,
  unfenced queued entry wakes or incomplete stop verification ->
  `attention_required` (never `finished`).

Outputs always set `allowNewEntries: false`. H0 cannot grant trading
authority, cancel a reserve, execute a close or enable the Worker. Its
inputs must ultimately come from *transactionally verified* server-side
sources, not from UI-supplied counts or arbitrary user-selected IDs.
Protective supervision is **not yet separated or implemented**; therefore
a runtime must not claim `protection_only` as active today. The caller
must first persist the entry fence and obtain a verified lifecycle and
active protection-only authority, otherwise `attention_required`.

### Existing normal-stop gap found during review

The present `releaseTradingPaperReservationsInTransaction` accepts
only `expired` and `kill_switch` reasons. It is unsafe to call a
kill-switch release when merely stopping a normal manual session.
A dedicated, permissioned, idempotent `session_end` release path and
immutable audit reason must be implemented *after* the revocation
lease exists. No fake release/cancel operation is currently exposed.

### H1/H2 work still required

1. Owner-controlled finite entry-session lease (persisted start, expiry,
   revision, optional virtual trade count/exposure caps) and explicit
   Pause/End fencing, including process restart invalidation.
2. Apply a versioned session lease check *inside* each new reserve and
   synthetic fill transaction and D11/D12 successor scheduling, in
   addition to D2/G1/G3/kill-switch checks.
3. Permit separate, narrowly bounded protective monitoring of already
   open PAPER positions without reopening new-entry permissions.
4. Session-stop release, transaction/outbox reconciliation and owner UI;
   verify races, restarts and ledger integrity with PostgreSQL tests.

**H0 alone is not a safe entry-session controller; do not enable automated
trading based on this classifier.**


## H1a — persisted finite entry lease (2026-10-08)

Added `TradingPaperEntrySession` on the **existing** PAPER ledger in
Prisma + SQL migration `20261008230000_trading_paper_entry_session`.

The DB-only functions `applyApprovedTradingPaperEntrySessionControl`,
`readVerifiedTradingPaperEntrySession` and
`assessTradingPaperEntrySessionInTransaction` provide:

- **no row = no trading session approval** (default deny);
- Start only after a fresh, owner-scoped claimed
  `paper_session_control` approval effect with a finite 5–240 minute
  duration and current D2/PAPER worker preflight;
- Pause/End as separately confirmed effects incrementing a monotonically
  increasing revision and invalidating old *session* revision tokens;
- expiry derived from the trusted PostgreSQL clock, not client time;
- a SHA-256 integrity-bound session row, exact owner/effect provenance,
  a strictly checked state/approval-result pair, serializable transactions
  and ledger-row locking for concurrent commands;
- no new entry authority from a stale revision, expired session or a
  changed/disabled D2 worker gate.

**Not yet integrated:** `paper_session_control` is NOT registered as a
user-exposed tool, there is no scheduling or auto-start, and the existing
PAPER reserve/fill/recurrence transactions do NOT YET consume the H1
session revision. Therefore H1a alone must not be advertised as a
functional Start/Pause control or as protection for an already-running
legacy Worker. Full H1b/H2 still needs the session proof enforced in
the *same transaction* as B7/G2 reserve, F2/G4 fill, and D11/D12
successor enqueue/intent, plus no-exposure protection-only handling
and normal audited releases.

The first PostgreSQL test covers owner isolation, default denial,
approved Start/Pause/End, stale approvals/revisions, and absence of
new PAPER ledger or outbox events. Separate real restart/transaction
race tests remain required before a deployment.


## H1b — session revision propagated to PAPER worker and synthetic money boundaries

New **opt-in session-aware** worker wakes carry `sessionRevision`. The
optional field is validated by the existing typed job parser and retained
by the one-shot and recurring job constructors. Session-aware preflights
deny paused/expired/revised sessions; the D11 successor-intent transaction
also denies any wake that would be scheduled on/after the session expiry.

Both existing synthetic virtual money paths now pass the same revision:
legacy worker F1/F3 and generic G2/G4 resolved-research reserve/fill.
Before creating a *new* reserve or fill, the existing serializable B7/C1
transactions lock the owner-scoped PAPER ledger row (the **same lock**
taken by H1a Start/Pause/End) and verify the session revision against a
trusted DB clock, current D2 permission and approval provenance.
Transactions serialise with explicit Pause/End. A duplicate historical
fill may still be read idempotently; it does NOT create a new fill.

When a `TradingPaperEntrySession` record exists, any legacy automatic
writer call without a session revision is now **denied** rather than
bypassing a Pause. Previously existing deployments with no session row
retain a legacy compatibility path: this is *not* safe automatic
session-only mode until legacy standalone recurring starts are explicitly
removed/disabled and the user-facing session Start path is wired.

Remaining:
- prohibit every legacy entry without an active finite session when
  switching to on-demand-only production, with migrations for existing
  worker tests/deployments;
- register an explicit authenticated Start/Pause/End control surface
  and ensure only verified user action creates the job;
- add full transactional race test Pause vs concurrent G2 reserve/G4 fill,
  and expiry at the final ledger append;
- give open positions separate protection-only authority, implement
  audited normal-stop reservation release and safe status reconciliation.

No automatic worker or private/live exchange order has been enabled.


## H2a — audited normal PAPER reserve release (2026-10-09)

H2a adds `settleVerifiedTradingPaperSessionReservations`, a **DB-only**
internal idempotent operation after an *owner-approved* Pause/End or an
already-approved finite Start that has expired. It takes the existing
risk-policy and ledger row locks used by B7/C1 and H1 Start/Pause/End,
verifies owner identity, session effect provenance and PostgreSQL time,
then releases **only unfilled PAPER reservations**. The existing hash-chain,
inert outbox and `trading_paper_release_audits` are reused with a distinct
`session_end` reason; historical `expired` and `kill_switch`
semantics, provenance digests and rows remain unchanged. Repeated calls
release zero reservations, not duplicate events. An active or absent
session CANNOT authorize normal-stop releases.

An integration test with a genuine synthetic reserve exercises:
active Start -> reserve -> denied early settle -> owner-approved Pause ->
exactly one audited release -> idempotent retry -> no remaining reserve
and no open position; a cross-owner call is rejected.

**H2a is not a complete session-stop feature**. Existing open positions
are NEVER closed here; a separate audited protection-only supervisor
with an independent schedule and authority is still needed. Currently
the risk/stop monitoring path is coupled to D2 worker preflight.
Neither source-of-truth verification of remote live exchange orders nor
any live exchange order exists in PAPER v1. A successful reservation
settlement does NOT justify showing "completely stopped" while positions,
unsettled worker operations or uncertain queue state exist.

**Migration/cutover boundary:** H2a currently releases every outstanding
virtual reservation from its owned PAPER ledger, even one placed manually
through the legacy internal B7 path. Do not activate session-end release
on a ledger that mixes automatic and unrelated manual holds. Before
enabling it for end users, enforce a dedicated session-owned ledger or
record and validate per-reservation `sessionRevision` provenance and
reconcile only those session-linked reservations. Add cross-mode tests.
Until then, H2a stays an unexposed internal implementation.

H2a does not register UI controls, enable workers, schedule jobs, merge
the PR or deploy anything.


## H2b-0 — independent finite, explicitly approved protective-only authorization

A separate `TradingPaperProtectionLease` and SQL migration now exist
alongside the original H1 entry session, NOT in its place. The owner must
explicitly approve a `paper_protection_control` `start` effect (5–1440
minutes, 5–60-minute cadence). The lease is persisted on the existing PAPER
ledger and bound to owner, approved ExternalEffect and worker-gate revision;
no row = no authority. The underlying PAPER risk policy and D2 approval
must remain enabled and unchanged. Lease expiry/revocation fails closed.
`end` is rejected while any PAPER position remains open. A new entry
session Start is denied while a protective lease is enabled, preventing
accidental conversion back into entry mode during supervision.

Protection Start checks the entry session is already Paused/Ended/Expired,
audits the PAPER ledger, checks that every open position has a verified stop
guard and was opened through exactly one historical F3 or G4 fill authority.
No manual position is ever described as automatically protected. A zero
position ledger needs no automatic stop supervision and cannot create a
protection-only lease.

`handlePaperProtectionOnlyWake` is a new **unregistered** adapter that
requires the separate verified lease and passes a constrained payload to
the EXISTING F4/G5 → C2 synthetic stop-only implementation. It rechecks
the protection lease before each existing D2 protective wake preflight,
including after public quote capture. No Market/Resolver research,
new signal, reserve, buy, entry successor, exchange order or recurring
enqueue path exists in this adapter. Only one verified position can be
virtually closed per wake, inherited from F4/G5.

**Remaining safety blockers / not yet delivered:**
- H2b-0 is not registered with the background-job dispatcher. There is no
  independently approved, durable PROTECTION-ONLY recurrence and no
  verified post-close queue/inflight reconciliation. Thus it is not yet
  unattended protective supervision, and it is unsafe to tell the user
  positions will remain automatically protected after entry expiry.
- A separate protection timer expires unless the user reapproves. A
  production UI must prominently warn and require manual action or a
  verified renewal for still-open positions before this deadline.
- Protection-only expiry/revocation while a quote/close is in-flight must
  be revalidated at the actual C2 transaction boundary before deployment.
- H2a's entire-ledger reserve-release scope must be narrowed to current
  session-owned reservations (or use a dedicated managed ledger).
- There is still no end-user Start/Pause/End/Protection UI, no full
  automatic-entry cutover, and no private/live broker order path.

H2b-0 cannot enable a worker or dispatch a recurring task on its own;
all existing code remains in the draft PR.


## H2b-1 — same-transaction protection fencing at C2

H2b-0's separately approved protection-only lease is now reverified
**inside** the existing C2 synthetic `fill_sell` serializable money
transaction. The C2 writer takes the same owner-scoped ledger-row
`FOR UPDATE` lock as protection Start/End, checks the current finite
lease revision, Worker D2 approval, inactive entry-session status and DB
clock, and only then is a *new* virtual protective close allowed. An
old tokenless D2 stop caller cannot bypass the separately enabled
protection-only lease. The old C2 route without any protection lease
remains compatible for historical tests, as before.

The H2b adapter supplies the exact approved `leaseRevision` and D2
`gateRevision` via its injected stop-only C2 callback. Existing
F4/G5 provenance, market validation, one-position-per-wake limitation,
ledger/audit and idempotent `duplicate` recovery all remain unchanged.

A separately approved protection lease **does not** create a recurring
job. Durable, owner-scoped protection-only job intent, restart recovery,
expiry escalation, and a positive PostgreSQL F3/G4 live-position test
remain unimplemented. Do not portray H2b as automatically monitoring
positions after session expiry until those pieces are in place.


## H2b2 — independently queued, finite protection-only successor (2026-10-10)

Introduces a distinct typed `paper.protection-check` job with a
separate `replaceKey`, `leaseRevision`, D2 gate revision, exact
owner scope, fixed 3-attempt maximum and strict job parser.
`createBackgroundJobHandlers` now routes only this job to the
existing H2b stop-only adapter (F4/G5 -> C2), then attempts to
persist and enqueue a successor. It does **not** call research,
new-signal generation, quote reserve, virtual buy, entry worker,
Market Skill execution or an exchange order API.

H2b2 records immutable, hashed
`TradingPaperProtectionSuccessorIntent` rows with a unique key
(ledger, lease revision, original scheduled time). Its transactional
planner rechecks the independently owner-approved protection lease,
trusted DB time, paused/ended/expired H1 entry lease, D2 authority,
and verified open PAPER positions. No position, revoked authority or
next tick on/after lease expiry -> stop. Replay uses the
**same persisted successor time**, never a newly calculated one.
The job publisher runs only after committing the immutable intent;
a queue failure propagates so the parent job may retry. A queued stale
wake remains fail-closed at H2b and C2.

**Remaining before safe unattended operation:** the very FIRST
`paper.protection-check` job must be scheduled only from an
authenticated, explicitly owner-approved protection Start. An
independent restart reconciler must identify persisted intents
whose corresponding durable queue job is missing and re-enqueue
only after fresh lease/position verification. Graceful expiry must
produce a visible user escalation when positions remain open
(protection is NOT guaranteed after expiry). Test actual restart,
late queue delivery, mid-close lease revocation and concurrently
running wakes. These are not implemented by adding a dispatcher.
H2a mixed manual hold attribution and strict legacy auto-entry
cutover also remain blockers. All code is still in draft PR #38;
nothing has been activated or deployed.
