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
