# Native Windows PAPER backup / restore — release hold and disposable QA

**Status: rehearsal only. Do not run against the active PAPER database, reset a worker, or merge a release without an explicit maintenance decision.**

## Architecture confirmed, 21 October 2026

- The active Windows runtime is PAPER-only. A read-only `Paper.Lifecycle.ps1 -Action Probe` showed the existing API, worker, gateway and PostgreSQL all running but `StopEligible=false`: **none of the worker/API/gateway drain capabilities was verified in the active processes**. Do not force-terminate or invoke `Paper.Lifecycle.ps1 -Action Stop`.
- The **PR #85** candidate integrates PAPER trading RPCs, Prisma migrations and gateway in the same source tree. It is *not* the active browser checkout. PAPER journal auto-start remains operator-opt-in; coordinated shutdown remains disabled by default.
- Docker `scripts/backup.sh` / `scripts/restore.sh` are NOT the native Windows procedure; the latter may try to restore into an existing database. Never use either against this local runtime.
- Current live user checkout contains unrelated uncommitted modifications. Preserve the exact checkout, database directory, runtime registry and trading-ledger files without reset, stash or replacement.

## Rehearsal on a separate database (safe)

Run `pwsh -NoProfile -File scripts/windows/manual-rakazo/tests/Paper.NativeBackupRestore.DisposableQA.ps1` **only** in a prepared isolated candidate checkout with installed frozen dependencies and with **no database, PostgreSQL connection, or trading credentials in the process environment**.

This script is QA-only. It refuses external PG settings or trading credentials. It creates a completely new PostgreSQL cluster under a random TEMP path, binds only to 127.0.0.1 port 15549 (which must be free), applies the real candidate Prisma migrations, seeds two explicitly synthetic PAPER_ONLY JSON records, creates a custom-format archive (`pg_dump -Fc --no-owner --no-acl`), verifies its contents via `pg_restore --list`, restores it to a **new database inside the disposable cluster**, checks counts of every public table, Prisma migration history, and seeded evidence digest, then stops only its own isolated PostgreSQL. Archive and logs stay in the temporary evidence folder.

Latest Windows run: exit 0; **109** public tables and **127** migration rows before and after; restored JSON evidence identical. The disposable 15549 listener closed. This is proof of the backup/restore *mechanism* only. It is not a backup of live position data or confirmation of historical funding/stop execution.

## Operator-approved production checklist (NOT executed)

1. **Determine exact source identities.** Read the active PAPER runtime registry *locally*, including its PostgreSQL **port, data directory, worker PID/start time, journal files and repo commit**, with secret values redacted. Do not infer that the primary Rakazo DB is the PAPER DB. Verify the port listener and process match the registry and make sure no duplicate worker is executing jobs.
2. **Freeze a change boundary.** Record the PAPER-only state, open positions, protective-stop intents, pending orders, unverified funding, journal high-water marks, and exact candidate/rollback commits. Disallow new entries under a separately reviewed operator mechanism; a green /health is not proof that trading is paused.
3. **Resolve the drain gate.** The current release reports `StopEligible=false`. Do not interrupt it. A future deployment must show correct, service-specific, identity-bound `drained` receipts for worker, gateway and API and no outstanding jobs before stopping PostgreSQL. Missing/expired receipts => abort release, no force kill.
4. **Create a synchronized, protected snapshot.** Once a safe freeze is established and the owner has authorized a maintenance window, use the exact PAPER database registration and native `pg_dump -Fc` to a private restricted directory. Also snapshot the external runtime journals, configurations, lifecycle markers and immutable source commits separately, respecting any stored secrets. Hash each artifact and record acquisition times. PostgreSQL archives alone **do not** cover files outside its data schema.
5. **Prove rollback before upgrading.** Restore the database archive into a new, isolated PostgreSQL cluster/database, verify full schema/migrations and PAPER ledger totals; independently verify the external files and hash manifest. Do not restore directly over a running database. Keep the previous executable, DB snapshot and runtime root intact.
6. **Deploy only with explicit approval.** One controller must own each process. Verify all service identities, TCP loopback bindings, grants, journal access, protection and journal integrity. Keep automatic entries disabled until all relevant offline funding, stop and fill gaps are reconciled against source evidence.
7. **Fail closed and rollback on any mismatch.** If the new worker cannot drain, receipts mismatch, migrations fail, ledger hash differs or a stop is unverified, do not manufacture synthetic executions. Record an offline review interval, preserve both snapshots, and obtain operator authorization for a verified rollback. Never default to `taskkill /F` for the PAPER worker.

**Non-negotiable:** no live deployment, new orders, protective-stop edits, account transfers, force shutdown, destructive migration or overwrite of the current data directory is authorized by a passing CI or by this rehearsal. Only an owner-approved maintenance workflow may cross that boundary.
