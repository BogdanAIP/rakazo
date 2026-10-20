# PAPER-only graceful shutdown — staged, NOT deployed

## Reuse of existing worker cleanup

Node worker already awaits: reconciler.stop(), Graphile jobHost.stop(),
jobs.close(), realtime/connector cleanup, and database disconnect. On Windows,
taskkill /F bypasses this sequence. The staged controller uses an authenticated
local file request/ack protocol instead. No virtual fills or exchange orders.

## Controlled activation

At a FUTURE approved deployment, set RAKAZO_PAPER_STOP_DIR in the local
paper-runtime-config.json env object to the absolute paper runtime directory.
The existing local starter passes this env to its spawned worker. DO NOT
change the active configuration or restart the current SOL protection without
separately agreeing on the interruption.

After startup the worker registers a fresh 256-bit nonce, PID and instance
identifier. Windows verifies the registered process path and creation time.
A one-shot drain request must match all identifiers. The worker waits for
its existing job host to drain and then writes state=drained. The controller
requires that receipt AND the original process to exit before moving on.

On missing capability, timeout or failed job drain: fail closed, NO force kill,
NO claim of successful shutdown, and NO PostgreSQL shutdown. Interrupted
offline intervals remain subject to historical market and funding review.

## Tests

- PAPER worker unit tests: wrong token/PID/instance, delayed job, failure,
  malformed request, repeated request (six tests).
- Paper.GracefulWorker.ProcessQA.ps1: real disposable Windows Node process,
  positive and negative drain paths, owner confirmation (nine checks).
  Pass -WorkerSourceRepo pointing to the isolated worker checkout.
- Paper.Lifecycle.Fixture.ps1: simulated lifecycle and immutable journal
  containing an open position and pending order (14 checks).
- Paper.Lifecycle.ProcessQA.ps1: disposable PID scoping with a simulated worker
  drain and simulated database (16 checks).
- Validate.ps1: static launcher gate.

## Blockers before enabling coordinated Quit

1. External CI and review of both isolated branches.
2. End-to-end drain against actual disposable Graphile/PostgreSQL jobs.
3. Graceful close for PAPER API/gateway; they still use forced termination.
4. A controlled full startup/quit/restart with real auth and offline gap review.
5. Explicit approval before temporarily interrupting the current local SOL
   protective worker. The tray release switch remains FALSE.
